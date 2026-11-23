<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Calculators;
use App\Domain\Costing\Dec;
use App\Domain\Costing\Units;
use App\Http\Controllers\Controller;
use App\Http\Requests\Schemas;
use App\Services\Audit;
use App\Services\Codes;
use App\Services\Costing;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Row;
use App\Support\Validation\S;
use App\Support\Validation\Schema;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Ingredienti e storico prezzi (port di apps/api/src/routes/ingredients.ts).
 * NUOVO: ogni prezzo registra il fornitore dell'ingrediente in quel momento e, facoltativamente, l'agente.
 */
final class IngredientController extends Controller
{
    private const SORTS = ['name' => 'i.name', 'code' => 'i.code', 'category' => 'i.category', 'updated' => 'i.updated_at', 'supplier' => 'i.supplier'];

    public static function ingredientBody(): Schema
    {
        return S::object([
            'code' => S::optText(40),
            'name' => S::reqText('Il nome', 160),
            'category' => S::optText(80),
            'supplier' => S::optText(120),
            'notes' => S::optText(2000),
            'purchaseUnit' => S::string()->trim()->min(1)->max(40)->default('confezione'),
            'packageContent' => S::dec(['gt' => 0, 'label' => 'Il contenuto della confezione']),
            'packageUnit' => S::measureUnit(),
            'usageUnit' => S::measureUnit(),
            'edibleYieldPercent' => S::dec(['gt' => 0, 'max' => 100, 'label' => 'La resa edibile'])->default('100'),
            'densityKgPerL' => S::decOpt(['gt' => 0, 'label' => 'La densità']),
            'unitWeightKg' => S::decOpt(['gt' => 0, 'label' => 'Il peso medio unitario']),
        ]);
    }

    public static function priceBody(): Schema
    {
        return S::object([
            'packagePrice' => S::dec(['min' => 0, 'label' => 'Il prezzo']),
            'validFrom' => S::isoDate(),
            'source' => S::optText(120),
            'notes' => S::optText(500),
            // NUOVO: agente commerciale del fornitore (facoltativo)
            'agentName' => S::optText(120),
            'packageContent' => S::decOpt(['gt' => 0, 'label' => 'Il contenuto della confezione'])->optional(),
            'packageUnit' => S::measureUnit()->optional(),
        ]);
    }

    /** Coerenza tra unità di utilizzo, confezione e dati di conversione. */
    public static function checkConversions(array $b): void
    {
        $from = Units::dimensionOf($b['usageUnit']);
        $to = Units::dimensionOf($b['packageUnit']);
        if ($from === $to) {
            return;
        }
        $pair = [$from => true, $to => true];
        if (isset($pair['volume'], $pair['mass']) && empty($b['densityKgPerL'])) {
            throw AppError::badRequest('validation_failed', 'Per usare in ricetta un’unità di volume con una confezione a peso (o viceversa) serve la densità.', ['fields' => ['densityKgPerL' => 'Obbligatoria per questa combinazione di unità.']]);
        }
        if (isset($pair['count']) && empty($b['unitWeightKg'])) {
            throw AppError::badRequest('validation_failed', 'Per passare da pezzi a peso o volume serve il peso medio unitario.', ['fields' => ['unitWeightKg' => 'Obbligatorio per questa combinazione di unità.']]);
        }
        if (isset($pair['count'], $pair['volume']) && empty($b['densityKgPerL'])) {
            throw AppError::badRequest('validation_failed', 'Per passare da pezzi a volume servono peso unitario e densità.', ['fields' => ['densityKgPerL' => 'Obbligatoria per questa combinazione di unità.']]);
        }
    }

    private static function unitPrice(string $price, string $content, string $unit): string
    {
        return Calculators::normalizedPrice(['packagePrice' => Dec::of($price), 'packageContent' => Dec::of($content), 'packageUnit' => $unit])->toFixed();
    }

    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $q = $this->parseQuery($req, Schemas::listQuery([
            'price' => S::enum(['all', 'missing', 'zero'])->default('all'),
            'date' => S::isoDate()->optional(),
        ]));
        $cid = $ctx->companyId();
        $date = $q['date'] ?? Clock::today();
        $showCosts = $ctx->can('costs.read');
        // prezzo valido alla data: sottoquery correlata al posto della LATERAL JOIN
        $latest = '(SELECT p2.id FROM ingredient_prices p2 WHERE p2.ingredient_id = i.id AND p2.valid_from <= ? ORDER BY p2.valid_from DESC LIMIT 1)';
        $query = DB::table('ingredients as i')
            ->leftJoin('ingredient_prices as p', fn ($j) => $j->on('p.ingredient_id', '=', 'i.id')->whereRaw("p.id = {$latest}", [$date]))
            ->where('i.company_id', $cid);
        if ($q['archived'] === '0') {
            $query->whereNull('i.archived_at');
        }
        if ($q['archived'] === '1') {
            $query->whereNotNull('i.archived_at');
        }
        if (! empty($q['category'])) {
            $query->where('i.category', $q['category']);
        }
        if (! empty($q['q'])) {
            $pat = Row::like($q['q']);
            $query->where(fn ($w) => $w->whereRaw(Row::likeSql('i.name'), [$pat])->orWhereRaw(Row::likeSql('i.code'), [$pat])->orWhereRaw(Row::likeSql('i.supplier'), [$pat]));
        }
        if ($q['price'] === 'missing') {
            $query->whereNull('p.package_price');
        }
        if ($q['price'] === 'zero') {
            $query->where('p.package_price', '=', 0);
        }
        $sortCol = self::SORTS[$q['sort'] ?? 'name'] ?? self::SORTS['name'];
        $total = (clone $query)->count();
        // come PostgreSQL: NULL in fondo in ordine crescente, in testa in ordine decrescente
        $rows = $query->orderByRaw("{$sortCol} IS NULL ".($q['dir'] === 'desc' ? 'DESC' : 'ASC'))->orderBy($sortCol, $q['dir'])->orderBy('i.id')
            ->limit($q['pageSize'])->offset(($q['page'] - 1) * $q['pageSize'])
            ->get(['i.id', 'i.code', 'i.name', 'i.category', 'i.supplier', 'i.package_content', 'i.package_unit', 'i.usage_unit', 'i.purchase_unit', 'i.edible_yield', 'i.archived_at', 'i.updated_at',
                'p.package_price', 'p.package_content as price_content', 'p.package_unit as price_unit', 'p.valid_from']);

        return [
            'data' => $rows->map(function ($r) use ($showCosts) {
                $hasPrice = $r->package_price !== null;

                return [
                    'id' => $r->id,
                    'code' => $r->code,
                    'name' => $r->name,
                    'category' => $r->category,
                    'supplier' => $r->supplier,
                    'packageContent' => $r->package_content,
                    'packageUnit' => $r->package_unit,
                    'purchaseUnit' => $r->purchase_unit,
                    'usageUnit' => $r->usage_unit,
                    'edibleYieldPercent' => Dec::of($r->edible_yield)->times(100)->toFixed(),
                    'archived' => $r->archived_at !== null,
                    'updatedAt' => Clock::iso($r->updated_at),
                    'price' => $showCosts ? [
                        'status' => $hasPrice ? (Dec::of($r->package_price)->isZero() ? 'zero' : 'ok') : 'missing',
                        'packagePrice' => $r->package_price,
                        'validFrom' => $r->valid_from,
                        'unitPrice' => $hasPrice ? self::unitPrice($r->package_price, $r->price_content, $r->price_unit) : null,
                        'baseUnit' => Units::BASE_UNIT[Units::dimensionOf($r->price_unit ?? $r->package_unit)],
                    ] : null,
                ];
            })->all(),
            'meta' => ['page' => $q['page'], 'pageSize' => $q['pageSize'], 'total' => $rows->isEmpty() ? 0 : $total, 'date' => $date],
        ];
    }

    public function categories(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');

        return ['data' => DB::table('ingredients')->where('company_id', $ctx->companyId())->whereNotNull('category')->distinct()->orderBy('category')->pluck('category')->all()];
    }

    /** NUOVO — fornitori già usati dall'azienda, per i suggerimenti del modulo. */
    public function suppliers(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');

        return ['data' => DB::table('ingredients')->where('company_id', $ctx->companyId())->whereNotNull('supplier')->where('supplier', '<>', '')->distinct()->orderBy('supplier')->pluck('supplier')->all()];
    }

    /** NUOVO — agenti già usati sui prezzi, con il fornitore di riferimento (per suggerirli per fornitore). */
    public function agents(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read', 'costs.read');
        $rows = DB::table('ingredient_prices')->where('company_id', $ctx->companyId())->whereNotNull('agent_name')->where('agent_name', '<>', '')
            ->groupBy('agent_name', 'supplier')->orderBy('agent_name')
            ->get(['agent_name', 'supplier', DB::raw('MAX(valid_from) as last_used')]);

        return ['data' => $rows->map(fn ($r) => ['name' => $r->agent_name, 'supplier' => $r->supplier, 'lastUsed' => $r->last_used])->all()];
    }

    public function show(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();
        $i = DB::table('ingredients')->where('id', $id)->where('company_id', $cid)->first();
        if (! $i) {
            throw AppError::notFound('Ingrediente');
        }
        $showCosts = $ctx->can('costs.read');
        $prices = $showCosts
            ? Row::all(DB::table('ingredient_prices as p')->leftJoin('users as u', 'u.id', '=', 'p.created_by')
                ->where('p.ingredient_id', $id)->where('p.company_id', $cid)->orderByDesc('p.valid_from')
                ->get(['p.id', 'p.package_price', 'p.package_content', 'p.package_unit', 'p.valid_from', 'p.source', 'p.supplier', 'p.agent_name', 'p.notes', 'p.created_at', 'p.import_id', 'u.name as created_by']))
            : [];
        $t = Clock::today();
        $usedIn = DB::table('recipes as r')->join('recipe_components as c', 'c.revision_id', '=', 'r.current_revision_id')
            ->where('r.company_id', $cid)->where('c.ingredient_id', $id)->distinct()->orderBy('r.title')
            ->get(['r.id', 'r.code', 'r.title', 'r.status']);
        $current = null;
        foreach ($prices as $p) {
            if ($p['valid_from'] <= $t) {
                $current = $p;
                break;
            }
        }

        return [
            'id' => $i->id,
            'code' => $i->code,
            'name' => $i->name,
            'category' => $i->category,
            'supplier' => $i->supplier,
            'notes' => $i->notes,
            'purchaseUnit' => $i->purchase_unit,
            'packageContent' => $i->package_content,
            'packageUnit' => $i->package_unit,
            'usageUnit' => $i->usage_unit,
            'edibleYieldPercent' => Dec::of($i->edible_yield)->times(100)->toFixed(),
            'densityKgPerL' => $i->density_kg_per_l,
            'unitWeightKg' => $i->unit_weight_kg,
            'archived' => $i->archived_at !== null,
            'lockVersion' => (int) $i->lock_version,
            'createdAt' => Clock::iso($i->created_at),
            'updatedAt' => Clock::iso($i->updated_at),
            'priceVisible' => $showCosts,
            'currentPrice' => $current ? [
                ...$current,
                'unitPrice' => self::unitPrice($current['package_price'], $current['package_content'], $current['package_unit']),
                'baseUnit' => Units::BASE_UNIT[Units::dimensionOf($current['package_unit'])],
            ] : null,
            'prices' => array_map(fn ($p) => [
                ...$p,
                'unitPrice' => self::unitPrice($p['package_price'], $p['package_content'], $p['package_unit']),
                'baseUnit' => Units::BASE_UNIT[Units::dimensionOf($p['package_unit'])],
                'future' => $p['valid_from'] > $t,
            ], $prices),
            'usedIn' => Row::all($usedIn),
        ];
    }

    public function store(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage');
        $body = $this->parseBody($req, self::ingredientBody()->extend(['initialPrice' => self::priceBody()->omit(['packageContent', 'packageUnit'])->optional()]));
        self::checkConversions($body);
        if (isset($body['initialPrice']) && ! $ctx->can('costs.read')) {
            throw AppError::badRequest('forbidden_price', 'Non hai i permessi per inserire prezzi.');
        }
        $cid = $ctx->companyId();

        return DB::transaction(function () use ($ctx, $body, $cid) {
            $code = $body['code'] ?? Codes::next('ingredients', $cid, 'ING');
            if (DB::table('ingredients')->where('company_id', $cid)->where('code', $code)->exists()) {
                throw AppError::conflict('duplicate_code', "Il codice {$code} è già usato da un altro ingrediente.", ['fields' => ['code' => 'Codice già in uso.']]);
            }
            $id = (string) Str::uuid();
            DB::table('ingredients')->insert([
                'id' => $id,
                'company_id' => $cid,
                'code' => $code,
                'name' => $body['name'],
                'category' => $body['category'] ?? null,
                'supplier' => $body['supplier'] ?? null,
                'notes' => $body['notes'] ?? null,
                'purchase_unit' => $body['purchaseUnit'],
                'package_content' => $body['packageContent'],
                'package_unit' => $body['packageUnit'],
                'usage_unit' => $body['usageUnit'],
                'edible_yield' => Dec::of($body['edibleYieldPercent'])->div(100)->toFixed(),
                'density_kg_per_l' => $body['densityKgPerL'],
                'unit_weight_kg' => $body['unitWeightKg'],
                'created_at' => Clock::now(),
                'updated_at' => Clock::now(),
            ]);
            if (isset($body['initialPrice'])) {
                $p = $body['initialPrice'];
                DB::table('ingredient_prices')->insert([
                    'id' => (string) Str::uuid(),
                    'company_id' => $cid,
                    'ingredient_id' => $id,
                    'package_price' => $p['packagePrice'],
                    'package_content' => $body['packageContent'],
                    'package_unit' => $body['packageUnit'],
                    'valid_from' => $p['validFrom'],
                    'source' => $p['source'] ?? null,
                    'supplier' => $body['supplier'] ?? null,
                    'agent_name' => $p['agentName'] ?? null,
                    'notes' => $p['notes'] ?? null,
                    'created_by' => $ctx->userId(),
                    'created_at' => Clock::now(),
                ]);
            }
            Audit::log($cid, $ctx->userId(), 'ingredient', $id, 'created', ['code' => $code, 'name' => $body['name']]);

            return ['id' => $id, 'code' => $code, 'name' => $body['name'], 'usageUnit' => $body['usageUnit'], 'packageUnit' => $body['packageUnit']];
        });
    }

    public function update(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, self::ingredientBody()->extend(['code' => S::reqText('Il codice', 40), 'lockVersion' => S::int()]));
        self::checkConversions($body);
        $cid = $ctx->companyId();
        $changes = DB::transaction(function () use ($ctx, $body, $cid, $id) {
            $cur = DB::table('ingredients')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first();
            if (! $cur) {
                throw AppError::notFound('Ingrediente');
            }
            if ((int) $cur->lock_version !== $body['lockVersion']) {
                throw AppError::conflict('stale', 'L’ingrediente è stato modificato da un altro utente: ricarica la pagina.');
            }
            if (mb_strtolower($body['code']) !== mb_strtolower($cur->code)
                && DB::table('ingredients')->where('company_id', $cid)->where('code', $body['code'])->where('id', '<>', $id)->exists()) {
                throw AppError::conflict('duplicate_code', "Il codice {$body['code']} è già usato.", ['fields' => ['code' => 'Codice già in uso.']]);
            }
            $next = [
                'code' => $body['code'],
                'name' => $body['name'],
                'category' => $body['category'] ?? null,
                'supplier' => $body['supplier'] ?? null,
                'notes' => $body['notes'] ?? null,
                'purchase_unit' => $body['purchaseUnit'],
                'package_content' => $body['packageContent'],
                'package_unit' => $body['packageUnit'],
                'usage_unit' => $body['usageUnit'],
                'edible_yield' => Dec::of($body['edibleYieldPercent'])->div(100)->toFixed(),
                'density_kg_per_l' => $body['densityKgPerL'],
                'unit_weight_kg' => $body['unitWeightKg'],
            ];
            $before = [];
            foreach (array_keys($next) as $k) {
                $before[$k] = Audit::normalizeNum($cur->{$k});
            }
            $changes = Audit::diff($before, array_map([Audit::class, 'normalizeNum'], $next));
            DB::table('ingredients')->where('id', $id)->update([...$next, 'updated_at' => Clock::now(), 'lock_version' => $cur->lock_version + 1]);
            Audit::log($cid, $ctx->userId(), 'ingredient', $id, 'updated', $changes);

            return $changes;
        });
        $costRelevant = array_intersect(['edible_yield', 'density_kg_per_l', 'unit_weight_kg'], array_keys($changes));
        $affected = $costRelevant ? Costing::invalidate($cid, 'ingredients', [$id]) : [];

        return ['ok' => true, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    /** Nuovo prezzo: crea una voce di storico e segnala le ricette interessate, anche indirettamente. */
    public function addPrice(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage', 'costs.read');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, self::priceBody());
        $cid = $ctx->companyId();
        $ing = DB::table('ingredients')->where('id', $id)->where('company_id', $cid)->first();
        if (! $ing) {
            throw AppError::notFound('Ingrediente');
        }
        $content = $body['packageContent'] ?? $ing->package_content;
        $unit = $body['packageUnit'] ?? $ing->package_unit;
        if (Units::dimensionOf($unit) !== Units::dimensionOf($ing->package_unit)) {
            throw AppError::badRequest('validation_failed', 'L’unità della confezione deve restare della stessa grandezza (peso, volume o pezzi).', ['fields' => ['packageUnit' => 'Grandezza non compatibile.']]);
        }
        $existing = DB::table('ingredient_prices')->where('ingredient_id', $id)->where('valid_from', $body['validFrom'])->first();
        if ($existing) {
            $same = Dec::of($existing->package_price)->eq($body['packagePrice']) && Dec::of($existing->package_content)->eq(Dec::of($content)) && $existing->package_unit === $unit;
            throw AppError::conflict(
                $same ? 'duplicate_price' : 'price_date_conflict',
                $same ? 'Questo prezzo è già registrato con la stessa data.' : 'Esiste già un prezzo con questa data di validità: scegli un’altra data o elimina quello esistente.',
                ['fields' => ['validFrom' => 'Data già usata.']],
            );
        }
        $priceId = (string) Str::uuid();
        DB::table('ingredient_prices')->insert([
            'id' => $priceId,
            'company_id' => $cid,
            'ingredient_id' => $id,
            'package_price' => $body['packagePrice'],
            'package_content' => $content,
            'package_unit' => $unit,
            'valid_from' => $body['validFrom'],
            'source' => $body['source'] ?? null,
            'supplier' => $ing->supplier,
            'agent_name' => $body['agentName'] ?? null,
            'notes' => $body['notes'] ?? null,
            'created_by' => $ctx->userId(),
            'created_at' => Clock::now(),
        ]);
        Audit::log($cid, $ctx->userId(), 'ingredient_price', $priceId, 'created', ['ingredient' => $ing->code, 'packagePrice' => $body['packagePrice'], 'validFrom' => $body['validFrom']]);
        $affected = Costing::invalidate($cid, 'ingredients', [$id]);

        return ['id' => $priceId, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    public function deletePrice(Request $req, string $id, string $priceId): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage', 'costs.read');
        [$id, $priceId] = $this->uuids(['id' => $id, 'priceId' => $priceId]);
        $cid = $ctx->companyId();
        $p = DB::table('ingredient_prices')->where('id', $priceId)->where('ingredient_id', $id)->where('company_id', $cid)->first();
        if (! $p) {
            throw AppError::notFound('Prezzo');
        }
        DB::table('ingredient_prices')->where('id', $priceId)->delete();
        Audit::log($cid, $ctx->userId(), 'ingredient_price', $priceId, 'deleted', ['packagePrice' => $p->package_price, 'validFrom' => $p->valid_from]);
        $affected = Costing::invalidate($cid, 'ingredients', [$id]);

        return ['ok' => true, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    public function archive(Request $req, string $id): array
    {
        return $this->setArchived($req, $id, true);
    }

    public function restore(Request $req, string $id): array
    {
        return $this->setArchived($req, $id, false);
    }

    private function setArchived(Request $req, string $id, bool $archived): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage');
        $id = $this->uuid($id);
        $n = DB::table('ingredients')->where('id', $id)->where('company_id', $ctx->companyId())->update([
            'archived_at' => $archived ? Clock::now() : null, 'updated_at' => Clock::now(), 'lock_version' => DB::raw('lock_version + 1'),
        ]);
        if (! $n) {
            throw AppError::notFound('Ingrediente');
        }
        Audit::log($ctx->companyId(), $ctx->userId(), 'ingredient', $id, $archived ? 'archived' : 'restored');

        return ['ok' => true];
    }

    /** Eliminazione definitiva solo se l'ingrediente non è mai stato usato in nessuna revisione di ricetta. */
    public function destroy(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();

        return DB::transaction(function () use ($ctx, $cid, $id) {
            $ing = DB::table('ingredients')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first(['id', 'code']);
            if (! $ing) {
                throw AppError::notFound('Ingrediente');
            }
            if (DB::table('recipe_components')->where('ingredient_id', $id)->exists()) {
                throw AppError::conflict('in_use', 'L’ingrediente è usato in almeno una ricetta (anche in revisioni storiche): puoi archiviarlo ma non eliminarlo.');
            }
            DB::table('ingredient_prices')->where('ingredient_id', $id)->delete();
            DB::table('ingredients')->where('id', $id)->delete();
            Audit::log($cid, $ctx->userId(), 'ingredient', $id, 'deleted', ['code' => $ing->code]);

            return ['ok' => true];
        });
    }
}
