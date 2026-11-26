<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Calculators;
use App\Domain\Costing\Dec;
use App\Domain\Costing\Units;
use App\Http\Controllers\Controller;
use App\Auth\Crypto;
use App\Services\Audit;
use App\Services\Promoters;
use App\Services\Costing;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Row;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * NUOVO — Console del superadmin (piattaforma SaaS). Solo is_platform_admin.
 *
 * - Aziende (tenant): elenco, creazione con invito dell'amministratore, rinomina e archiviazione.
 * - Consultazione trasversale di ricette e prodotti di tutti i ristoratori (i dati restano dei ristoratori:
 *   qui non si modificano; per assisterli il superadmin entra nell'azienda in "modalità assistenza").
 * - Statistiche sui prezzi pagati per prodotto, fornitore e agente, anche combinati.
 * - Gruppi di confronto: ricette equivalenti scelte a mano (anche con nomi diversi) messe a confronto.
 *
 * I prodotti uguali caricati da ristoratori diversi NON vengono unificati (decisione del 21/11/2026):
 * i confronti li raggruppano per nome e fornitore normalizzati, senza toccare i dati.
 */
final class PlatformController extends Controller
{
    /** Chiave di raggruppamento: minuscole, senza accenti, spazi compattati. */
    public static function key(?string $s): string
    {
        return \App\Services\Imports\Fields::norm((string) $s);
    }

    public function overview(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $companies = DB::table('companies')->count();
        $active = DB::table('companies')->whereNull('archived_at')->count();
        $count = fn (string $t, bool $arch = true) => $arch ? DB::table($t)->whereNull('archived_at')->count() : DB::table($t)->count();

        return [
            'companies' => $companies,
            'activeCompanies' => $active,
            'users' => DB::table('users')->where('is_active', 1)->count(),
            'recipes' => DB::table('recipes')->where('status', '<>', 'archived')->count(),
            'ingredients' => $count('ingredients'),
            'prices' => $count('ingredient_prices', false),
            'suppliers' => DB::table('ingredients')->whereNotNull('supplier')->distinct()->count('supplier'),
            'agents' => DB::table('ingredient_prices')->whereNotNull('agent_name')->distinct()->count('agent_name'),
            'comparisonGroups' => DB::table('comparison_groups')->count(),
        ];
    }

    /* ------------------------------ aziende ------------------------------ */

    public function companies(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $rows = DB::table('companies')->orderBy('name')->get();
        $stat = fn (string $t, string $where = '1=1') => DB::table($t)->whereRaw($where)->groupBy('company_id')->selectRaw('company_id, count(*) as n')->pluck('n', 'company_id');
        $recipes = $stat('recipes', "status <> 'archived'");
        $ingredients = $stat('ingredients', 'archived_at IS NULL');
        $users = DB::table('memberships')->where('is_active', 1)->groupBy('company_id')->selectRaw('company_id, count(*) as n')->pluck('n', 'company_id');
        $admins = DB::table('memberships as m')->join('users as u', 'u.id', '=', 'm.user_id')->where('m.role', 'admin')->where('m.is_active', 1)
            ->orderBy('u.name')->get(['m.company_id', 'u.name', 'u.email'])->groupBy('company_id');
        $promoters = DB::table('promoters')->pluck('name', 'id');
        $pending = DB::table('invitations')->whereNull('accepted_at')->where('role', 'admin')->get(['id', 'company_id', 'email', 'expires_at'])->groupBy('company_id');

        return ['data' => $rows->map(fn ($c) => [
            'id' => $c->id,
            'name' => $c->name,
            'createdAt' => Clock::iso($c->created_at),
            'archived' => $c->archived_at !== null,
            'recipes' => (int) ($recipes[$c->id] ?? 0),
            'ingredients' => (int) ($ingredients[$c->id] ?? 0),
            'users' => (int) ($users[$c->id] ?? 0),
            'admins' => ($admins[$c->id] ?? collect())->map(fn ($a) => ['name' => $a->name, 'email' => $a->email])->values()->all(),
            'promoter' => $c->promoter_id ? ['id' => $c->promoter_id, 'name' => $promoters[$c->promoter_id] ?? null, 'code' => $c->promo_code] : null,
            'pendingAdminInvitations' => ($pending[$c->id] ?? collect())->map(fn ($i) => ['id' => $i->id, 'email' => $i->email, 'expired' => Clock::isPast($i->expires_at)])->values()->all(),
        ])->all()];
    }

    /** Nuovo tenant: crea l'azienda e invita il suo amministratore (il superadmin non ne diventa membro). */
    public function createCompany(Request $req): array
    {
        $auth = $this->requirePlatformAdmin($req);
        $body = $this->parseBody($req, S::object([
            'name' => S::string()->trim()->min(2, 'Il nome dell’azienda è obbligatorio.')->max(160),
            'adminName' => S::string()->trim()->min(2, 'Indica il nome dell’amministratore.')->max(120),
            'adminEmail' => S::string()->trim()->toLowerCase()->refine(fn ($v) => filter_var($v, FILTER_VALIDATE_EMAIL) !== false, 'Email non valida.'),
            'sendEmail' => S::bool()->default(false),
            'promoCode' => S::string()->trim()->max(40)->nullable()->optional(),
        ]));
        // NUOVO: codice promo del promotore che ha presentato il cliente (facoltativo)
        $promoter = ($body['promoCode'] ?? '') !== '' ? Promoters::require($body['promoCode']) : null;

        return self::makeCompany($auth, $body['name'], $body['adminName'], $body['adminEmail'], $body['sendEmail'], $promoter, 'platform');
    }

    /** Crea l'azienda con l'invito del suo amministratore (usata anche per approvare le richieste di attivazione). */
    public static function makeCompany(\App\Auth\AuthContext $auth, string $name, string $adminName, string $adminEmail, bool $sendEmail, ?object $promoter, string $via, ?callable $after = null): array
    {
        return DB::transaction(function () use ($auth, $name, $adminName, $adminEmail, $sendEmail, $promoter, $via, $after) {
            $id = (string) Str::uuid();
            DB::table('companies')->insert(['id' => $id, 'name' => $name, 'created_at' => Clock::now()]);
            if ($promoter) {
                Promoters::attach($id, $promoter, $via);
            }
            Audit::log($id, $auth->userId(), 'company', $id, 'created', ['name' => $name, 'by' => 'platform', 'via' => $via]);
            // NUOVO: il link è sempre restituito al superadmin, che sceglie se inviarlo anche per email
            $inv = UserController::createInvitation($id, $name, $auth->userId(), $auth->user['name'], $adminEmail, $adminName, 'admin', [], $sendEmail, true);
            if ($after) {
                $after($id);
            }

            return ['id' => $id, 'name' => $name, 'invitation' => [...$inv, 'email' => $adminEmail]];
        });
    }

    /**
     * NUOVO — invia per email un invito già creato. Il token arriva dal superadmin (il server ne conserva solo l'impronta):
     * si verifica che corrisponda all'invito prima di spedirlo.
     */
    public function sendInvitation(Request $req, string $id): array
    {
        $auth = $this->requirePlatformAdmin($req);
        $id = $this->uuid($id);
        $body = $this->parseBody($req, S::object(['token' => S::string()->min(10)->max(200)]));
        $inv = $this->pendingInvitation($id);
        if (! hash_equals((string) $inv->token_hash, Crypto::hashToken($body['token']))) {
            throw AppError::badRequest('invalid_token', 'Il link non corrisponde a questo invito.');
        }
        $link = config('foodcost.app_url')."/invito?token={$body['token']}";
        try {
            $mail = UserController::sendInviteMail($inv->email, $inv->company_name, $auth->user['name'], $inv->role, $link);
        } catch (\Throwable $e) {
            Log::error('invio email di invito non riuscito', ['err' => $e->getMessage()]);
            throw new AppError(502, 'mail_failed', 'L’email non è partita: riprova più tardi oppure invia tu il link.');
        }
        Audit::log($inv->company_id, $auth->userId(), 'invitation', $id, 'emailed', ['email' => $inv->email]);

        return ['mail' => $mail, 'email' => $inv->email];
    }

    /** NUOVO — nuovo link per un invito in attesa (il precedente smette di valere), valido altri 7 giorni. */
    public function renewInvitation(Request $req, string $id): array
    {
        $auth = $this->requirePlatformAdmin($req);
        $id = $this->uuid($id);
        $inv = $this->pendingInvitation($id, true);
        $token = Crypto::newToken();
        DB::table('invitations')->where('id', $id)->update(['token_hash' => Crypto::hashToken($token), 'expires_at' => Clock::plusSeconds(7 * 86400)]);
        Audit::log($inv->company_id, $auth->userId(), 'invitation', $id, 'renewed', ['email' => $inv->email]);

        return ['id' => $id, 'email' => $inv->email, 'inviteLink' => config('foodcost.app_url')."/invito?token={$token}"];
    }

    private function pendingInvitation(string $id, bool $allowExpired = false): object
    {
        $inv = DB::table('invitations as i')->join('companies as c', 'c.id', '=', 'i.company_id')
            ->where('i.id', $id)->whereNull('i.accepted_at')
            ->first(['i.id', 'i.company_id', 'i.email', 'i.role', 'i.token_hash', 'i.expires_at', 'c.name as company_name']);
        if (! $inv) {
            throw AppError::notFound('Invito');
        }
        if (! $allowExpired && Clock::isPast($inv->expires_at)) {
            throw AppError::conflict('invitation_expired', 'L’invito è scaduto: crea un nuovo link.');
        }

        return $inv;
    }

    public function updateCompany(Request $req, string $id): array
    {
        $auth = $this->requirePlatformAdmin($req);
        $id = $this->uuid($id);
        $body = $this->parseBody($req, S::object([
            'name' => S::string()->trim()->min(2)->max(160)->optional(),
            'archived' => S::bool()->optional(),
            'promoCode' => S::string()->trim()->max(40)->nullable()->optional(),
        ]));
        if (! DB::table('companies')->where('id', $id)->exists()) {
            throw AppError::notFound('Azienda');
        }
        $set = [];
        // NUOVO: il superadmin può assegnare, correggere o togliere il promotore
        if (array_key_exists('promoCode', $body)) {
            if (($body['promoCode'] ?? '') === '') {
                $set += ['promoter_id' => null, 'promo_code' => null, 'referred_via' => null, 'referred_at' => null];
            } else {
                $p = Promoters::require($body['promoCode']);
                $set += ['promoter_id' => $p->id, 'promo_code' => $p->code, 'referred_via' => 'platform', 'referred_at' => Clock::now()];
            }
        }
        if (isset($body['name'])) {
            $set['name'] = $body['name'];
        }
        if (array_key_exists('archived', $body)) {
            $set['archived_at'] = $body['archived'] ? Clock::now() : null;
        }
        if ($set) {
            DB::table('companies')->where('id', $id)->update($set);
            if (! empty($body['archived'])) {
                // un'azienda archiviata non è più accessibile: si chiudono le sessioni attive su di essa
                DB::table('sessions')->where('active_company_id', $id)->update(['active_company_id' => null]);
            }
            Audit::log($id, $auth->userId(), 'company', $id, 'platform_updated', $body);
        }

        return ['ok' => true];
    }

    /* ------------------------- ricette e prodotti ------------------------- */

    /** Ricette di tutti i ristoratori, con i costi correnti. */
    public function recipes(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $q = $this->parseQuery($req, S::object([
            'q' => S::string()->trim()->max(100)->optional(),
            'companyId' => S::uuid()->optional(),
            'category' => S::string()->trim()->max(100)->optional(),
            'page' => S::coerceInt(1)->default(1),
            'pageSize' => S::coerceInt(1, 100)->default(25),
        ]));
        $query = DB::table('recipes as r')->join('companies as c', 'c.id', '=', 'r.company_id')
            ->leftJoin('recipe_revisions as v', 'v.id', '=', 'r.current_revision_id')
            ->where('r.status', '<>', 'archived')->whereNotNull('r.current_revision_id');
        if (! empty($q['companyId'])) {
            $query->where('r.company_id', $q['companyId']);
        }
        if (! empty($q['category'])) {
            $query->where('r.category', $q['category']);
        }
        if (! empty($q['q'])) {
            $pat = Row::like($q['q']);
            $query->where(fn ($w) => $w->whereRaw(Row::likeSql('r.title'), [$pat])->orWhereRaw(Row::likeSql('r.code'), [$pat])->orWhereRaw(Row::likeSql('r.category'), [$pat]));
        }
        $total = (clone $query)->count();
        $rows = $query->orderBy('r.title')->orderBy('c.name')->limit($q['pageSize'])->offset(($q['page'] - 1) * $q['pageSize'])
            ->get(['r.id', 'r.code', 'r.title', 'r.category', 'r.status', 'r.company_id', 'c.name as company', 'v.portions', 'v.final_weight_kg', 'r.updated_at']);
        $vals = self::valuations($rows->map(fn ($r) => ['companyId' => $r->company_id, 'id' => $r->id])->all());

        return [
            'data' => $rows->map(fn ($r) => [
                'id' => $r->id, 'code' => $r->code, 'title' => $r->title, 'category' => $r->category, 'status' => $r->status,
                'companyId' => $r->company_id, 'company' => $r->company, 'portions' => $r->portions, 'finalWeightKg' => $r->final_weight_kg,
                'updatedAt' => Clock::iso($r->updated_at),
                'cost' => self::costSummary($vals[$r->id] ?? null),
            ])->all(),
            'meta' => ['page' => $q['page'], 'pageSize' => $q['pageSize'], 'total' => $total, 'date' => Clock::today()],
        ];
    }

    /** Prodotti (ingredienti) di tutti i ristoratori, con prezzo corrente, fornitore e ultimo agente. */
    public function ingredients(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $q = $this->parseQuery($req, S::object([
            'q' => S::string()->trim()->max(100)->optional(),
            'supplier' => S::string()->trim()->max(120)->optional(),
            'companyId' => S::uuid()->optional(),
            'page' => S::coerceInt(1)->default(1),
            'pageSize' => S::coerceInt(1, 100)->default(25),
        ]));
        $t = Clock::today();
        $query = DB::table('ingredients as i')->join('companies as c', 'c.id', '=', 'i.company_id')->whereNull('i.archived_at');
        if (! empty($q['companyId'])) {
            $query->where('i.company_id', $q['companyId']);
        }
        if (! empty($q['supplier'])) {
            $query->whereRaw(Row::likeSql('i.supplier'), [Row::like($q['supplier'])]);
        }
        if (! empty($q['q'])) {
            $pat = Row::like($q['q']);
            $query->where(fn ($w) => $w->whereRaw(Row::likeSql('i.name'), [$pat])->orWhereRaw(Row::likeSql('i.code'), [$pat]));
        }
        $total = (clone $query)->count();
        $rows = $query->orderBy('i.name')->orderBy('c.name')->limit($q['pageSize'])->offset(($q['page'] - 1) * $q['pageSize'])
            ->get(['i.id', 'i.code', 'i.name', 'i.category', 'i.supplier', 'i.package_content', 'i.package_unit', 'i.company_id', 'c.name as company']);
        $prices = Costing::latestAt('ingredient_prices', 'ingredient_id', $rows->pluck('id')->all(), $t, ['ingredient_id', 'package_price', 'package_content', 'package_unit', 'valid_from', 'agent_name', 'supplier']);
        // quanti ristoratori hanno un prodotto con lo stesso nome e fornitore (nessuna unificazione automatica)
        $keys = [];
        foreach (DB::table('ingredients')->whereNull('archived_at')->get(['company_id', 'name', 'supplier']) as $x) {
            $keys[self::key($x->name).'|'.self::key($x->supplier)][$x->company_id] = true;
        }

        return [
            'data' => $rows->map(function ($r) use ($prices, $keys) {
                $p = $prices[$r->id] ?? null;

                return [
                    'id' => $r->id, 'code' => $r->code, 'name' => $r->name, 'category' => $r->category, 'supplier' => $r->supplier,
                    'companyId' => $r->company_id, 'company' => $r->company,
                    'price' => $p ? [
                        'packagePrice' => $p->package_price, 'packageContent' => $p->package_content, 'packageUnit' => $p->package_unit,
                        'validFrom' => $p->valid_from, 'agentName' => $p->agent_name,
                        'unitPrice' => self::unitPrice($p), 'baseUnit' => Units::BASE_UNIT[Units::dimensionOf($p->package_unit)],
                    ] : null,
                    'sameNameSupplierCompanies' => count($keys[self::key($r->name).'|'.self::key($r->supplier)] ?? []),
                ];
            })->all(),
            'meta' => ['page' => $q['page'], 'pageSize' => $q['pageSize'], 'total' => $total, 'date' => $t],
        ];
    }

    /** Fornitori (raggruppati per nome normalizzato) con numero di ristoratori, prodotti e agenti. */
    public function suppliers(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $groups = [];
        foreach (DB::table('ingredients')->whereNotNull('supplier')->whereNull('archived_at')->get(['id', 'company_id', 'supplier']) as $i) {
            $k = self::key($i->supplier);
            $groups[$k] ??= ['key' => $k, 'names' => [], 'companies' => [], 'products' => 0, 'agents' => []];
            $groups[$k]['names'][$i->supplier] = true;
            $groups[$k]['companies'][$i->company_id] = true;
            $groups[$k]['products']++;
        }
        foreach (DB::table('ingredient_prices')->whereNotNull('agent_name')->whereNotNull('supplier')->get(['supplier', 'agent_name']) as $p) {
            $k = self::key($p->supplier);
            if (isset($groups[$k])) {
                $groups[$k]['agents'][trim($p->agent_name)] = true;
            }
        }
        $out = array_map(fn ($g) => [
            'key' => $g['key'], 'name' => array_key_first($g['names']), 'variants' => array_keys($g['names']),
            'companies' => count($g['companies']), 'products' => $g['products'], 'agents' => array_keys($g['agents']),
        ], array_values($groups));
        usort($out, fn ($a, $b) => strcmp($a['key'], $b['key']));

        return ['data' => $out];
    }

    /**
     * Statistiche dei prezzi pagati: filtro per prodotto (nome), fornitore, agente, aziende e periodo.
     * Il confronto avviene sul prezzo normalizzato per unità di base (€/kg, €/l, €/pz).
     */
    public function priceStats(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $q = $this->parseQuery($req, S::object([
            'product' => S::string()->trim()->max(160)->optional(),
            'supplier' => S::string()->trim()->max(120)->optional(),
            'agent' => S::string()->trim()->max(120)->optional(),
            'companyIds' => S::string()->max(4000)->optional(),
            'from' => S::isoDate()->optional(),
            'to' => S::isoDate()->optional(),
        ]));
        if (empty($q['product']) && empty($q['supplier']) && empty($q['agent'])) {
            throw AppError::badRequest('validation_failed', 'Indica almeno un prodotto, un fornitore o un agente.', ['fields' => ['product' => 'Filtro obbligatorio.']]);
        }
        $query = DB::table('ingredient_prices as p')->join('ingredients as i', 'i.id', '=', 'p.ingredient_id')->join('companies as c', 'c.id', '=', 'p.company_id');
        if (! empty($q['product'])) {
            $query->whereRaw(Row::likeSql('i.name'), [Row::like($q['product'])]);
        }
        if (! empty($q['supplier'])) {
            $pat = Row::like($q['supplier']);
            $query->where(fn ($w) => $w->whereRaw(Row::likeSql('p.supplier'), [$pat])->orWhere(fn ($x) => $x->whereNull('p.supplier')->whereRaw(Row::likeSql('i.supplier'), [$pat])));
        }
        if (! empty($q['agent'])) {
            $query->whereRaw(Row::likeSql('p.agent_name'), [Row::like($q['agent'])]);
        }
        if (! empty($q['companyIds'])) {
            $query->whereIn('p.company_id', array_filter(array_map('trim', explode(',', $q['companyIds']))));
        }
        if (! empty($q['from'])) {
            $query->where('p.valid_from', '>=', $q['from']);
        }
        if (! empty($q['to'])) {
            $query->where('p.valid_from', '<=', $q['to']);
        }
        $rows = $query->orderBy('p.valid_from')->limit(5000)
            ->get(['p.id', 'p.valid_from', 'p.package_price', 'p.package_content', 'p.package_unit', 'p.agent_name', 'p.supplier as price_supplier',
                'i.id as ingredient_id', 'i.name', 'i.supplier', 'i.company_id', 'c.name as company']);

        $points = [];
        $groups = ['byBaseUnit' => [], 'bySupplier' => [], 'byAgent' => [], 'byCompany' => [], 'byProduct' => []];
        foreach ($rows as $r) {
            $unitPrice = self::unitPrice($r);
            $base = Units::BASE_UNIT[Units::dimensionOf($r->package_unit)];
            $supplier = $r->price_supplier ?? $r->supplier;
            $points[] = [
                'id' => $r->id, 'date' => $r->valid_from, 'company' => $r->company, 'companyId' => $r->company_id, 'product' => $r->name, 'ingredientId' => $r->ingredient_id,
                'supplier' => $supplier, 'agent' => $r->agent_name, 'packagePrice' => $r->package_price, 'packageContent' => $r->package_content,
                'packageUnit' => $r->package_unit, 'unitPrice' => $unitPrice, 'baseUnit' => $base,
            ];
            // prezzi di grandezze diverse (€/kg e €/pz) non si sommano: ogni gruppo è per unità di base
            $add = function (string $g, string $label) use (&$groups, $base, $unitPrice) {
                $k = $label.'|'.$base;
                $groups[$g][$k] ??= ['label' => $label, 'baseUnit' => $base, 'values' => []];
                $groups[$g][$k]['values'][] = $unitPrice;
            };
            $add('byBaseUnit', $base);
            $add('bySupplier', $supplier ?? '(senza fornitore)');
            $add('byAgent', $r->agent_name ?? '(senza agente)');
            $add('byCompany', $r->company);
            $add('byProduct', $r->name);
        }
        $summaries = [];
        foreach ($groups as $g => $items) {
            $summaries[$g] = array_values(array_map(fn ($x) => ['label' => $x['label'], 'baseUnit' => $x['baseUnit'], ...self::stats($x['values'])], $items));
            usort($summaries[$g], fn ($a, $b) => [$a['baseUnit'], Dec::of($a['avg'])->toFloat()] <=> [$b['baseUnit'], Dec::of($b['avg'])->toFloat()]);
        }

        return ['points' => $points, 'summary' => $summaries, 'truncated' => count($rows) >= 5000];
    }

    /* --------------------------- gruppi di confronto --------------------------- */

    public function groups(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $counts = DB::table('comparison_group_items')->groupBy('group_id')->selectRaw('group_id, count(*) as n')->pluck('n', 'group_id');

        return ['data' => DB::table('comparison_groups')->orderBy('name')->get()->map(fn ($g) => [
            'id' => $g->id, 'name' => $g->name, 'notes' => $g->notes, 'recipes' => (int) ($counts[$g->id] ?? 0), 'updatedAt' => Clock::iso($g->updated_at),
        ])->all()];
    }

    private static function groupBody(): \App\Support\Validation\Schema
    {
        return S::object([
            'name' => S::reqText('Il nome del gruppo', 160),
            'notes' => S::optText(2000),
            'recipeIds' => S::array(S::uuid())->max(200)->default([]),
        ]);
    }

    public function createGroup(Request $req): array
    {
        $auth = $this->requirePlatformAdmin($req);
        $body = $this->parseBody($req, self::groupBody());
        $id = (string) Str::uuid();
        DB::transaction(function () use ($auth, $body, $id) {
            DB::table('comparison_groups')->insert(['id' => $id, 'name' => $body['name'], 'notes' => $body['notes'] ?? null, 'created_by' => $auth->userId(), 'created_at' => Clock::now(), 'updated_at' => Clock::now()]);
            self::setItems($id, $body['recipeIds']);
        });

        return ['id' => $id];
    }

    public function updateGroup(Request $req, string $id): array
    {
        $this->requirePlatformAdmin($req);
        $id = $this->uuid($id);
        $body = $this->parseBody($req, self::groupBody());
        if (! DB::table('comparison_groups')->where('id', $id)->exists()) {
            throw AppError::notFound('Gruppo');
        }
        DB::transaction(function () use ($body, $id) {
            DB::table('comparison_groups')->where('id', $id)->update(['name' => $body['name'], 'notes' => $body['notes'] ?? null, 'updated_at' => Clock::now()]);
            self::setItems($id, $body['recipeIds']);
        });

        return ['ok' => true];
    }

    public function deleteGroup(Request $req, string $id): array
    {
        $this->requirePlatformAdmin($req);
        $id = $this->uuid($id);
        if (! DB::table('comparison_groups')->where('id', $id)->delete()) {
            throw AppError::notFound('Gruppo');
        }

        return ['ok' => true];
    }

    private static function setItems(string $groupId, array $recipeIds): void
    {
        $recipeIds = array_values(array_unique(array_map('strtolower', $recipeIds)));
        $found = $recipeIds ? DB::table('recipes')->whereIn('id', $recipeIds)->pluck('company_id', 'id')->all() : [];
        if (count($found) !== count($recipeIds)) {
            throw AppError::badRequest('invalid_reference', 'Una o più ricette non esistono.');
        }
        DB::table('comparison_group_items')->where('group_id', $groupId)->delete();
        if ($recipeIds) {
            DB::table('comparison_group_items')->insert(array_map(fn ($rid) => [
                'id' => (string) Str::uuid(), 'group_id' => $groupId, 'company_id' => $found[$rid], 'recipe_id' => $rid, 'created_at' => Clock::now(),
            ], $recipeIds));
        }
    }

    /** Confronto: costi correnti delle ricette del gruppo, con ripartizione e statistiche. */
    public function showGroup(Request $req, string $id): array
    {
        $this->requirePlatformAdmin($req);
        $id = $this->uuid($id);
        $g = DB::table('comparison_groups')->where('id', $id)->first();
        if (! $g) {
            throw AppError::notFound('Gruppo');
        }
        $items = DB::table('comparison_group_items as gi')->join('recipes as r', 'r.id', '=', 'gi.recipe_id')->join('companies as c', 'c.id', '=', 'gi.company_id')
            ->where('gi.group_id', $id)->orderBy('c.name')->orderBy('r.title')
            ->get(['r.id', 'r.code', 'r.title', 'r.category', 'r.status', 'r.current_revision_id', 'gi.company_id', 'c.name as company']);
        $vals = self::valuations($items->filter(fn ($r) => $r->current_revision_id)->map(fn ($r) => ['companyId' => $r->company_id, 'id' => $r->id])->values()->all());
        $rows = $items->map(function ($r) use ($vals) {
            $v = $vals[$r->id] ?? null;
            $total = $v ? Dec::of($v['total']) : null;
            $share = fn (string $k) => $v && ! $total->isZero() ? Dec::of($v['expanded'][$k])->div($total)->times(100)->toFixed() : null;

            return [
                'id' => $r->id, 'code' => $r->code, 'title' => $r->title, 'category' => $r->category, 'status' => $r->status,
                'companyId' => $r->company_id, 'company' => $r->company,
                'cost' => self::costSummary($v),
                'breakdown' => $v ? [
                    'ingredients' => $v['expanded']['ingredients'], 'energy' => $v['expanded']['energy'], 'labor' => $v['expanded']['labor'],
                    'ingredientsPercent' => $share('ingredients'), 'energyPercent' => $share('energy'), 'laborPercent' => $share('labor'),
                ] : null,
                'yield' => $v ? ['finalWeightKg' => $v['finalWeightKg'], 'portions' => $v['portions'], 'portionWeightKg' => $v['portionWeightKg']] : null,
                'ingredients' => $v ? array_map(fn ($l) => ['name' => $l['name'], 'quantity' => $l['quantity'], 'unit' => $l['unit'], 'unitPrice' => $l['unitPrice'], 'baseUnit' => $l['baseUnit'], 'cost' => $l['cost']], $v['ingredientLines']) : [],
            ];
        })->all();
        $collect = fn (string $k) => array_values(array_filter(array_map(fn ($x) => $x['cost'][$k] ?? null, $rows), fn ($x) => $x !== null));

        return [
            'id' => $g->id,
            'name' => $g->name,
            'notes' => $g->notes,
            'date' => Clock::today(),
            'recipes' => $rows,
            'stats' => [
                'costPerKg' => self::stats($collect('costPerKg')),
                'costPerPortion' => self::stats($collect('costPerPortion')),
                'total' => self::stats($collect('total')),
            ],
        ];
    }

    /* ------------------------------ supporto ------------------------------ */

    /** Valorizzazioni correnti di ricette di aziende diverse (cache per azienda, come nell'app del ristoratore). */
    private static function valuations(array $refs): array
    {
        $byCompany = [];
        foreach ($refs as $r) {
            $byCompany[$r['companyId']][] = $r['id'];
        }
        $out = [];
        $t = Clock::today();
        foreach ($byCompany as $cid => $ids) {
            $out += Costing::currentValuations($cid, $ids, $t);
        }

        return $out;
    }

    private static function costSummary(?array $v): ?array
    {
        if (! $v) {
            return null;
        }

        return [
            'complete' => $v['complete'], 'total' => $v['total'], 'costPerKg' => $v['costPerKg'], 'costPerPortion' => $v['costPerPortion'],
            'errors' => count(array_filter($v['issues'], fn ($i) => $i['severity'] === 'error')),
        ];
    }

    private static function unitPrice(object $p): string
    {
        return Calculators::normalizedPrice(['packagePrice' => Dec::of($p->package_price), 'packageContent' => Dec::of($p->package_content), 'packageUnit' => $p->package_unit])->toFixed();
    }

    /** min, max, media, mediana e scarto tra minimo e massimo (in % sul minimo). */
    public static function stats(array $values): array
    {
        if (! $values) {
            return ['count' => 0, 'min' => null, 'max' => null, 'avg' => null, 'median' => null, 'spreadPercent' => null];
        }
        $decs = array_map(fn ($v) => Dec::of($v), $values);
        usort($decs, fn (Dec $a, Dec $b) => $a->cmp($b));
        $n = count($decs);
        $min = $decs[0];
        $max = $decs[$n - 1];
        $median = $n % 2 ? $decs[intdiv($n, 2)] : $decs[$n / 2 - 1]->plus($decs[$n / 2])->div(2);

        return [
            'count' => $n,
            'min' => $min->toFixed(),
            'max' => $max->toFixed(),
            'avg' => Dec::sum($decs)->div($n)->toFixed(),
            'median' => $median->toFixed(),
            'spreadPercent' => $min->isZero() ? null : $max->minus($min)->div($min)->times(100)->toFixed(),
        ];
    }
}
