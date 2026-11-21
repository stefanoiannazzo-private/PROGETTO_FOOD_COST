<?php

declare(strict_types=1);

namespace App\Services\Imports;

use App\Auth\Permissions;
use App\Domain\Costing\Dec;
use App\Services\Audit;
use App\Services\Codes;
use App\Services\Costing;
use App\Services\Recipes;
use App\Support\Clock;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Applicazione atomica di un'importazione validata: o tutte le righe o nessuna (port di imports/apply.ts).
 * Prima di scrivere ricontrolla permessi e azienda dell'autore e i conflitti con modifiche avvenute dopo
 * l'anteprima. È idempotente: una seconda esecuzione non duplica nulla.
 */
final class Applier
{
    private const CHUNK = 500;

    private static function t(mixed $v): bool
    {
        return Recipes::t($v);
    }

    /** @return array{applied: bool, reason?: string} */
    public static function run(string $importId): array
    {
        $result = DB::transaction(function () use ($importId) {
            $imp = DB::table('imports')->where('id', $importId)->lockForUpdate()->first();
            if ($imp->status === 'applied') {
                return ['applied' => false, 'reason' => 'già applicata', 'ids' => [], 'companyId' => $imp->company_id, 'type' => $imp->type];
            }
            if ($imp->status !== 'applying') {
                throw new ApplyError("Stato non valido per l’applicazione: {$imp->status}.");
            }
            // ricontrollo autorizzazioni e azienda al momento della scrittura
            $m = DB::table('memberships as m')->join('users as u', 'u.id', '=', 'm.user_id')
                ->where('m.user_id', $imp->created_by)->where('m.company_id', $imp->company_id)->where('m.is_active', 1)->where('u.is_active', 1)
                ->first(['m.role', 'm.extra_permissions']);
            $perms = $m ? Permissions::effective($m->role, json_decode($m->extra_permissions, true) ?: []) : [];
            $needed = $imp->type === 'ingredients' ? ['imports.manage', 'ingredients.manage'] : ['imports.manage', 'employees.manage', 'salaries.read'];
            if (! $m || array_diff($needed, $perms)) {
                throw new ApplyError('L’autore dell’importazione non ha più i permessi necessari.');
            }
            if (DB::table('import_rows')->where('import_id', $importId)->where('action', 'error')->exists()) {
                throw new ApplyError('L’importazione contiene righe con errori: nessuna riga è stata applicata.');
            }
            $validatedAt = $imp->validated_at;
            $touched = [];
            $offset = 0;
            for (;;) {
                $rows = DB::table('import_rows')->where('import_id', $importId)->whereIn('action', ['create', 'update'])
                    ->orderBy('row_number')->limit(self::CHUNK)->offset($offset)->get(['row_number', 'normalized', 'action', 'target_id']);
                if ($rows->isEmpty()) {
                    break;
                }
                $offset += $rows->count();
                $ids = $imp->type === 'ingredients'
                    ? self::applyIngredients($imp->company_id, $imp->created_by, $importId, $validatedAt, $rows)
                    : self::applyEmployees($imp->company_id, $imp->created_by, $importId, $validatedAt, $rows);
                array_push($touched, ...$ids);
            }
            DB::table('imports')->where('id', $importId)->update(['status' => 'applied', 'applied_at' => Clock::now(), 'progress' => $offset]);
            Audit::log($imp->company_id, $imp->created_by, 'import', $importId, 'applied', ['type' => $imp->type, 'rows' => $offset]);

            return ['applied' => true, 'ids' => $touched, 'companyId' => $imp->company_id, 'type' => $imp->type];
        });
        if ($result['applied'] && $result['ids']) {
            Costing::invalidate($result['companyId'], $result['type'] === 'ingredients' ? 'ingredients' : 'employees', array_values(array_unique($result['ids'])));
        }
        $out = ['applied' => $result['applied']];
        if (isset($result['reason'])) {
            $out['reason'] = $result['reason'];
        }

        return $out;
    }

    private static function applyIngredients(string $companyId, string $userId, string $importId, string $validatedAt, $rows): array
    {
        $ids = [];
        foreach ($rows as $r) {
            $n = json_decode($r->normalized, true);
            $id = $r->target_id;
            if ($r->action === 'update') {
                $cur = DB::table('ingredients')->where('id', $id)->where('company_id', $companyId)->lockForUpdate()->first(['id', 'updated_at', 'package_unit', 'package_content']);
                if (! $cur) {
                    throw new ApplyError("Riga {$r->row_number}: l’ingrediente non esiste più.");
                }
                if ($cur->updated_at > $validatedAt) {
                    throw new ApplyError("Riga {$r->row_number}: l’ingrediente {$n['code']} è stato modificato dopo l’anteprima. Rivalida l’importazione.");
                }
                $set = [];
                foreach (['name' => 'name', 'category' => 'category', 'supplier' => 'supplier', 'packageContent' => 'package_content', 'packageUnit' => 'package_unit', 'densityKgPerL' => 'density_kg_per_l', 'unitWeightKg' => 'unit_weight_kg'] as $k => $col) {
                    if (self::t($n[$k] ?? null)) {
                        $set[$col] = $n[$k];
                    }
                }
                if (self::t($n['edibleYieldPercent'] ?? null)) {
                    $set['edible_yield'] = Dec::of($n['edibleYieldPercent'])->div(100)->toFixed();
                }
                if ($set) {
                    DB::table('ingredients')->where('id', $id)->update([...$set, 'updated_at' => Clock::now(), 'lock_version' => DB::raw('lock_version + 1')]);
                }
            } else {
                $code = $n['code'] ?? Codes::next('ingredients', $companyId, 'ING');
                if (DB::table('ingredients')->where('company_id', $companyId)->where('code', $code)->exists()) {
                    throw new ApplyError("Riga {$r->row_number}: il codice {$code} è stato creato da qualcun altro dopo l’anteprima. Rivalida l’importazione.");
                }
                $id = (string) Str::uuid();
                DB::table('ingredients')->insert([
                    'id' => $id,
                    'company_id' => $companyId,
                    'code' => $code,
                    'name' => $n['name'],
                    'category' => $n['category'] ?? null,
                    'supplier' => $n['supplier'] ?? null,
                    'package_content' => $n['packageContent'],
                    'package_unit' => $n['packageUnit'],
                    'usage_unit' => $n['usageUnit'] ?? $n['packageUnit'],
                    'edible_yield' => self::t($n['edibleYieldPercent'] ?? null) ? Dec::of($n['edibleYieldPercent'])->div(100)->toFixed() : '1',
                    'density_kg_per_l' => $n['densityKgPerL'] ?? null,
                    'unit_weight_kg' => $n['unitWeightKg'] ?? null,
                    'created_at' => Clock::now(),
                    'updated_at' => Clock::now(),
                ]);
            }
            if (($n['packagePrice'] ?? null) !== null && self::t($n['priceDate'] ?? null) && empty($n['priceDuplicate'])) {
                $ing = DB::table('ingredients')->where('id', $id)->first(['package_content', 'package_unit', 'supplier']);
                $existing = DB::table('ingredient_prices')->where('ingredient_id', $id)->where('valid_from', $n['priceDate'])->first(['id', 'package_price']);
                if ($existing) {
                    if (! Dec::of($existing->package_price)->eq($n['packagePrice'])) {
                        throw new ApplyError("Riga {$r->row_number}: un prezzo diverso con la stessa data è stato inserito dopo l’anteprima.");
                    }
                } else {
                    DB::table('ingredient_prices')->insert([
                        'id' => (string) Str::uuid(),
                        'company_id' => $companyId,
                        'ingredient_id' => $id,
                        'package_price' => $n['packagePrice'],
                        'package_content' => $n['packageContent'] ?? $ing->package_content,
                        'package_unit' => $n['packageUnit'] ?? $ing->package_unit,
                        'valid_from' => $n['priceDate'],
                        'source' => $n['priceSource'] ?? 'Importazione',
                        'supplier' => $ing->supplier,
                        'agent_name' => $n['agentName'] ?? null,
                        'import_id' => $importId,
                        'created_by' => $userId,
                        'created_at' => Clock::now(),
                    ]);
                }
            }
            $ids[] = $id;
        }

        return $ids;
    }

    private static function applyEmployees(string $companyId, string $userId, string $importId, string $validatedAt, $rows): array
    {
        $ids = [];
        foreach ($rows as $r) {
            $n = json_decode($r->normalized, true);
            $id = $r->target_id;
            if ($r->action === 'update') {
                $cur = DB::table('employees')->where('id', $id)->where('company_id', $companyId)->lockForUpdate()->first(['id', 'updated_at']);
                if (! $cur) {
                    throw new ApplyError("Riga {$r->row_number}: il dipendente non esiste più.");
                }
                if ($cur->updated_at > $validatedAt) {
                    throw new ApplyError("Riga {$r->row_number}: il dipendente {$n['code']} è stato modificato dopo l’anteprima. Rivalida l’importazione.");
                }
                $set = [];
                foreach (['firstName' => 'first_name', 'lastName' => 'last_name', 'jobTitle' => 'job_title', 'status' => 'status'] as $k => $col) {
                    if (self::t($n[$k] ?? null)) {
                        $set[$col] = $n[$k];
                    }
                }
                if ($set) {
                    DB::table('employees')->where('id', $id)->update([...$set, 'updated_at' => Clock::now()]);
                }
            } else {
                $code = $n['code'] ?? Codes::next('employees', $companyId, 'DIP');
                if (DB::table('employees')->where('company_id', $companyId)->where('code', $code)->exists()) {
                    throw new ApplyError("Riga {$r->row_number}: il codice {$code} è stato creato da qualcun altro dopo l’anteprima. Rivalida l’importazione.");
                }
                $id = (string) Str::uuid();
                DB::table('employees')->insert([
                    'id' => $id, 'company_id' => $companyId, 'code' => $code, 'first_name' => $n['firstName'], 'last_name' => $n['lastName'],
                    'job_title' => $n['jobTitle'] ?? null, 'status' => $n['status'] ?? 'active', 'created_at' => Clock::now(), 'updated_at' => Clock::now(),
                ]);
            }
            if (empty($n['configDuplicate'])) {
                if (DB::table('employee_cost_configs')->where('employee_id', $id)->where('valid_from', $n['validFrom'])->exists()) {
                    throw new ApplyError("Riga {$r->row_number}: una configurazione con la stessa decorrenza è stata inserita dopo l’anteprima.");
                }
                DB::table('employee_cost_configs')->insert([
                    'id' => (string) Str::uuid(),
                    'company_id' => $companyId,
                    'employee_id' => $id,
                    'valid_from' => $n['validFrom'],
                    'gross_monthly' => $n['grossMonthly'],
                    'extra_monthly' => $n['extraMonthly'] ?? null,
                    'contributions_mode' => $n['contributionsMode'],
                    'contributions_value' => $n['contributionsMode'] === 'none' ? null : $n['contributionsValue'],
                    'other_monthly_costs' => $n['otherMonthlyCosts'] ?? '0',
                    'productive_hours' => $n['productiveHours'],
                    'import_id' => $importId,
                    'created_by' => $userId,
                    'created_at' => Clock::now(),
                ]);
            }
            $ids[] = $id;
        }

        return $ids;
    }
}
