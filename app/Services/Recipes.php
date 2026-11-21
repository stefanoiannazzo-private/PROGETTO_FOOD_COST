<?php

declare(strict_types=1);

namespace App\Services;

use App\Domain\Costing\Dec;
use App\Domain\Costing\Graph;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Validation\S;
use App\Support\Validation\Schema;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Revisioni delle ricette: schemi, controlli, salvataggio e formato editor (port di services/recipes.ts). */
final class Recipes
{
    /** Verità "alla JavaScript" per i valori dei form: "0" è vero, solo null/""/assente sono falsi. */
    public static function t(mixed $v): bool
    {
        return $v !== null && $v !== '' && $v !== false && ! $v instanceof \App\Support\Validation\Missing;
    }

    private static function percent(string $label): Schema
    {
        return S::decOpt(['gt' => 0, 'max' => 100, 'label' => $label])->transform(fn ($v) => $v ?? '100');
    }

    /** Composizione di una revisione come arriva dall'editor. Le fasi sono referenziate con chiavi locali. */
    public static function revisionBody(): Schema
    {
        return S::object([
            'instructions' => S::optText(20000),
            'finalQuantity' => S::decOpt(['gt' => 0, 'label' => 'La quantità finale']),
            'finalUnit' => S::measureUnit()->nullable()->optional(),
            'finalWeightKg' => S::decOpt(['gt' => 0, 'label' => 'Il peso finale netto']),
            'portions' => S::decOpt(['gt' => 0, 'label' => 'Il numero di porzioni']),
            'declaredDurationMinutes' => S::decOpt(['gt' => 0, 'label' => 'La durata complessiva']),
            'yieldNotes' => S::optText(2000),
            'phases' => S::array(S::object([
                'key' => S::string()->min(1)->max(60),
                'name' => S::reqText('Il nome della fase', 120),
                'description' => S::optText(2000),
                'startOffsetMinutes' => S::decOpt(['min' => 0, 'label' => 'L’inizio della fase']),
                'durationMinutes' => S::decOpt(['gt' => 0, 'label' => 'La durata della fase']),
            ]))->max(50)->default([]),
            'components' => S::array(
                S::object([
                    'kind' => S::enum(['ingredient', 'recipe']),
                    'ingredientId' => S::uuid()->nullable()->optional(),
                    'recipeId' => S::uuid()->nullable()->optional(),
                    'quantity' => S::decOpt(['gt' => 0, 'label' => 'La quantità']),
                    'unit' => S::measureUnit(),
                    'note' => S::optText(300),
                ])->refine(
                    fn ($c) => ($c['kind'] ?? null) === 'ingredient'
                        ? self::t($c['ingredientId'] ?? null) && ! self::t($c['recipeId'] ?? null)
                        : self::t($c['recipeId'] ?? null) && ! self::t($c['ingredientId'] ?? null),
                    'Ogni riga deve riferirsi a un ingrediente oppure a una ricetta.',
                ),
            )->max(300)->default([]),
            'equipmentUses' => S::array(S::object([
                'phaseKey' => S::string()->max(60)->nullable()->optional(),
                'equipmentId' => S::uuid(),
                'segment' => S::enum(['preheat', 'work', 'hold'])->default('work'),
                'minutes' => S::decOpt(['gt' => 0, 'label' => 'La durata d’uso']),
                'sharePercent' => self::percent('La quota di imputazione'),
                'sources' => S::array(S::enum(['electric', 'gas']))->nullable()->optional(),
                'measuredElectricKwh' => S::decOpt(['min' => 0, 'label' => 'Il consumo elettrico misurato']),
                'measuredGasQuantity' => S::decOpt(['min' => 0, 'label' => 'Il consumo gas misurato']),
                'measuredGasUnit' => S::enum(['kwh', 'm3', 'smc'])->nullable()->optional(),
                'note' => S::optText(300),
            ]))->max(200)->default([]),
            'labor' => S::array(S::object([
                'phaseKey' => S::string()->max(60)->nullable()->optional(),
                'employeeId' => S::uuid(),
                'activeMinutes' => S::decOpt(['gt' => 0, 'label' => 'I minuti attivi']),
                'sharePercent' => self::percent('La quota di imputazione'),
                'note' => S::optText(300),
            ]))->max(200)->default([]),
        ]);
    }

    public static function recipeHeader(): Schema
    {
        return S::object([
            'code' => S::optText(40),
            'title' => S::reqText('Il titolo', 160),
            'category' => S::optText(80),
            'description' => S::optText(4000),
            'status' => S::enum(['draft', 'active'])->default('draft'),
        ]);
    }

    /** Verifica che tutti i riferimenti appartengano all'azienda e che non si creino cicli. */
    public static function validateRevision(string $companyId, ?string $recipeId, array $rev): void
    {
        $phaseKeys = array_column($rev['phases'], 'key');
        if (count(array_unique($phaseKeys)) !== count($rev['phases'])) {
            throw AppError::badRequest('validation_failed', 'Chiavi di fase duplicate.');
        }
        foreach ($rev['equipmentUses'] as $i => $u) {
            if (self::t($u['phaseKey'] ?? null) && ! in_array($u['phaseKey'], $phaseKeys, true)) {
                throw AppError::badRequest('validation_failed', 'Uso strumento collegato a una fase inesistente.', ['fields' => ["equipmentUses.{$i}.phaseKey" => 'Fase inesistente.']]);
            }
        }
        foreach ($rev['labor'] as $i => $a) {
            if (self::t($a['phaseKey'] ?? null) && ! in_array($a['phaseKey'], $phaseKeys, true)) {
                throw AppError::badRequest('validation_failed', 'Manodopera collegata a una fase inesistente.', ['fields' => ["labor.{$i}.phaseKey" => 'Fase inesistente.']]);
            }
        }
        foreach ($rev['equipmentUses'] as $i => $u) {
            if (self::t($u['measuredGasQuantity'] ?? null) && ! self::t($u['measuredGasUnit'] ?? null)) {
                throw AppError::badRequest('validation_failed', 'Indica l’unità del consumo gas misurato.', ['fields' => ["equipmentUses.{$i}.measuredGasUnit" => 'Obbligatoria.']]);
            }
        }

        $uniq = fn (array $xs) => array_values(array_unique(array_filter($xs, fn ($x) => self::t($x))));
        $ingIds = $uniq(array_map(fn ($c) => $c['ingredientId'] ?? null, $rev['components']));
        $recIds = $uniq(array_map(fn ($c) => $c['recipeId'] ?? null, $rev['components']));
        $eqIds = $uniq(array_column($rev['equipmentUses'], 'equipmentId'));
        $empIds = $uniq(array_column($rev['labor'], 'employeeId'));
        $count = fn (string $table, array $ids) => $ids ? DB::table($table)->where('company_id', $companyId)->whereIn('id', $ids)->count() : 0;
        // Riferimenti di altre aziende risultano semplicemente inesistenti.
        if ($count('ingredients', $ingIds) !== count($ingIds)) {
            throw AppError::badRequest('invalid_reference', 'Uno o più ingredienti non esistono in questa azienda.');
        }
        if ($count('recipes', $recIds) !== count($recIds)) {
            throw AppError::badRequest('invalid_reference', 'Una o più sottoricette non esistono in questa azienda.');
        }
        if ($count('equipment', $eqIds) !== count($eqIds)) {
            throw AppError::badRequest('invalid_reference', 'Uno o più strumenti non esistono in questa azienda.');
        }
        if ($count('employees', $empIds) !== count($empIds)) {
            throw AppError::badRequest('invalid_reference', 'Uno o più dipendenti non esistono in questa azienda.');
        }

        if ($recipeId && $recIds) {
            $cycle = Graph::findCycle(Costing::loadEdges($companyId), $recipeId, $recIds);
            if ($cycle) {
                $byId = DB::table('recipes')->where('company_id', $companyId)->whereIn('id', array_unique($cycle))->pluck('title', 'id')->all();
                $path = array_map(fn ($id) => $byId[$id] ?? $id, $cycle);
                throw AppError::conflict('cycle', 'Inserimento non ammesso: si creerebbe un ciclo ('.implode(' → ', $path).').', ['path' => $path]);
            }
        }
    }

    /** Crea una nuova revisione immutabile e la imposta come corrente. @return array{id: string, number: int} */
    public static function insertRevision(string $companyId, ?string $userId, string $recipeId, array $rev): array
    {
        $number = (int) (DB::table('recipe_revisions')->where('recipe_id', $recipeId)->max('number') ?? 0) + 1;
        $revId = (string) Str::uuid();
        $now = Clock::now();
        DB::table('recipe_revisions')->insert([
            'id' => $revId,
            'company_id' => $companyId,
            'recipe_id' => $recipeId,
            'number' => $number,
            'instructions' => $rev['instructions'] ?? null,
            'final_quantity' => $rev['finalQuantity'] ?? null,
            'final_unit' => $rev['finalUnit'] ?? null,
            'final_weight_kg' => $rev['finalWeightKg'] ?? null,
            'portions' => $rev['portions'] ?? null,
            'declared_duration_minutes' => $rev['declaredDurationMinutes'] ?? null,
            'yield_notes' => $rev['yieldNotes'] ?? null,
            'created_by' => $userId,
            'created_at' => $now,
        ]);
        $phaseIds = [];
        foreach ($rev['phases'] as $i => $p) {
            $pid = (string) Str::uuid();
            DB::table('recipe_phases')->insert([
                'id' => $pid,
                'company_id' => $companyId,
                'revision_id' => $revId,
                'position' => $i,
                'name' => $p['name'],
                'description' => $p['description'] ?? null,
                'start_offset_minutes' => $p['startOffsetMinutes'] ?? null,
                'duration_minutes' => $p['durationMinutes'] ?? null,
            ]);
            $phaseIds[$p['key']] = $pid;
        }
        if ($rev['components']) {
            DB::table('recipe_components')->insert(array_map(fn ($c, $i) => [
                'id' => (string) Str::uuid(),
                'company_id' => $companyId,
                'revision_id' => $revId,
                'position' => $i,
                'ingredient_id' => $c['kind'] === 'ingredient' ? $c['ingredientId'] : null,
                'sub_recipe_id' => $c['kind'] === 'recipe' ? $c['recipeId'] : null,
                'quantity' => $c['quantity'] ?? null,
                'unit' => $c['unit'],
                'note' => $c['note'] ?? null,
            ], $rev['components'], array_keys($rev['components'])));
        }
        if ($rev['equipmentUses']) {
            DB::table('recipe_equipment_uses')->insert(array_map(fn ($u, $i) => [
                'id' => (string) Str::uuid(),
                'company_id' => $companyId,
                'revision_id' => $revId,
                'phase_id' => self::t($u['phaseKey'] ?? null) ? $phaseIds[$u['phaseKey']] : null,
                'position' => $i,
                'equipment_id' => $u['equipmentId'],
                'segment' => $u['segment'],
                'minutes' => $u['minutes'] ?? null,
                'share' => Dec::of($u['sharePercent'])->div(100)->toFixed(),
                'sources' => ! empty($u['sources']) ? json_encode($u['sources']) : null,
                'measured_electric_kwh' => $u['measuredElectricKwh'] ?? null,
                'measured_gas_quantity' => $u['measuredGasQuantity'] ?? null,
                'measured_gas_unit' => self::t($u['measuredGasQuantity'] ?? null) ? ($u['measuredGasUnit'] ?? null) : null,
                'note' => $u['note'] ?? null,
            ], $rev['equipmentUses'], array_keys($rev['equipmentUses'])));
        }
        if ($rev['labor']) {
            DB::table('recipe_labor')->insert(array_map(fn ($a, $i) => [
                'id' => (string) Str::uuid(),
                'company_id' => $companyId,
                'revision_id' => $revId,
                'phase_id' => self::t($a['phaseKey'] ?? null) ? $phaseIds[$a['phaseKey']] : null,
                'position' => $i,
                'employee_id' => $a['employeeId'],
                'active_minutes' => $a['activeMinutes'] ?? null,
                'share' => Dec::of($a['sharePercent'])->div(100)->toFixed(),
                'note' => $a['note'] ?? null,
            ], $rev['labor'], array_keys($rev['labor'])));
        }
        DB::table('recipes')->where('id', $recipeId)->update(['current_revision_id' => $revId, 'updated_at' => $now]);

        return ['id' => $revId, 'number' => $number];
    }

    /** Converte una revisione dell'editor (non salvata) in input del motore, per l'anteprima. */
    public static function draftToInput(string $recipeId, string $title, string $code, array $rev): array
    {
        $phaseIds = [];
        foreach ($rev['phases'] as $p) {
            $phaseIds[$p['key']] = 'phase:'.$p['key'];
        }
        $opt = fn ($v) => self::t($v) ? Dec::of($v) : null;

        return [
            'id' => $recipeId,
            'revisionId' => 'draft',
            'code' => $code,
            'title' => $title,
            'finalQuantity' => $opt($rev['finalQuantity'] ?? null),
            'finalUnit' => $rev['finalUnit'] ?? null,
            'finalWeightKg' => $opt($rev['finalWeightKg'] ?? null),
            'portions' => $opt($rev['portions'] ?? null),
            'declaredDurationMinutes' => $opt($rev['declaredDurationMinutes'] ?? null),
            'phases' => array_map(fn ($p, $i) => ['id' => $phaseIds[$p['key']], 'name' => $p['name'], 'position' => $i], $rev['phases'], array_keys($rev['phases'])),
            'components' => array_map(fn ($c, $i) => [
                'id' => "c{$i}",
                'kind' => $c['kind'],
                'ingredientId' => $c['kind'] === 'ingredient' ? ($c['ingredientId'] ?? null) : null,
                'recipeId' => $c['kind'] === 'recipe' ? ($c['recipeId'] ?? null) : null,
                'quantity' => Dec::of($c['quantity'] ?? '0'),
                'unit' => $c['unit'],
            ], $rev['components'], array_keys($rev['components'])),
            'equipmentUses' => array_map(fn ($u, $i) => [
                'id' => "u{$i}",
                'equipmentId' => $u['equipmentId'],
                'phaseId' => self::t($u['phaseKey'] ?? null) ? ($phaseIds[$u['phaseKey']] ?? null) : null,
                'segment' => $u['segment'],
                'minutes' => Dec::of($u['minutes'] ?? '0'),
                'share' => Dec::of($u['sharePercent'])->div(100),
                'sources' => $u['sources'] ?? null,
                'measuredElectricKwh' => $opt($u['measuredElectricKwh'] ?? null),
                'measuredGasQuantity' => $opt($u['measuredGasQuantity'] ?? null),
                'measuredGasUnit' => $u['measuredGasUnit'] ?? null,
            ], $rev['equipmentUses'], array_keys($rev['equipmentUses'])),
            'laborAssignments' => array_map(fn ($a, $i) => [
                'id' => "l{$i}",
                'employeeId' => $a['employeeId'],
                'phaseId' => self::t($a['phaseKey'] ?? null) ? ($phaseIds[$a['phaseKey']] ?? null) : null,
                'activeMinutes' => Dec::of($a['activeMinutes'] ?? '0'),
                'share' => Dec::of($a['sharePercent'])->div(100),
            ], $rev['labor'], array_keys($rev['labor'])),
        ];
    }

    /** Revisione in formato editor, con i nomi delle risorse collegate. */
    public static function loadRevisionForm(string $companyId, string $revisionId): array
    {
        $rev = DB::table('recipe_revisions')->where('id', $revisionId)->where('company_id', $companyId)->first();
        if (! $rev) {
            throw AppError::notFound('Revisione');
        }
        $phases = DB::table('recipe_phases')->where('revision_id', $revisionId)->orderBy('position')->get();
        $comps = DB::table('recipe_components as c')
            ->leftJoin('ingredients as i', 'i.id', '=', 'c.ingredient_id')
            ->leftJoin('recipes as r', 'r.id', '=', 'c.sub_recipe_id')
            ->leftJoin('recipe_revisions as rv', 'rv.id', '=', 'r.current_revision_id')
            ->where('c.revision_id', $revisionId)->orderBy('c.position')
            ->get(['c.id', 'c.ingredient_id', 'c.sub_recipe_id', 'c.quantity', 'c.unit', 'c.note', 'i.code as ing_code', 'i.name as ing_name', 'i.usage_unit', 'i.package_unit', 'i.archived_at as ing_archived',
                'r.code as rec_code', 'r.title as rec_title', 'r.status as rec_status', 'rv.final_unit as rec_final_unit', 'rv.final_weight_kg as rec_final_weight']);
        $uses = DB::table('recipe_equipment_uses as u')->join('equipment as e', 'e.id', '=', 'u.equipment_id')
            ->where('u.revision_id', $revisionId)->orderBy('u.position')
            ->get(['u.id', 'u.phase_id', 'u.equipment_id', 'u.segment', 'u.minutes', 'u.share', 'u.sources', 'u.measured_electric_kwh', 'u.measured_gas_quantity', 'u.measured_gas_unit', 'u.note', 'e.name', 'e.code', 'e.power_type']);
        $labor = DB::table('recipe_labor as a')->join('employees as e', 'e.id', '=', 'a.employee_id')
            ->where('a.revision_id', $revisionId)->orderBy('a.position')
            ->get(['a.id', 'a.phase_id', 'a.employee_id', 'a.active_minutes', 'a.share', 'a.note', 'e.first_name', 'e.last_name', 'e.code', 'e.job_title']);
        $pct = fn ($v) => Dec::of($v)->times(100)->toFixed();

        return [
            'id' => $rev->id,
            'number' => (int) $rev->number,
            'createdAt' => Clock::iso($rev->created_at),
            'instructions' => $rev->instructions,
            'finalQuantity' => $rev->final_quantity,
            'finalUnit' => $rev->final_unit,
            'finalWeightKg' => $rev->final_weight_kg,
            'portions' => $rev->portions,
            'declaredDurationMinutes' => $rev->declared_duration_minutes,
            'yieldNotes' => $rev->yield_notes,
            'phases' => $phases->map(fn ($p) => ['key' => $p->id, 'name' => $p->name, 'description' => $p->description, 'startOffsetMinutes' => $p->start_offset_minutes, 'durationMinutes' => $p->duration_minutes])->all(),
            'components' => $comps->map(fn ($c) => [
                'id' => $c->id,
                'kind' => $c->ingredient_id ? 'ingredient' : 'recipe',
                'ingredientId' => $c->ingredient_id,
                'recipeId' => $c->sub_recipe_id,
                'quantity' => $c->quantity,
                'unit' => $c->unit,
                'note' => $c->note,
                'ref' => $c->ingredient_id
                    ? ['code' => $c->ing_code, 'name' => $c->ing_name, 'usageUnit' => $c->usage_unit, 'packageUnit' => $c->package_unit, 'archived' => $c->ing_archived !== null]
                    : ['code' => $c->rec_code, 'name' => $c->rec_title, 'status' => $c->rec_status, 'finalUnit' => $c->rec_final_unit, 'hasFinalWeight' => $c->rec_final_weight !== null],
            ])->all(),
            'equipmentUses' => $uses->map(fn ($u) => [
                'id' => $u->id,
                'phaseKey' => $u->phase_id,
                'equipmentId' => $u->equipment_id,
                'segment' => $u->segment,
                'minutes' => $u->minutes,
                'sharePercent' => $pct($u->share),
                'sources' => $u->sources !== null ? json_decode($u->sources, true) : null,
                'measuredElectricKwh' => $u->measured_electric_kwh,
                'measuredGasQuantity' => $u->measured_gas_quantity,
                'measuredGasUnit' => $u->measured_gas_unit,
                'note' => $u->note,
                'ref' => ['code' => $u->code, 'name' => $u->name, 'powerType' => $u->power_type],
            ])->all(),
            'labor' => $labor->map(fn ($a) => [
                'id' => $a->id,
                'phaseKey' => $a->phase_id,
                'employeeId' => $a->employee_id,
                'activeMinutes' => $a->active_minutes,
                'sharePercent' => $pct($a->share),
                'note' => $a->note,
                'ref' => ['code' => $a->code, 'name' => "{$a->first_name} {$a->last_name}", 'jobTitle' => $a->job_title],
            ])->all(),
        ];
    }

    /** Converte la revisione salvata nel formato di ingresso dell'editor (per la duplicazione). */
    public static function formToBody(array $form): array
    {
        return [
            'instructions' => $form['instructions'],
            'finalQuantity' => $form['finalQuantity'],
            'finalUnit' => $form['finalUnit'],
            'finalWeightKg' => $form['finalWeightKg'],
            'portions' => $form['portions'],
            'declaredDurationMinutes' => $form['declaredDurationMinutes'],
            'yieldNotes' => $form['yieldNotes'],
            'phases' => array_map(fn ($p) => ['key' => $p['key'], 'name' => $p['name'], 'description' => $p['description'], 'startOffsetMinutes' => $p['startOffsetMinutes'], 'durationMinutes' => $p['durationMinutes']], $form['phases']),
            'components' => array_map(fn ($c) => ['kind' => $c['kind'], 'ingredientId' => $c['ingredientId'], 'recipeId' => $c['recipeId'], 'quantity' => $c['quantity'], 'unit' => $c['unit'], 'note' => $c['note']], $form['components']),
            'equipmentUses' => array_map(fn ($u) => [
                'phaseKey' => $u['phaseKey'], 'equipmentId' => $u['equipmentId'], 'segment' => $u['segment'], 'minutes' => $u['minutes'], 'sharePercent' => $u['sharePercent'],
                'sources' => $u['sources'], 'measuredElectricKwh' => $u['measuredElectricKwh'], 'measuredGasQuantity' => $u['measuredGasQuantity'], 'measuredGasUnit' => $u['measuredGasUnit'], 'note' => $u['note'],
            ], $form['equipmentUses']),
            'labor' => array_map(fn ($a) => ['phaseKey' => $a['phaseKey'], 'employeeId' => $a['employeeId'], 'activeMinutes' => $a['activeMinutes'], 'sharePercent' => $a['sharePercent'], 'note' => $a['note']], $form['labor']),
        ];
    }
}
