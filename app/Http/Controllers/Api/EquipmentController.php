<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

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

/** Strumenti e macchinari (port di apps/api/src/routes/equipment.ts). */
final class EquipmentController extends Controller
{
    private const UNIT_LABEL = ['kwh' => 'kWh', 'm3' => 'm³', 'smc' => 'Smc'];

    private static function coefficient(string $label): Schema
    {
        return S::decOpt(['gt' => 0, 'max' => 1, 'label' => $label]);
    }

    private static function equipmentBody(): Schema
    {
        return S::object([
            'code' => S::optText(40),
            'name' => S::reqText('Il nome', 160),
            'category' => S::optText(80),
            'description' => S::optText(2000),
            'powerType' => S::enum(['electric', 'gas', 'mixed', 'manual']),
            'status' => S::enum(['active', 'maintenance', 'inactive'])->default('active'),
            'capacity' => S::optText(120),
            'electricPowerKw' => S::decOpt(['gt' => 0, 'label' => 'La potenza (kW)']),
            'usageCoefficient' => self::coefficient('Il coefficiente di utilizzo'),
            'preheatCoefficient' => self::coefficient('Il coefficiente di preriscaldamento'),
            'holdCoefficient' => self::coefficient('Il coefficiente di mantenimento'),
            'electricTariffId' => S::uuid()->nullable()->optional(),
            'gasMode' => S::enum(['flow', 'energy'])->nullable()->optional(),
            'gasFlowPerHour' => S::decOpt(['gt' => 0, 'label' => 'La portata oraria']),
            'gasFlowUnit' => S::enum(['m3', 'smc'])->nullable()->optional(),
            'gasPowerKw' => S::decOpt(['gt' => 0, 'label' => 'La potenza gas (kW)']),
            'gasLoadFactor' => self::coefficient('Il fattore di carico'),
            'gasTariffId' => S::uuid()->nullable()->optional(),
        ]);
    }

    /** Normalizza secondo l'alimentazione e verifica le tariffe; restituisce le avvertenze di completezza. */
    private function prepare(string $companyId, array $b): array
    {
        $electric = $b['powerType'] === 'electric' || $b['powerType'] === 'mixed';
        $gas = $b['powerType'] === 'gas' || $b['powerType'] === 'mixed';
        $warnings = [];
        $mode = $b['gasMode'] ?? 'flow';
        $row = [
            'code' => $b['code'] ?? null,
            'name' => $b['name'],
            'category' => $b['category'] ?? null,
            'description' => $b['description'] ?? null,
            'power_type' => $b['powerType'],
            'status' => $b['status'],
            'capacity' => $b['capacity'] ?? null,
            'electric_power_kw' => $electric ? ($b['electricPowerKw'] ?? null) : null,
            'usage_coefficient' => $electric ? ($b['usageCoefficient'] ?? null) : null,
            'preheat_coefficient' => $electric ? ($b['preheatCoefficient'] ?? null) : null,
            'hold_coefficient' => $electric ? ($b['holdCoefficient'] ?? null) : null,
            'electric_tariff_id' => $electric ? ($b['electricTariffId'] ?? null) : null,
            'gas_mode' => $gas ? $mode : null,
            'gas_flow_per_hour' => $gas && $mode === 'flow' ? ($b['gasFlowPerHour'] ?? null) : null,
            'gas_flow_unit' => $gas && $mode === 'flow' ? ($b['gasFlowUnit'] ?? null) : null,
            'gas_power_kw' => $gas && ($b['gasMode'] ?? null) === 'energy' ? ($b['gasPowerKw'] ?? null) : null,
            'gas_load_factor' => $gas ? ($b['gasLoadFactor'] ?? null) : null,
            'gas_tariff_id' => $gas ? ($b['gasTariffId'] ?? null) : null,
        ];
        $tariffIds = array_values(array_filter([$row['electric_tariff_id'], $row['gas_tariff_id']]));
        $byId = $tariffIds ? DB::table('utility_tariffs')->where('company_id', $companyId)->whereIn('id', $tariffIds)->get(['id', 'kind', 'unit', 'name'])->keyBy('id') : collect();
        if ($row['electric_tariff_id']) {
            $t = $byId[$row['electric_tariff_id']] ?? null;
            if (! $t) {
                throw AppError::badRequest('validation_failed', 'Tariffa elettrica non trovata.', ['fields' => ['electricTariffId' => 'Tariffa non valida.']]);
            }
            if ($t->kind !== 'electricity') {
                throw AppError::badRequest('validation_failed', 'Associa una tariffa di tipo elettricità (€/kWh).', ['fields' => ['electricTariffId' => 'Tipo di tariffa non compatibile.']]);
            }
        }
        if ($row['gas_tariff_id']) {
            $t = $byId[$row['gas_tariff_id']] ?? null;
            if (! $t) {
                throw AppError::badRequest('validation_failed', 'Tariffa gas non trovata.', ['fields' => ['gasTariffId' => 'Tariffa non valida.']]);
            }
            if ($t->kind !== 'gas') {
                throw AppError::badRequest('validation_failed', 'Associa una tariffa di tipo gas.', ['fields' => ['gasTariffId' => 'Tipo di tariffa non compatibile.']]);
            }
            $consumptionUnit = $row['gas_mode'] === 'energy' ? 'kwh' : $row['gas_flow_unit'];
            if ($consumptionUnit && $consumptionUnit !== $t->unit) {
                $warnings[] = 'Il consumo è in '.self::UNIT_LABEL[$consumptionUnit]." ma la tariffa \"{$t->name}\" è in €/".self::UNIT_LABEL[$t->unit].': serve un coefficiente di conversione sulla tariffa, altrimenti il costo risulterà incompleto.';
            }
        }
        if ($electric) {
            if (! $row['electric_power_kw']) {
                $warnings[] = 'Potenza elettrica (kW) non indicata: il costo energetico risulterà incompleto.';
            }
            if (! $row['usage_coefficient']) {
                $warnings[] = 'Coefficiente medio di utilizzo non indicato.';
            }
            if (! $row['electric_tariff_id']) {
                $warnings[] = 'Nessuna tariffa elettrica associata.';
            }
        }
        if ($gas) {
            if ($row['gas_mode'] === 'flow' && (! $row['gas_flow_per_hour'] || ! $row['gas_flow_unit'])) {
                $warnings[] = 'Portata gas oraria o relativa unità non indicata.';
            }
            if ($row['gas_mode'] === 'energy' && ! $row['gas_power_kw']) {
                $warnings[] = 'Potenza gas (kW) non indicata.';
            }
            if (! $row['gas_tariff_id']) {
                $warnings[] = 'Nessuna tariffa gas associata.';
            }
        }

        return [$row, $warnings];
    }

    private static function present(object $e, bool $full): array
    {
        $base = [
            'id' => $e->id,
            'code' => $e->code,
            'name' => $e->name,
            'category' => $e->category,
            'powerType' => $e->power_type,
            'status' => $e->status,
            'capacity' => $e->capacity,
            'archived' => $e->archived_at !== null,
        ];
        if (! $full) {
            return $base;
        }

        return [
            ...$base,
            'description' => $e->description,
            'electricPowerKw' => $e->electric_power_kw,
            'usageCoefficient' => $e->usage_coefficient,
            'preheatCoefficient' => $e->preheat_coefficient,
            'holdCoefficient' => $e->hold_coefficient,
            'electricTariffId' => $e->electric_tariff_id,
            'gasMode' => $e->gas_mode,
            'gasFlowPerHour' => $e->gas_flow_per_hour,
            'gasFlowUnit' => $e->gas_flow_unit,
            'gasPowerKw' => $e->gas_power_kw,
            'gasLoadFactor' => $e->gas_load_factor,
            'gasTariffId' => $e->gas_tariff_id,
            'lockVersion' => (int) $e->lock_version,
            'updatedAt' => Clock::iso($e->updated_at),
        ];
    }

    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $q = $this->parseQuery($req, Schemas::listQuery(['powerType' => S::enum(['electric', 'gas', 'mixed', 'manual'])->optional()]));
        $query = DB::table('equipment as e')->where('e.company_id', $ctx->companyId());
        if ($q['archived'] === '0') {
            $query->whereNull('e.archived_at');
        }
        if ($q['archived'] === '1') {
            $query->whereNotNull('e.archived_at');
        }
        if (! empty($q['category'])) {
            $query->where('e.category', $q['category']);
        }
        if (! empty($q['powerType'])) {
            $query->where('e.power_type', $q['powerType']);
        }
        if (! empty($q['q'])) {
            $pat = Row::like($q['q']);
            $query->where(fn ($w) => $w->whereRaw(Row::likeSql('e.name'), [$pat])->orWhereRaw(Row::likeSql('e.code'), [$pat]));
        }
        $sorts = ['name' => 'e.name', 'code' => 'e.code', 'category' => 'e.category', 'updated' => 'e.updated_at'];
        $col = $sorts[$q['sort'] ?? 'name'] ?? 'e.name';
        $total = (clone $query)->count();
        $rows = $query->orderByRaw("{$col} IS NULL ".($q['dir'] === 'desc' ? 'DESC' : 'ASC'))->orderBy($col, $q['dir'])->orderBy('e.id')
            ->limit($q['pageSize'])->offset(($q['page'] - 1) * $q['pageSize'])->get(['e.*']);
        $full = $ctx->can('equipment.manage');

        return ['data' => $rows->map(fn ($r) => self::present($r, $full))->all(), 'meta' => ['page' => $q['page'], 'pageSize' => $q['pageSize'], 'total' => $rows->isEmpty() ? 0 : $total]];
    }

    public function show(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $id = $this->uuid($id);
        $e = DB::table('equipment')->where('id', $id)->where('company_id', $ctx->companyId())->first();
        if (! $e) {
            throw AppError::notFound('Strumento');
        }
        $usedIn = DB::table('recipes as r')->join('recipe_equipment_uses as u', 'u.revision_id', '=', 'r.current_revision_id')
            ->where('r.company_id', $ctx->companyId())->where('u.equipment_id', $id)->distinct()->orderBy('r.title')
            ->get(['r.id', 'r.code', 'r.title', 'r.status']);

        return [...self::present($e, true), 'usedIn' => Row::all($usedIn)];
    }

    public function store(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'equipment.manage');
        $body = $this->parseBody($req, self::equipmentBody());
        $cid = $ctx->companyId();
        [$row, $warnings] = $this->prepare($cid, $body);

        return DB::transaction(function () use ($ctx, $body, $cid, $row, $warnings) {
            $code = $row['code'] ?? Codes::next('equipment', $cid, 'STR');
            if (DB::table('equipment')->where('company_id', $cid)->where('code', $code)->exists()) {
                throw AppError::conflict('duplicate_code', "Il codice {$code} è già in uso.", ['fields' => ['code' => 'Codice già in uso.']]);
            }
            $id = (string) Str::uuid();
            DB::table('equipment')->insert([...$row, 'id' => $id, 'code' => $code, 'company_id' => $cid, 'created_at' => Clock::now(), 'updated_at' => Clock::now()]);
            Audit::log($cid, $ctx->userId(), 'equipment', $id, 'created', ['code' => $code, 'name' => $body['name']]);

            return ['id' => $id, 'code' => $code, 'name' => $body['name'], 'warnings' => $warnings];
        });
    }

    public function update(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'equipment.manage');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, self::equipmentBody()->extend(['code' => S::reqText('Il codice', 40), 'lockVersion' => S::int()]));
        $cid = $ctx->companyId();
        [$row, $warnings] = $this->prepare($cid, $body);
        DB::transaction(function () use ($ctx, $body, $cid, $id, $row) {
            $cur = DB::table('equipment')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first();
            if (! $cur) {
                throw AppError::notFound('Strumento');
            }
            if ((int) $cur->lock_version !== $body['lockVersion']) {
                throw AppError::conflict('stale', 'Lo strumento è stato modificato da un altro utente: ricarica la pagina.');
            }
            if (DB::table('equipment')->where('company_id', $cid)->where('code', $body['code'])->where('id', '<>', $id)->exists()) {
                throw AppError::conflict('duplicate_code', "Il codice {$body['code']} è già in uso.", ['fields' => ['code' => 'Codice già in uso.']]);
            }
            $next = [...$row, 'code' => $body['code']];
            DB::table('equipment')->where('id', $id)->update([...$next, 'updated_at' => Clock::now(), 'lock_version' => $cur->lock_version + 1]);
            Audit::log($cid, $ctx->userId(), 'equipment', $id, 'updated', Audit::diff((array) $cur, $next));
        });
        $affected = Costing::invalidate($cid, 'equipment', [$id]);

        return ['ok' => true, 'warnings' => $warnings, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
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
        $ctx = $this->requireCompany($req, 'equipment.manage');
        $id = $this->uuid($id);
        $n = DB::table('equipment')->where('id', $id)->where('company_id', $ctx->companyId())
            ->update(['archived_at' => $archived ? Clock::now() : null, 'updated_at' => Clock::now(), 'lock_version' => DB::raw('lock_version + 1')]);
        if (! $n) {
            throw AppError::notFound('Strumento');
        }
        Audit::log($ctx->companyId(), $ctx->userId(), 'equipment', $id, $archived ? 'archived' : 'restored');

        return ['ok' => true];
    }

    public function destroy(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'equipment.manage');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();

        return DB::transaction(function () use ($ctx, $cid, $id) {
            $e = DB::table('equipment')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first(['id', 'code']);
            if (! $e) {
                throw AppError::notFound('Strumento');
            }
            if (DB::table('recipe_equipment_uses')->where('equipment_id', $id)->exists()) {
                throw AppError::conflict('in_use', 'Lo strumento è usato in almeno una ricetta (anche in revisioni storiche): puoi archiviarlo ma non eliminarlo.');
            }
            DB::table('equipment')->where('id', $id)->delete();
            Audit::log($cid, $ctx->userId(), 'equipment', $id, 'deleted', ['code' => $e->code]);

            return ['ok' => true];
        });
    }
}
