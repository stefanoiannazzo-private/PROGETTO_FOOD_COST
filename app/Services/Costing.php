<?php

declare(strict_types=1);

namespace App\Services;

use App\Domain\Costing\Dec;
use App\Domain\Costing\Graph;
use App\Domain\Costing\RecipeCostEngine;
use App\Domain\Costing\Serializer;
use App\Support\Clock;
use Illuminate\Support\Facades\DB;

/**
 * Servizio dei costi (port di apps/api/src/services/costing.ts): grafo delle dipendenze, ricette interessate,
 * cache delle valorizzazioni, caricamento del contesto di calcolo alla data. Tutte le query sono delimitate all'azienda.
 *
 * Le LATERAL JOIN di PostgreSQL ("ultimo prezzo valido alla data") sono sostituite da una query ordinata
 * e dalla scelta della prima riga per elemento in PHP: stesso risultato, compatibile con MySQL e MariaDB.
 */
final class Costing
{
    public static function dn(mixed $v): ?Dec
    {
        return $v === null ? null : Dec::of((string) $v);
    }

    /* ======================= Grafo delle dipendenze ======================= */

    /** @return array<string, list<string>> archi padre → sottoricetta secondo le revisioni correnti */
    public static function loadEdges(string $companyId): array
    {
        $rows = DB::table('recipes as r')
            ->join('recipe_components as c', 'c.revision_id', '=', 'r.current_revision_id')
            ->where('r.company_id', $companyId)
            ->whereNotNull('c.sub_recipe_id')
            ->orderBy('c.position')
            ->get(['r.id as parent', 'c.sub_recipe_id as child']);
        $edges = [];
        foreach ($rows as $r) {
            $edges[$r->parent][] = $r->child;
        }

        return $edges;
    }

    /* ===================== Ricette interessate e cache ===================== */

    /**
     * Ricette che usano direttamente la risorsa (revisione corrente) più tutte quelle che ne dipendono.
     *
     * @param  'ingredients'|'equipment'|'tariffs'|'employees'|'recipes'  $type
     * @return list<string>
     */
    public static function affectedRecipes(string $companyId, string $type, array $ids): array
    {
        if (! $ids) {
            return [];
        }
        if ($type === 'recipes') {
            $direct = array_values($ids);
        } else {
            $q = DB::table('recipes as r');
            if ($type === 'ingredients') {
                $q->join('recipe_components as x', 'x.revision_id', '=', 'r.current_revision_id')->whereIn('x.ingredient_id', $ids);
            } elseif ($type === 'employees') {
                $q->join('recipe_labor as x', 'x.revision_id', '=', 'r.current_revision_id')->whereIn('x.employee_id', $ids);
            } else {
                $equipmentIds = $ids;
                if ($type === 'tariffs') {
                    $equipmentIds = DB::table('equipment')->where('company_id', $companyId)
                        ->where(fn ($w) => $w->whereIn('electric_tariff_id', $ids)->orWhereIn('gas_tariff_id', $ids))
                        ->pluck('id')->all();
                    if (! $equipmentIds) {
                        return [];
                    }
                }
                $q->join('recipe_equipment_uses as x', 'x.revision_id', '=', 'r.current_revision_id')->whereIn('x.equipment_id', $equipmentIds);
            }
            $direct = $q->where('r.company_id', $companyId)->distinct()->pluck('r.id')->all();
        }
        if (! $direct) {
            return [];
        }
        $edges = self::loadEdges($companyId);

        return array_values(array_unique([...$direct, ...Graph::dependentsOf($edges, $direct)]));
    }

    /** Invalida la cache delle valorizzazioni per le ricette interessate; restituisce i loro id. */
    public static function invalidate(string $companyId, string $type, array $ids): array
    {
        $affected = self::affectedRecipes($companyId, $type, $ids);
        if ($affected) {
            DB::table('recipe_cost_cache')->where('company_id', $companyId)->whereIn('recipe_id', $affected)->delete();
        }

        return $affected;
    }

    public static function describeRecipes(string $companyId, array $ids): array
    {
        if (! $ids) {
            return [];
        }

        return DB::table('recipes')->where('company_id', $companyId)->whereIn('id', $ids)->orderBy('title')
            ->get(['id', 'code', 'title', 'status'])->map(fn ($r) => (array) $r)->all();
    }

    /* ======================== Caricamento del contesto ======================== */

    /**
     * Tutto ciò che serve a valorizzare le ricette indicate alla data: chiusura delle sottoricette
     * (revisioni correnti), prezzi, tariffe e costi del lavoro validi alla data.
     */
    public static function loadContext(string $companyId, array $rootIds, string $date, ?array $draft = null): array
    {
        $edges = self::loadEdges($companyId);
        if ($draft) {
            $edges[$draft['id']] = array_values(array_map(fn ($c) => $c['recipeId'], array_filter($draft['components'], fn ($c) => ! empty($c['recipeId']))));
        }
        $closure = array_values(array_filter(Graph::descendantsOf($edges, $rootIds), fn ($id) => ! $draft || $id !== $draft['id']));

        $recipes = [];
        if ($draft) {
            $recipes[$draft['id']] = $draft;
        }
        if ($closure) {
            $heads = DB::table('recipes as r')
                ->join('recipe_revisions as v', 'v.id', '=', 'r.current_revision_id')
                ->where('r.company_id', $companyId)
                ->whereIn('r.id', $closure)
                ->get(['r.id', 'r.code', 'r.title', 'v.id as revision_id', 'v.number', 'v.final_quantity', 'v.final_unit', 'v.final_weight_kg', 'v.portions', 'v.declared_duration_minutes']);
            $parts = self::loadRevisionParts($companyId, $heads->pluck('revision_id')->all());
            foreach ($heads as $h) {
                $p = $parts[$h->revision_id] ?? ['phases' => [], 'components' => [], 'equipmentUses' => [], 'laborAssignments' => []];
                $recipes[$h->id] = [
                    'id' => $h->id,
                    'revisionId' => $h->revision_id,
                    'revisionNumber' => (int) $h->number,
                    'code' => $h->code,
                    'title' => $h->title,
                    'finalQuantity' => self::dn($h->final_quantity),
                    'finalUnit' => $h->final_unit,
                    'finalWeightKg' => self::dn($h->final_weight_kg),
                    'portions' => self::dn($h->portions),
                    'declaredDurationMinutes' => self::dn($h->declared_duration_minutes),
                    ...$p,
                ];
            }
        }

        $ingredientIds = $equipmentIds = $employeeIds = [];
        foreach ($recipes as $r) {
            foreach ($r['components'] as $c) {
                if (! empty($c['ingredientId'])) {
                    $ingredientIds[$c['ingredientId']] = true;
                }
            }
            foreach ($r['equipmentUses'] as $u) {
                $equipmentIds[$u['equipmentId']] = true;
            }
            foreach ($r['laborAssignments'] as $a) {
                $employeeIds[$a['employeeId']] = true;
            }
        }
        $ingredients = self::loadIngredients($companyId, array_keys($ingredientIds), $date);
        $equipment = self::loadEquipment($companyId, array_keys($equipmentIds));
        $employees = self::loadEmployees($companyId, array_keys($employeeIds), $date);
        $tariffIds = [];
        foreach ($equipment as $e) {
            foreach ([$e['electric']['tariffId'] ?? null, $e['gas']['tariffId'] ?? null] as $t) {
                if (is_string($t) && $t !== '') {
                    $tariffIds[$t] = true;
                }
            }
        }
        $tariffs = self::loadTariffs($companyId, array_keys($tariffIds), $date);

        return ['date' => $date, 'recipes' => $recipes, 'ingredients' => $ingredients, 'equipment' => $equipment, 'tariffs' => $tariffs, 'employees' => $employees];
    }

    /** @return array<string, array{phases: list, components: list, equipmentUses: list, laborAssignments: list}> */
    public static function loadRevisionParts(string $companyId, array $revIds): array
    {
        $out = [];
        if (! $revIds) {
            return $out;
        }
        foreach ($revIds as $id) {
            $out[$id] = ['phases' => [], 'components' => [], 'equipmentUses' => [], 'laborAssignments' => []];
        }
        $q = fn (string $t) => DB::table($t)->where('company_id', $companyId)->whereIn('revision_id', $revIds)->orderBy('position')->get();
        foreach ($q('recipe_phases') as $p) {
            $out[$p->revision_id]['phases'][] = ['id' => $p->id, 'name' => $p->name, 'position' => (int) $p->position];
        }
        foreach ($q('recipe_components') as $c) {
            $out[$c->revision_id]['components'][] = [
                'id' => $c->id,
                'kind' => $c->ingredient_id ? 'ingredient' : 'recipe',
                'ingredientId' => $c->ingredient_id,
                'recipeId' => $c->sub_recipe_id,
                'quantity' => Dec::of($c->quantity ?? '0'),
                'unit' => $c->unit,
                'note' => $c->note,
            ];
        }
        foreach ($q('recipe_equipment_uses') as $u) {
            $out[$u->revision_id]['equipmentUses'][] = [
                'id' => $u->id,
                'equipmentId' => $u->equipment_id,
                'phaseId' => $u->phase_id,
                'segment' => $u->segment,
                'minutes' => Dec::of($u->minutes ?? '0'),
                'share' => Dec::of($u->share),
                'sources' => $u->sources !== null ? json_decode($u->sources, true) : null,
                'measuredElectricKwh' => self::dn($u->measured_electric_kwh),
                'measuredGasQuantity' => self::dn($u->measured_gas_quantity),
                'measuredGasUnit' => $u->measured_gas_unit,
            ];
        }
        foreach ($q('recipe_labor') as $a) {
            $out[$a->revision_id]['laborAssignments'][] = [
                'id' => $a->id,
                'employeeId' => $a->employee_id,
                'phaseId' => $a->phase_id,
                'activeMinutes' => Dec::of($a->active_minutes ?? '0'),
                'share' => Dec::of($a->share),
            ];
        }

        return $out;
    }

    /** Ultima voce valida alla data per ciascun elemento: array id => riga. */
    public static function latestAt(string $table, string $fk, array $ids, string $date, array $cols = ['*']): array
    {
        $out = [];
        if (! $ids) {
            return $out;
        }
        $rows = DB::table($table)->whereIn($fk, $ids)->where('valid_from', '<=', $date)
            ->orderBy($fk)->orderByDesc('valid_from')->get($cols);
        foreach ($rows as $r) {
            $out[$r->{$fk}] ??= $r;
        }

        return $out;
    }

    private static function loadIngredients(string $companyId, array $ids, string $date): array
    {
        $map = [];
        if (! $ids) {
            return $map;
        }
        $rows = DB::table('ingredients')->where('company_id', $companyId)->whereIn('id', $ids)
            ->get(['id', 'code', 'name', 'package_content', 'package_unit', 'edible_yield', 'density_kg_per_l', 'unit_weight_kg']);
        $prices = self::latestAt('ingredient_prices', 'ingredient_id', $ids, $date, ['id', 'ingredient_id', 'package_price', 'package_content', 'package_unit', 'valid_from']);
        foreach ($rows as $r) {
            $p = $prices[$r->id] ?? null;
            $map[$r->id] = [
                'id' => $r->id,
                'code' => $r->code,
                'name' => $r->name,
                'packageUnit' => $p ? $p->package_unit : $r->package_unit,
                'packageContent' => Dec::of($p ? $p->package_content : $r->package_content),
                'packagePrice' => $p ? Dec::of($p->package_price) : null,
                'priceId' => $p?->id,
                'priceValidFrom' => $p?->valid_from,
                'edibleYield' => Dec::of($r->edible_yield),
                'densityKgPerL' => self::dn($r->density_kg_per_l),
                'unitWeightKg' => self::dn($r->unit_weight_kg),
            ];
        }

        return $map;
    }

    private static function loadEquipment(string $companyId, array $ids): array
    {
        $map = [];
        if (! $ids) {
            return $map;
        }
        foreach (DB::table('equipment')->where('company_id', $companyId)->whereIn('id', $ids)->get() as $e) {
            $map[$e->id] = self::equipmentToInput($e);
        }

        return $map;
    }

    public static function equipmentToInput(object $e): array
    {
        $hasElectric = $e->power_type === 'electric' || $e->power_type === 'mixed';
        $hasGas = $e->power_type === 'gas' || $e->power_type === 'mixed';

        return [
            'id' => $e->id,
            'code' => $e->code,
            'name' => $e->name,
            'powerType' => $e->power_type,
            'electric' => $hasElectric ? [
                'powerKw' => self::dn($e->electric_power_kw),
                'usageCoefficient' => self::dn($e->usage_coefficient),
                'preheatCoefficient' => self::dn($e->preheat_coefficient),
                'holdCoefficient' => self::dn($e->hold_coefficient),
                'tariffId' => $e->electric_tariff_id,
            ] : null,
            'gas' => $hasGas ? [
                'mode' => $e->gas_mode ?? 'flow',
                'flowPerHour' => self::dn($e->gas_flow_per_hour),
                'flowUnit' => $e->gas_flow_unit,
                'powerKw' => self::dn($e->gas_power_kw),
                'loadFactor' => self::dn($e->gas_load_factor),
                'tariffId' => $e->gas_tariff_id,
            ] : null,
        ];
    }

    private static function loadTariffs(string $companyId, array $ids, string $date): array
    {
        $map = [];
        if (! $ids) {
            return $map;
        }
        $tariffs = DB::table('utility_tariffs')->where('company_id', $companyId)->whereIn('id', $ids)->get(['id', 'name', 'kind', 'unit']);
        $versions = self::latestAt('tariff_versions', 'tariff_id', $ids, $date, ['id', 'tariff_id', 'price_per_unit', 'valid_from', 'm3_to_smc', 'smc_to_kwh']);
        foreach ($tariffs as $t) {
            $v = $versions[$t->id] ?? null;
            if (! $v) {
                continue; // nessuna versione valida alla data (INNER JOIN nell'originale)
            }
            $map[$t->id] = [
                'id' => $t->id,
                'name' => $t->name,
                'kind' => $t->kind,
                'unit' => $t->unit,
                'pricePerUnit' => Dec::of($v->price_per_unit),
                'versionId' => $v->id,
                'validFrom' => $v->valid_from,
                'm3ToSmc' => self::dn($v->m3_to_smc),
                'smcToKwh' => self::dn($v->smc_to_kwh),
            ];
        }

        return $map;
    }

    public static function loadEmployees(string $companyId, array $ids, string $date): array
    {
        $map = [];
        if (! $ids) {
            return $map;
        }
        $emps = DB::table('employees')->where('company_id', $companyId)->whereIn('id', $ids)->get(['id', 'code', 'first_name', 'last_name']);
        $configs = self::latestAt('employee_cost_configs', 'employee_id', $ids, $date);
        foreach ($emps as $e) {
            $c = $configs[$e->id] ?? null;
            if (! $c) {
                continue; // senza configurazione valida: errore missing_labor_cost nel motore
            }
            $map[$e->id] = [
                'employeeId' => $e->id,
                'code' => $e->code,
                'name' => "{$e->first_name} {$e->last_name}",
                'configId' => $c->id,
                'grossMonthly' => Dec::of($c->gross_monthly),
                'extraMonthly' => self::dn($c->extra_monthly),
                'monthsPaid' => $c->months_paid !== null ? (int) $c->months_paid : null,
                'extraMonths' => $c->extra_months !== null ? (int) $c->extra_months : null,
                'contributionsMode' => $c->contributions_mode,
                'contributionsValue' => self::dn($c->contributions_value),
                'otherMonthlyCosts' => self::dn($c->other_monthly_costs),
                'productiveHours' => Dec::of($c->productive_hours),
            ];
        }

        return $map;
    }

    /* ======================= Valorizzazione corrente ======================= */

    /**
     * Valorizzazione corrente con cache per (ricetta, data). Le ricette mancanti in cache sono calcolate
     * insieme, con un solo caricamento di contesto, e tutte le ricette della chiusura entrano in cache.
     *
     * @return array<string, array> id => valorizzazione serializzata
     */
    public static function currentValuations(string $companyId, array $recipeIds, string $date): array
    {
        $out = [];
        if (! $recipeIds) {
            return $out;
        }
        $cached = DB::table('recipe_cost_cache as k')
            ->join('recipes as r', 'r.id', '=', 'k.recipe_id')
            ->where('k.company_id', $companyId)->where('k.valuation_date', $date)->whereIn('k.recipe_id', $recipeIds)
            ->get(['k.recipe_id', 'k.data', 'k.revision_id', 'r.current_revision_id']);
        foreach ($cached as $c) {
            if ($c->revision_id === $c->current_revision_id) {
                $out[$c->recipe_id] = json_decode($c->data, true);
            }
        }
        $missing = array_values(array_filter($recipeIds, fn ($id) => ! isset($out[$id])));
        if (! $missing) {
            return $out;
        }

        $ctx = self::loadContext($companyId, $missing, $date);
        $engine = new RecipeCostEngine($ctx);
        $rows = [];
        foreach (array_keys($ctx['recipes']) as $id) {
            $r = $engine->value((string) $id);
            $s = Serializer::serialize($r);
            if (in_array($r['recipeId'], $recipeIds, true)) {
                $out[$r['recipeId']] = $s;
            }
            $rows[] = [
                'company_id' => $companyId,
                'recipe_id' => $r['recipeId'],
                'valuation_date' => $date,
                'revision_id' => $r['revisionId'],
                'complete' => $r['complete'],
                'total' => self::fit($s['total']),
                'cost_per_kg' => self::fit($s['costPerKg']),
                'cost_per_portion' => self::fit($s['costPerPortion']),
                'error_count' => count(array_filter($r['issues'], fn ($i) => $i['severity'] === 'error')),
                'data' => json_encode($s, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                'computed_at' => Clock::now(),
            ];
        }
        if ($rows) {
            DB::table('recipe_cost_cache')->upsert($rows, ['recipe_id', 'valuation_date'], ['revision_id', 'complete', 'total', 'cost_per_kg', 'cost_per_portion', 'error_count', 'data', 'computed_at']);
        }

        return $out;
    }

    /** Valorizzazione non memorizzata (data diversa, anteprima, snapshot). */
    public static function computeValuation(string $companyId, string $recipeId, string $date, ?array $draft = null): array
    {
        $ctx = self::loadContext($companyId, [$recipeId], $date, $draft);

        return (new RecipeCostEngine($ctx))->value($recipeId);
    }

    /** Un importo per una colonna DECIMAL(18,6): arrotondato a 6 decimali come fa NUMERIC(18,6) di PostgreSQL. */
    public static function fit(?string $v): ?string
    {
        return $v === null ? null : Dec::of($v)->toFixed(6);
    }
}
