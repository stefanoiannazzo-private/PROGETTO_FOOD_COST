<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Graph;
use App\Domain\Costing\Serializer;
use App\Http\Controllers\Controller;
use App\Http\Requests\Schemas;
use App\Services\Audit;
use App\Services\Codes;
use App\Services\Costing;
use App\Services\Presentation;
use App\Services\Recipes;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Row;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Ricette (port di apps/api/src/routes/recipes.ts). */
final class RecipeController extends Controller
{
    /* ------------------------------ elenco ------------------------------ */
    public function index(Request $req)
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $q = $this->parseQuery($req, Schemas::listQuery([
            'status' => S::enum(['draft', 'active', 'archived', 'all'])->default('all'),
            'completeness' => S::enum(['all', 'complete', 'incomplete'])->default('all'),
        ]));
        $cid = $ctx->companyId();
        $showCosts = $ctx->can('costs.read');
        $t = Clock::today();
        if ($showCosts && $q['completeness'] !== 'all') {
            // il filtro per completezza richiede la valorizzazione di tutte le ricette (una sola elaborazione, poi in cache)
            $all = DB::table('recipes')->where('company_id', $cid)->whereNotNull('current_revision_id')->pluck('id')->all();
            Costing::currentValuations($cid, $all, $t);
        }
        $query = DB::table('recipes as r')
            ->leftJoin('recipe_revisions as v', 'v.id', '=', 'r.current_revision_id')
            ->leftJoin('recipe_cost_cache as k', fn ($j) => $j->on('k.recipe_id', '=', 'r.id')->where('k.valuation_date', '=', $t))
            ->where('r.company_id', $cid);
        if ($q['status'] === 'all') {
            $query->where('r.status', '<>', 'archived');
        } else {
            $query->where('r.status', $q['status']);
        }
        if (! empty($q['category'])) {
            $query->where('r.category', $q['category']);
        }
        if (! empty($q['q'])) {
            $pat = Row::like($q['q']);
            $query->where(fn ($w) => $w->whereRaw(Row::likeSql('r.title'), [$pat])->orWhereRaw(Row::likeSql('r.code'), [$pat]));
        }
        if ($showCosts && $q['completeness'] === 'complete') {
            $query->where('k.complete', 1);
        }
        if ($showCosts && $q['completeness'] === 'incomplete') {
            $query->where('k.complete', 0);
        }
        $sorts = ['title' => 'r.title', 'code' => 'r.code', 'category' => 'r.category', 'updated' => 'r.updated_at', 'total' => 'k.total', 'perKg' => 'k.cost_per_kg'];
        $sortKey = $q['sort'] ?? 'title';
        $sortCol = ! $showCosts && ($sortKey === 'total' || $sortKey === 'perKg') ? 'r.title' : ($sorts[$sortKey] ?? 'r.title');
        $total = (clone $query)->count();
        $dir = $q['dir'] === 'desc' ? 'desc' : 'asc';
        $rows = $query->orderByRaw("{$sortCol} IS NULL")->orderBy($sortCol, $dir)->orderBy('r.id')
            ->limit($q['pageSize'])->offset(($q['page'] - 1) * $q['pageSize'])
            ->get(['r.id', 'r.code', 'r.title', 'r.category', 'r.status', 'r.updated_at', 'v.number as revision_number', 'v.final_weight_kg', 'v.portions', 'v.final_quantity', 'v.final_unit']);
        $valuations = $showCosts ? Costing::currentValuations($cid, $rows->pluck('id')->all(), $t) : [];

        return [
            'data' => $rows->map(function ($r) use ($valuations) {
                $v = $valuations[$r->id] ?? null;

                return [
                    'id' => $r->id,
                    'code' => $r->code,
                    'title' => $r->title,
                    'category' => $r->category,
                    'status' => $r->status,
                    'updatedAt' => Clock::iso($r->updated_at),
                    'revisionNumber' => $r->revision_number,
                    'finalWeightKg' => $r->final_weight_kg,
                    'portions' => $r->portions,
                    'finalQuantity' => $r->final_quantity,
                    'finalUnit' => $r->final_unit,
                    'cost' => $v ? [
                        'complete' => $v['complete'],
                        'total' => $v['total'],
                        'costPerKg' => $v['costPerKg'],
                        'costPerPortion' => $v['costPerPortion'],
                        'errors' => count(array_filter($v['issues'], fn ($i) => $i['severity'] === 'error')),
                        'warnings' => count(array_filter($v['issues'], fn ($i) => $i['severity'] === 'warning')),
                    ] : null,
                ];
            })->all(),
            'meta' => ['page' => $q['page'], 'pageSize' => $q['pageSize'], 'total' => $rows->isEmpty() ? 0 : $total, 'date' => $t, 'costsVisible' => $showCosts],
        ];
    }

    public function categories(Request $req)
    {
        $ctx = $this->requireCompany($req, 'recipes.read');

        return ['data' => DB::table('recipes')->where('company_id', $ctx->companyId())->whereNotNull('category')->distinct()->orderBy('category')->pluck('category')->all()];
    }

    /** Ricette selezionabili come semilavorato (esclude se stessa e le ricette che già la contengono). */
    public function options(Request $req)
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $q = $this->parseQuery($req, S::object(['q' => S::string()->trim()->max(100)->optional(), 'exclude' => S::uuid()->optional()]));
        $cid = $ctx->companyId();
        $excluded = [];
        if (! empty($q['exclude'])) {
            $excluded = array_flip(Graph::dependentsOf(Costing::loadEdges($cid), [$q['exclude']]));
            $excluded[$q['exclude']] = true;
        }
        $query = DB::table('recipes as r')->leftJoin('recipe_revisions as v', 'v.id', '=', 'r.current_revision_id')
            ->where('r.company_id', $cid)->where('r.status', '<>', 'archived');
        if (! empty($q['q'])) {
            $pat = Row::like($q['q']);
            $query->where(fn ($w) => $w->whereRaw(Row::likeSql('r.title'), [$pat])->orWhereRaw(Row::likeSql('r.code'), [$pat]));
        }
        $rows = $query->orderBy('r.title')->limit(50)->get(['r.id', 'r.code', 'r.title', 'r.status', 'v.final_unit', 'v.final_quantity', 'v.final_weight_kg']);

        return ['data' => $rows->filter(fn ($r) => ! isset($excluded[$r->id]))->map(fn ($r) => [
            'id' => $r->id, 'code' => $r->code, 'title' => $r->title, 'status' => $r->status,
            'finalUnit' => $r->final_unit, 'finalQuantity' => $r->final_quantity, 'finalWeightKg' => $r->final_weight_kg,
        ])->values()->all()];
    }

    /* ----------------------------- dettaglio ----------------------------- */
    public function show(Request $req, string $id)
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $id = $this->uuid($id);
        $q = $this->parseQuery($req, Schemas::dateQuery());
        $cid = $ctx->companyId();
        $r = DB::table('recipes')->where('id', $id)->where('company_id', $cid)->first();
        if (! $r) {
            throw AppError::notFound('Ricetta');
        }
        $t = Clock::today();
        $date = $q['date'] ?? $t;
        $form = $r->current_revision_id ? Recipes::loadRevisionForm($cid, $r->current_revision_id) : null;
        $valuation = null;
        $comparison = null;
        $snapshots = [];
        if ($ctx->can('costs.read') && $r->current_revision_id) {
            $valuation = $date === $t
                ? (Costing::currentValuations($cid, [$id], $t)[$id] ?? null)
                : Serializer::serialize(Costing::computeValuation($cid, $id, $date));
            $snaps = DB::table('cost_snapshots as s')
                ->leftJoin('users as u', 'u.id', '=', 's.created_by')
                ->leftJoin('recipe_revisions as v', 'v.id', '=', 's.revision_id')
                ->where('s.recipe_id', $id)->where('s.company_id', $cid)
                ->orderByDesc('s.created_at')->limit(20)
                ->get(['s.id', 's.created_at', 's.valuation_date', 's.label', 's.total', 's.cost_per_kg', 's.cost_per_portion', 's.complete', 'u.name as created_by', 'v.number as revision_number']);
            $snapshots = Row::all($snaps, ['complete']);
            if ($snaps->isNotEmpty() && $valuation) {
                $full = DB::table('cost_snapshots')->where('id', $snaps[0]->id)->first(['id', 'created_at', 'valuation_date', 'label', 'data']);
                $comparison = Presentation::compare($valuation, $full, $ctx->can('salaries.read'));
            }
        }
        $usedBy = DB::table('recipes as p')->join('recipe_components as c', 'c.revision_id', '=', 'p.current_revision_id')
            ->where('p.company_id', $cid)->where('c.sub_recipe_id', $id)->distinct()->orderBy('p.title')
            ->get(['p.id', 'p.code', 'p.title', 'p.status']);

        return [
            'id' => $r->id,
            'code' => $r->code,
            'title' => $r->title,
            'category' => $r->category,
            'description' => $r->description,
            'status' => $r->status,
            'lockVersion' => (int) $r->lock_version,
            'createdAt' => Clock::iso($r->created_at),
            'updatedAt' => Clock::iso($r->updated_at),
            'duplicatedFromId' => $r->duplicated_from_id,
            'revision' => $form,
            'valuation' => Presentation::redactCost($valuation, $ctx),
            'valuationDate' => $date,
            'comparison' => $ctx->can('costs.read') ? $comparison : null,
            'snapshots' => $snapshots,
            'usedBy' => Row::all($usedBy),
            // NUOVO: semilavorati con il loro tempo di preparazione (avviso «da preparare prima»)
            'subrecipeLeadTimes' => self::leadTimes($cid, $form),
            // NUOVO: prezzo in menu (IVA inclusa) solo per l'amministratore, come la pagina Redditività;
            // per gli altri ruoli i campi non esistono proprio nella risposta
            ...($ctx->role === 'admin' ? ['menuPrice' => (function () use ($r) {
                $p = DB::table('recipe_prices')->where('recipe_id', $r->id)->first(['menu_price', 'vat_percent']);

                return $p ? ['menuPrice' => $p->menu_price, 'vatPercent' => $p->vat_percent] : null;
            })()] : []),
            'permissions' => [
                ...($ctx->role === 'admin' ? ['canSetMenuPrice' => true] : []),
                'canEdit' => $ctx->can('recipes.manage'),
                'costsVisible' => $ctx->can('costs.read'),
                'salariesVisible' => $ctx->can('salaries.read'),
                'canSnapshot' => $ctx->can('snapshots.create'),
            ],
        ];
    }

    /** @return list<array{recipeId: string, title: string, minutes: string, waitingMinutes: string}> */
    private static function leadTimes(string $cid, ?array $form): array
    {
        $ids = array_values(array_unique(array_filter(array_map(fn ($c) => $c['kind'] === 'recipe' ? $c['recipeId'] : null, $form['components'] ?? []))));
        if (! $ids) {
            return [];
        }
        $rows = DB::table('recipes as r')->join('recipe_revisions as v', 'v.id', '=', 'r.current_revision_id')
            ->where('r.company_id', $cid)->whereIn('r.id', $ids)->whereNotNull('v.declared_duration_minutes')
            ->get(['r.id', 'r.title', 'v.id as rev', 'v.declared_duration_minutes']);
        $waiting = DB::table('recipe_phases')->whereIn('revision_id', $rows->pluck('rev')->all())->where('is_waiting', true)
            ->groupBy('revision_id')->selectRaw('revision_id, SUM(duration_minutes) as w')->pluck('w', 'revision_id');

        return $rows->map(fn ($x) => ['recipeId' => $x->id, 'title' => $x->title, 'minutes' => $x->declared_duration_minutes, 'waitingMinutes' => (string) ($waiting[$x->rev] ?? '0')])->values()->all();
    }

    /* ------------------------ anteprima dall'editor ------------------------ */
    public function preview(Request $req)
    {
        $ctx = $this->requireCompany($req, 'recipes.manage', 'costs.read');
        $body = $this->parseBody($req, S::object([
            'recipeId' => S::uuid()->nullable()->optional(),
            'title' => S::string()->max(160)->default('Nuova ricetta'),
            'revision' => Recipes::revisionBody(),
            'date' => S::isoDate()->optional(),
        ]));
        $cid = $ctx->companyId();
        if (! empty($body['recipeId'])) {
            if (! DB::table('recipes')->where('id', $body['recipeId'])->where('company_id', $cid)->exists()) {
                throw AppError::notFound('Ricetta');
            }
        }
        $id = $body['recipeId'] ?? '00000000-0000-0000-0000-000000000000';
        $draft = Recipes::draftToInput($id, $body['title'] !== '' ? $body['title'] : 'Nuova ricetta', 'BOZZA', $body['revision']);
        $result = Costing::computeValuation($cid, $id, $body['date'] ?? Clock::today(), $draft);

        return response()->json(Presentation::redactCost(Serializer::serialize($result), $ctx));
    }

    /* --------------------------- creazione/modifica --------------------------- */
    public function store(Request $req)
    {
        $ctx = $this->requireCompany($req, 'recipes.manage');
        $body = $this->parseBody($req, Recipes::recipeHeader()->extend(['revision' => Recipes::revisionBody()]));
        $cid = $ctx->companyId();
        Recipes::validateRevision($cid, null, $body['revision']);

        return DB::transaction(function () use ($ctx, $body, $cid) {
            $code = $body['code'] ?? Codes::next('recipes', $cid, 'RIC');
            if (DB::table('recipes')->where('company_id', $cid)->where('code', $code)->exists()) {
                throw AppError::conflict('duplicate_code', "Il codice {$code} è già in uso.", ['fields' => ['code' => 'Codice già in uso.']]);
            }
            $id = (string) Str::uuid();
            DB::table('recipes')->insert([
                'id' => $id, 'company_id' => $cid, 'code' => $code, 'title' => $body['title'],
                'category' => $body['category'] ?? null, 'description' => $body['description'] ?? null, 'status' => $body['status'],
                'created_at' => Clock::now(), 'updated_at' => Clock::now(),
            ]);
            $rev = Recipes::insertRevision($cid, $ctx->userId(), $id, $body['revision']);
            Audit::log($cid, $ctx->userId(), 'recipe', $id, 'created', ['code' => $code, 'title' => $body['title'], 'revision' => $rev['number']]);

            return ['id' => $id, 'code' => $code, 'revisionId' => $rev['id'], 'revisionNumber' => $rev['number']];
        });
    }

    /** Salvataggio: crea una nuova revisione immutabile (concorrenza ottimistica su lockVersion). */
    public function update(Request $req, string $id)
    {
        $ctx = $this->requireCompany($req, 'recipes.manage');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, Recipes::recipeHeader()->extend([
            'code' => S::string()->trim()->min(1)->max(40),
            'status' => S::enum(['draft', 'active'])->optional(),
            'lockVersion' => S::int(),
            'revision' => Recipes::revisionBody(),
        ]));
        $cid = $ctx->companyId();
        Recipes::validateRevision($cid, $id, $body['revision']);
        $res = DB::transaction(function () use ($ctx, $body, $cid, $id) {
            $cur = DB::table('recipes')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first();
            if (! $cur) {
                throw AppError::notFound('Ricetta');
            }
            if ((int) $cur->lock_version !== $body['lockVersion']) {
                throw AppError::conflict('stale', 'La ricetta è stata salvata da un altro utente nel frattempo. Le tue modifiche non sono andate perse: ricarica la versione aggiornata per confrontarle.');
            }
            if (DB::table('recipes')->where('company_id', $cid)->where('code', $body['code'])->where('id', '<>', $id)->exists()) {
                throw AppError::conflict('duplicate_code', "Il codice {$body['code']} è già in uso.", ['fields' => ['code' => 'Codice già in uso.']]);
            }
            // ricontrollo dei cicli dentro la transazione, con il grafo aggiornato
            Recipes::validateRevision($cid, $id, $body['revision']);
            DB::table('recipes')->where('id', $id)->update([
                'code' => $body['code'],
                'title' => $body['title'],
                'category' => $body['category'] ?? null,
                'description' => $body['description'] ?? null,
                'status' => $cur->status === 'archived' ? 'archived' : ($body['status'] ?? $cur->status),
                'lock_version' => $cur->lock_version + 1,
                'updated_at' => Clock::now(),
            ]);
            $rev = Recipes::insertRevision($cid, $ctx->userId(), $id, $body['revision']);
            Audit::log($cid, $ctx->userId(), 'recipe', $id, 'revised', ['revision' => $rev['number'], 'title' => $body['title']]);

            return ['id' => $id, 'revisionId' => $rev['id'], 'revisionNumber' => $rev['number'], 'lockVersion' => $cur->lock_version + 1];
        });
        $affected = Costing::invalidate($cid, 'recipes', [$id]);

        return [...$res, 'affectedRecipes' => Costing::describeRecipes($cid, array_values(array_filter($affected, fn ($x) => $x !== $id)))];
    }

    /** Duplicazione: nuova identità, revisione copiata, nessuno snapshot copiato. */
    public function duplicate(Request $req, string $id)
    {
        $ctx = $this->requireCompany($req, 'recipes.manage');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();
        $src = DB::table('recipes')->where('id', $id)->where('company_id', $cid)->first();
        if (! $src) {
            throw AppError::notFound('Ricetta');
        }
        $form = $src->current_revision_id ? Recipes::loadRevisionForm($cid, $src->current_revision_id) : null;

        return DB::transaction(function () use ($ctx, $cid, $src, $form) {
            $code = Codes::next('recipes', $cid, 'RIC');
            $newId = (string) Str::uuid();
            DB::table('recipes')->insert([
                'id' => $newId, 'company_id' => $cid, 'code' => $code, 'title' => mb_substr("Copia di {$src->title}", 0, 160),
                'category' => $src->category, 'description' => $src->description, 'status' => 'draft', 'duplicated_from_id' => $src->id,
                'created_at' => Clock::now(), 'updated_at' => Clock::now(),
            ]);
            if ($form) {
                Recipes::insertRevision($cid, $ctx->userId(), $newId, Recipes::formToBody($form));
            }
            Audit::log($cid, $ctx->userId(), 'recipe', $newId, 'duplicated', ['from' => $src->code]);

            return ['id' => $newId, 'code' => $code];
        });
    }

    public function archive(Request $req, string $id)
    {
        return $this->setStatus($req, $id, 'archive', 'archived');
    }

    public function restore(Request $req, string $id)
    {
        return $this->setStatus($req, $id, 'restore', 'draft');
    }

    public function activate(Request $req, string $id)
    {
        return $this->setStatus($req, $id, 'activate', 'active');
    }

    /** NUOVO — riporta in bozza una ricetta attiva (dal selettore di stato nella scheda). */
    public function toDraft(Request $req, string $id)
    {
        return $this->setStatus($req, $id, 'to_draft', 'draft');
    }

    private function setStatus(Request $req, string $id, string $action, string $status)
    {
        $ctx = $this->requireCompany($req, 'recipes.manage');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();
        $n = DB::table('recipes')->where('id', $id)->where('company_id', $cid)
            ->update(['status' => $status, 'updated_at' => Clock::now(), 'lock_version' => DB::raw('lock_version + 1')]);
        if (! $n) {
            throw AppError::notFound('Ricetta');
        }
        Audit::log($cid, $ctx->userId(), 'recipe', $id, $action);
        // L'archiviazione non cancella nulla: le ricette che la usano continuano a valorizzarla.
        $parents = $action === 'archive' ? Costing::describeRecipes($cid, Graph::dependentsOf(Costing::loadEdges($cid), [$id])) : [];

        return ['ok' => true, 'usedBy' => $parents];
    }

    /* ------------------------- valorizzazioni e storico ------------------------- */
    public function valuation(Request $req, string $id)
    {
        $ctx = $this->requireCompany($req, 'recipes.read', 'costs.read');
        $id = $this->uuid($id);
        $q = $this->parseQuery($req, Schemas::dateQuery());
        $cid = $ctx->companyId();
        $r = DB::table('recipes')->where('id', $id)->where('company_id', $cid)->first(['id', 'current_revision_id']);
        if (! $r?->current_revision_id) {
            throw AppError::notFound('Ricetta');
        }
        $date = $q['date'] ?? Clock::today();
        $v = $date === Clock::today()
            ? Costing::currentValuations($cid, [$id], $date)[$id]
            : Serializer::serialize(Costing::computeValuation($cid, $id, $date));

        return response()->json(Presentation::redactCost($v, $ctx));
    }

    public function revisions(Request $req, string $id)
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $id = $this->uuid($id);
        $rows = DB::table('recipe_revisions as v')->leftJoin('users as u', 'u.id', '=', 'v.created_by')
            ->where('v.recipe_id', $id)->where('v.company_id', $ctx->companyId())->orderByDesc('v.number')
            ->get(['v.id', 'v.number', 'v.created_at', 'u.name as created_by']);

        return ['data' => Row::all($rows)];
    }

    public function revision(Request $req, string $id, string $revisionId)
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        [$id, $revisionId] = $this->uuids(['id' => $id, 'revisionId' => $revisionId]);
        $exists = DB::table('recipe_revisions')->where('id', $revisionId)->where('recipe_id', $id)->where('company_id', $ctx->companyId())->exists();
        if (! $exists) {
            throw AppError::notFound('Revisione');
        }

        return Recipes::loadRevisionForm($ctx->companyId(), $revisionId);
    }

    /**
     * Snapshot di costo: fotografia immutabile e autosufficiente (comprese le sottoricette annidate).
     * Calcolata dentro una transazione REPEATABLE READ con lock sulla ricetta e verifica della revisione attesa.
     */
    public function snapshot(Request $req, string $id)
    {
        $ctx = $this->requireCompany($req, 'snapshots.create');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, S::object([
            'label' => S::string()->trim()->max(120)->optional(),
            'expectedRevisionId' => S::uuid(),
            'date' => S::isoDate()->optional(),
        ]));
        $cid = $ctx->companyId();
        $date = $body['date'] ?? Clock::today();
        if (DB::transactionLevel() === 0) {
            DB::statement('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        }

        return DB::transaction(function () use ($ctx, $body, $cid, $id, $date) {
            $r = DB::table('recipes')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first(['id', 'current_revision_id', 'title']);
            if (! $r) {
                throw AppError::notFound('Ricetta');
            }
            if ($r->current_revision_id !== $body['expectedRevisionId']) {
                throw AppError::conflict('stale', 'La ricetta è cambiata dopo che hai aperto la scheda: ricarica prima di salvare lo snapshot.');
            }
            $result = Serializer::serialize(Costing::computeValuation($cid, $id, $date));
            $sid = (string) Str::uuid();
            $now = Clock::now();
            DB::table('cost_snapshots')->insert([
                'id' => $sid,
                'company_id' => $cid,
                'recipe_id' => $id,
                'revision_id' => $r->current_revision_id,
                'valuation_date' => $date,
                'label' => ($body['label'] ?? '') !== '' ? $body['label'] : null,
                'complete' => $result['complete'],
                'total' => Costing::fit($result['total']),
                'cost_per_kg' => Costing::fit($result['costPerKg']),
                'cost_per_portion' => Costing::fit($result['costPerPortion']),
                'data' => json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                'created_by' => $ctx->userId(),
                'created_at' => $now,
            ]);
            Audit::log($cid, $ctx->userId(), 'cost_snapshot', $sid, 'created', ['recipe' => $r->title, 'total' => $result['total'], 'complete' => $result['complete']]);

            return ['id' => $sid, 'created_at' => Clock::iso($now), 'complete' => $result['complete'], 'total' => $result['total']];
        });
    }

    public function showSnapshot(Request $req, string $id)
    {
        $ctx = $this->requireCompany($req, 'costs.read');
        $id = $this->uuid($id);
        $s = DB::table('cost_snapshots as s')
            ->leftJoin('users as u', 'u.id', '=', 's.created_by')
            ->leftJoin('recipe_revisions as v', 'v.id', '=', 's.revision_id')
            ->where('s.id', $id)->where('s.company_id', $ctx->companyId())
            ->first(['s.id', 's.recipe_id', 's.revision_id', 's.valuation_date', 's.label', 's.complete', 's.total', 's.data', 's.created_at', 'u.name as created_by', 'v.number as revision_number']);
        if (! $s) {
            throw AppError::notFound('Snapshot');
        }
        $row = Row::one($s, ['complete'], ['data']);
        $row['data'] = Presentation::redactCost($row['data'], $ctx);

        return $row;
    }

    /** Eliminazione definitiva di una ricetta mai usata altrove e senza snapshot. */
    public function destroy(Request $req, string $id)
    {
        $ctx = $this->requireCompany($req, 'recipes.manage');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();

        return DB::transaction(function () use ($ctx, $cid, $id) {
            $r = DB::table('recipes')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first(['id', 'code', 'status']);
            if (! $r) {
                throw AppError::notFound('Ricetta');
            }
            $used = DB::table('recipe_components')->where('sub_recipe_id', $id)->exists();
            $snap = DB::table('cost_snapshots')->where('recipe_id', $id)->exists();
            if ($used || $snap) {
                throw AppError::conflict('in_use', 'La ricetta è usata come semilavorato o ha snapshot di costo: archiviala invece di eliminarla.');
            }
            DB::table('recipes')->where('id', $id)->update(['current_revision_id' => null]);
            DB::table('recipes')->where('duplicated_from_id', $id)->update(['duplicated_from_id' => null]);
            DB::table('comparison_group_items')->where('recipe_id', $id)->delete();
            $revs = DB::table('recipe_revisions')->where('recipe_id', $id)->pluck('id')->all();
            if ($revs) {
                foreach (['recipe_equipment_uses', 'recipe_labor', 'recipe_components', 'recipe_phases'] as $t) {
                    DB::table($t)->whereIn('revision_id', $revs)->delete();
                }
            }
            DB::table('recipe_cost_cache')->where('recipe_id', $id)->delete();
            DB::table('recipe_revisions')->where('recipe_id', $id)->delete();
            DB::table('recipes')->where('id', $id)->delete();
            Audit::log($cid, $ctx->userId(), 'recipe', $id, 'deleted', ['code' => $r->code]);

            return ['ok' => true];
        });
    }
}
