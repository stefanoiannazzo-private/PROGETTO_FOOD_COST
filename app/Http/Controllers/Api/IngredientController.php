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
use App\Services\ChangeAlerts;
use App\Services\Costing;
use App\Support\NonFood;
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
            // NUOVO: eccezione «non alimentare» sul singolo prodotto (null = come la categoria)
            'nonFood' => S::bool()->nullable()->optional(),
        ]);
    }

    private static function dimension(string $u): string
    {
        return in_array($u, ['g', 'kg'], true) ? 'mass' : (in_array($u, ['ml', 'cl', 'l'], true) ? 'volume' : 'count');
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
            // NUOVO: prodotti a pezzi senza peso (non dosabili a grammi o ml)
            'weight' => S::enum(['all', 'missing'])->default('all'),
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
        if ($q['weight'] === 'missing') {
            NonFood::needsWeightWhere($query, $cid);
        }
        $nfMap = NonFood::categoryMap($cid);
        $sortCol = self::SORTS[$q['sort'] ?? 'name'] ?? self::SORTS['name'];
        $total = (clone $query)->count();
        // come PostgreSQL: NULL in fondo in ordine crescente, in testa in ordine decrescente
        $rows = $query->orderByRaw("{$sortCol} IS NULL ".($q['dir'] === 'desc' ? 'DESC' : 'ASC'))->orderBy($sortCol, $q['dir'])->orderBy('i.id')
            ->limit($q['pageSize'])->offset(($q['page'] - 1) * $q['pageSize'])
            ->get(['i.id', 'i.code', 'i.name', 'i.category', 'i.supplier', 'i.package_content', 'i.package_unit', 'i.usage_unit', 'i.purchase_unit', 'i.edible_yield', 'i.archived_at', 'i.updated_at', 'i.unit_weight_kg', 'i.non_food',
                'p.package_price', 'p.package_content as price_content', 'p.package_unit as price_unit', 'p.valid_from']);

        return [
            'data' => $rows->map(function ($r) use ($showCosts, $cid, $nfMap) {
                $hasPrice = $r->package_price !== null;
                $nonFood = NonFood::effective($r->non_food === null ? null : (bool) $r->non_food, NonFood::isCategory($cid, $r->category, $nfMap));

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
                    'nonFood' => $nonFood,
                    'needsWeight' => ! $nonFood && $r->package_unit === 'pz' && $r->unit_weight_kg === null,
                    'price' => $showCosts ? [
                        'status' => $hasPrice ? (Dec::of($r->package_price)->isZero() ? 'zero' : 'ok') : 'missing',
                        'packagePrice' => $r->package_price,
                        'validFrom' => $r->valid_from,
                        'unitPrice' => $hasPrice ? self::unitPrice($r->package_price, $r->price_content, $r->price_unit) : null,
                        'baseUnit' => Units::BASE_UNIT[Units::dimensionOf($r->price_unit ?? $r->package_unit)],
                    ] : null,
                ];
            })->all(),
            'meta' => ['page' => $q['page'], 'pageSize' => $q['pageSize'], 'total' => $rows->isEmpty() ? 0 : $total, 'date' => $date,
                'missingWeight' => tap(DB::table('ingredients as i')->where('i.company_id', $cid)->whereNull('i.archived_at'), fn ($w) => NonFood::needsWeightWhere($w, $cid))->count()],
        ];
    }

    public function categories(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');

        return ['data' => DB::table('ingredients')->where('company_id', $ctx->companyId())->whereNotNull('category')->distinct()->orderBy('category')->pluck('category')->all()];
    }

    /** NUOVO — categorie con l'impostazione «non alimentare» (riconosciuta dal nome finché il titolare non la cambia). */
    public function categorySettings(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $cid = $ctx->companyId();
        $map = NonFood::categoryMap($cid);
        $counts = DB::table('ingredients')->where('company_id', $cid)->whereNull('archived_at')->whereNotNull('category')->groupBy('category')->pluck(DB::raw('COUNT(*)'), 'category');
        $names = [];
        foreach ($counts as $name => $n) {
            $names[mb_strtolower(trim($name))] = ['name' => $name, 'count' => (int) $n];
        }
        foreach (DB::table('ingredient_categories')->where('company_id', $cid)->pluck('name') as $name) {
            $names[mb_strtolower(trim($name))] ??= ['name' => $name, 'count' => 0];
        }
        $out = [];
        foreach ($names as $k => $v) {
            $out[] = [...$v, 'nonFood' => $map[$k]['nonFood'] ?? NonFood::guess($v['name']), 'auto' => $map[$k]['auto'] ?? true];
        }
        usort($out, fn ($a, $b) => strcasecmp($a['name'], $b['name']));

        return ['data' => $out];
    }

    public function updateCategorySetting(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage');
        $b = $this->parseBody($req, S::object(['name' => S::reqText('La categoria', 255), 'nonFood' => S::bool()]));
        $cid = $ctx->companyId();
        $row = DB::table('ingredient_categories')->where('company_id', $cid)->where('name', $b['name'])->first();
        if ($row) {
            DB::table('ingredient_categories')->where('id', $row->id)->update(['non_food' => $b['nonFood'], 'updated_at' => Clock::now()]);
        } else {
            DB::table('ingredient_categories')->insert(['id' => (string) Str::uuid(), 'company_id' => $cid, 'name' => $b['name'], 'non_food' => $b['nonFood'], 'updated_at' => Clock::now()]);
        }
        Audit::log($cid, $ctx->userId(), 'ingredient_category', null, 'non_food', ['category' => $b['name'], 'non_food' => $b['nonFood']]);

        return ['ok' => true];
    }

    /** NUOVO — prodotti doppi dello stesso fornitore, da unire. */
    public function duplicates(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage');

        return ['data' => \App\Services\Duplicates::find($ctx->companyId())];
    }

    public function merge(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage');
        $b = $this->parseBody($req, S::object(['groups' => S::array(S::object(['keepId' => S::uuid(), 'mergeIds' => S::array(S::uuid())->min(1)->max(50)]))->min(1)->max(2000)]));
        $cid = $ctx->companyId();
        $keepIds = array_column($b['groups'], 'keepId');
        $watch = ChangeAlerts::watch($cid, 'ingredients', $keepIds);
        $res = DB::transaction(function () use ($b, $cid, $ctx) {
            $t = ['groups' => 0, 'merged' => 0, 'prices' => 0, 'recipes' => 0];
            foreach ($b['groups'] as $g) {
                $r = \App\Services\Duplicates::merge($cid, $g['keepId'], $g['mergeIds'], $ctx->userId());
                $t['groups']++;
                $t['merged'] += count(array_diff(array_unique($g['mergeIds']), [$g['keepId']]));
                $t['prices'] += $r['prices'];
                $t['recipes'] += $r['recipes'];
            }

            return $t;
        });
        $affected = Costing::invalidate($cid, 'ingredients', $keepIds);
        ChangeAlerts::commit($watch, $ctx->userId(), ['label' => 'Prodotti doppi uniti', 'seenIngredients' => true]);

        return [...$res, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
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
                ->get(['p.id', 'p.package_price', 'p.package_content', 'p.package_unit', 'p.valid_from', 'p.source', 'p.supplier', 'p.agent_name', 'p.notes', 'p.created_at', 'p.import_id', 'p.supplier_invoice_id', 'u.name as created_by']))
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
            'nonFoodOverride' => $i->non_food === null ? null : (bool) $i->non_food,
            'categoryNonFood' => NonFood::isCategory($cid, $i->category),
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
            // NUOVO: variazioni di prezzo non ancora viste da questo utente
            'changes' => $showCosts ? ChangeAlerts::forEntity($cid, $ctx->userId(), 'ingredient', $id) : [],
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
                'non_food' => $body['nonFood'] ?? null,
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
        // NUOVO: updatePrices = la confezione era sbagliata (es. 1 pz invece di 24 pz): si corregge anche nei prezzi
        // registrati con la confezione di prima, lasciando invariato l'importo pagato.
        $body = $this->parseBody($req, self::ingredientBody()->extend(['code' => S::reqText('Il codice', 40), 'lockVersion' => S::int(), 'updatePrices' => S::bool()->default(false)]));
        self::checkConversions($body);
        $cid = $ctx->companyId();
        $watch = ChangeAlerts::watch($cid, 'ingredients', [$id]);
        $repriced = 0;
        $changes = DB::transaction(function () use ($ctx, $body, $cid, $id, &$repriced) {
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
            if (array_key_exists('nonFood', $body)) {
                $next['non_food'] = $body['nonFood'] === null ? null : ($body['nonFood'] ? 1 : 0);
            }
            $before = [];
            foreach (array_keys($next) as $k) {
                $before[$k] = Audit::normalizeNum($cur->{$k});
            }
            $changes = Audit::diff($before, array_map([Audit::class, 'normalizeNum'], $next));
            DB::table('ingredients')->where('id', $id)->update([...$next, 'updated_at' => Clock::now(), 'lock_version' => $cur->lock_version + 1]);
            $packChanged = ! Dec::of($cur->package_content)->eq(Dec::of($body['packageContent'])) || $cur->package_unit !== $body['packageUnit'];
            $dimChanged = self::dimension($cur->package_unit) !== self::dimension($body['packageUnit']);
            if ($dimChanged) {
                // NUOVO: cambio di tipo (es. da confezione di pezzi a «al litro»): tutti i prezzi registrati si convertono
                // con il peso del pezzo e la densità; l'importo pagato resta, cambia l'unità della confezione.
                $prices = DB::table('ingredient_prices')->where('company_id', $cid)->where('ingredient_id', $id)->get(['id', 'package_content', 'package_unit']);
                if ($prices->isNotEmpty() && ! $body['updatePrices']) {
                    throw new AppError(422, 'validation_failed', 'Cambiando il tipo di prezzo vanno convertiti anche i prezzi già registrati.', ['fields' => ['packageUnit' => 'Conferma la conversione dei prezzi registrati.']]);
                }
                $data = ['densityKgPerL' => $body['densityKgPerL'] !== null ? Dec::of($body['densityKgPerL']) : null, 'unitWeightKg' => $body['unitWeightKg'] !== null ? Dec::of($body['unitWeightKg']) : null];
                $target = Units::dimensionOf($body['packageUnit']);
                $perPackage = ! in_array(mb_strtolower((string) $body['purchaseUnit']), ['kg', 'litro', 'l'], true);
                foreach ($prices as $p) {
                    // il prezzo era per la confezione di prima (es. «1 pz» = un vaso) e si paga ancora a confezione
                    // (es. «vaso da 1700 g»): stesso importo per la nuova confezione, senza conversioni
                    if ($perPackage && $p->package_unit === $cur->package_unit && Dec::of($p->package_content)->eq(Dec::of($cur->package_content))) {
                        DB::table('ingredient_prices')->where('id', $p->id)->update(['package_content' => $body['packageContent'], 'package_unit' => $body['packageUnit']]);
                        $repriced++;

                        continue;
                    }
                    try {
                        $base = Units::convertToDimension(Dec::of($p->package_content), $p->package_unit, $target, $data);
                    } catch (\App\Domain\Costing\UnitConversionError $e) {
                        $needDensity = in_array('volume', [self::dimension($p->package_unit), $target], true) && ! ($data['densityKgPerL']?->gt(0));
                        throw new AppError(422, 'validation_failed', $needDensity
                            ? 'Per convertire i prezzi registrati serve la densità (kg per litro; per l\'acqua 1).'
                            : 'Per convertire i prezzi registrati serve quanto pesa o contiene un pezzo.', ['fields' => [$needDensity ? 'densityKgPerL' : 'unitWeightKg' => 'Serve per convertire i prezzi già registrati.']]);
                    }
                    $content = Units::fromBase($base, $body['packageUnit']);
                    if (! $content->gt(0)) {
                        throw new AppError(422, 'validation_failed', 'La conversione dei prezzi registrati dà una quantità nulla: controlla peso e densità.');
                    }
                    DB::table('ingredient_prices')->where('id', $p->id)->update(['package_content' => $content->toFixed(6), 'package_unit' => $body['packageUnit']]);
                    $repriced++;
                }
                if ($repriced) {
                    $changes['prices_package'] = ['from' => $cur->package_unit, 'to' => $body['packageUnit'], 'rows' => $repriced, 'converted' => true];
                }
            } elseif ($body['updatePrices'] && $packChanged) {
                $repriced = DB::table('ingredient_prices')->where('company_id', $cid)->where('ingredient_id', $id)
                    ->where('package_content', Dec::of($cur->package_content)->toFixed(6))->where('package_unit', $cur->package_unit)
                    ->update(['package_content' => $body['packageContent'], 'package_unit' => $body['packageUnit']]);
                if ($repriced) {
                    $changes['prices_package'] = ['from' => Audit::normalizeNum($cur->package_content).' '.$cur->package_unit, 'to' => Audit::normalizeNum($body['packageContent']).' '.$body['packageUnit'], 'rows' => $repriced];
                }
            }
            Audit::log($cid, $ctx->userId(), 'ingredient', $id, 'updated', $changes);

            return $changes;
        });
        $costRelevant = array_intersect(['edible_yield', 'density_kg_per_l', 'unit_weight_kg', 'prices_package'], array_keys($changes));
        $affected = $costRelevant ? Costing::invalidate($cid, 'ingredients', [$id]) : [];
        if ($costRelevant) {
            $label = $repriced ? 'Confezione o tipo di prezzo di «'.$body['name'].'» corretti anche nei prezzi registrati' : 'Dati di «'.$body['name'].'» modificati (resa, densità o peso)';
            ChangeAlerts::commit($watch, $ctx->userId(), ['label' => $label, 'seenIngredients' => true]);
        }

        return ['ok' => true, 'repricedPrices' => $repriced, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    /**
     * NUOVO — prezzi registrati con una confezione diversa da quella del prodotto (es. 12,06 € «per 1 pz»
     * mentre il cartone è da 24 pz): l'importo pagato resta, la confezione diventa quella del prodotto.
     */
    public function alignPrices(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'ingredients.manage', 'costs.read');
        $id = $this->uuid($id);
        $b = $this->parseBody($req, S::object(['fromContent' => S::dec(['gt' => 0, 'label' => 'La confezione']), 'fromUnit' => S::measureUnit()]));
        $cid = $ctx->companyId();
        $ing = DB::table('ingredients')->where('id', $id)->where('company_id', $cid)->first();
        if (! $ing) {
            throw AppError::notFound('Ingrediente');
        }
        if (self::dimension($b['fromUnit']) !== self::dimension($ing->package_unit)) {
            throw new AppError(422, 'validation_failed', 'Questi prezzi sono in un\'altra unità e non si possono convertire.');
        }
        $watch = ChangeAlerts::watch($cid, 'ingredients', [$id]);
        $n = DB::table('ingredient_prices')->where('company_id', $cid)->where('ingredient_id', $id)
            ->where('package_content', Dec::of($b['fromContent'])->toFixed(6))->where('package_unit', $b['fromUnit'])
            ->update(['package_content' => $ing->package_content, 'package_unit' => $ing->package_unit]);
        $affected = [];
        if ($n) {
            Audit::log($cid, $ctx->userId(), 'ingredient', $id, 'prices_aligned', ['prices_package' => ['from' => Audit::normalizeNum($b['fromContent']).' '.$b['fromUnit'], 'to' => Audit::normalizeNum($ing->package_content).' '.$ing->package_unit, 'rows' => $n]]);
            $affected = Costing::invalidate($cid, 'ingredients', [$id]);
            ChangeAlerts::commit($watch, $ctx->userId(), ['label' => 'Confezione di «'.$ing->name.'» corretta nei prezzi registrati', 'seenIngredients' => true]);
        }

        return ['ok' => true, 'updated' => $n, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
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
        $watch = ChangeAlerts::watch($cid, 'ingredients', [$id]);
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
        ChangeAlerts::commit($watch, $ctx->userId(), ['source' => $body['source'] ?? 'Prezzo inserito a mano', 'seenIngredients' => true]);

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
        $watch = ChangeAlerts::watch($cid, 'ingredients', [$id]);
        DB::table('ingredient_prices')->where('id', $priceId)->delete();
        Audit::log($cid, $ctx->userId(), 'ingredient_price', $priceId, 'deleted', ['packagePrice' => $p->package_price, 'validFrom' => $p->valid_from]);
        $affected = Costing::invalidate($cid, 'ingredients', [$id]);
        ChangeAlerts::commit($watch, $ctx->userId(), ['source' => 'Prezzo eliminato dallo storico', 'seenIngredients' => true]);

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
