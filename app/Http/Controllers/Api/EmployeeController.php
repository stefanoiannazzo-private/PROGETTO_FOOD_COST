<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Calculators;
use App\Domain\Costing\Dec;
use App\Http\Controllers\Controller;
use App\Http\Requests\Schemas;
use App\Services\Audit;
use App\Services\Codes;
use App\Services\ChangeAlerts;
use App\Services\Costing;
use App\Services\Recipes;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Row;
use App\Support\Validation\S;
use App\Support\Validation\Schema;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Dipendenti e costo del lavoro (port di apps/api/src/routes/employees.ts).
 * NUOVO: voce extra della retribuzione (extraMonthly), facoltativa, che si somma al lordo mensile.
 */
final class EmployeeController extends Controller
{
    private static function employeeBody(): Schema
    {
        return S::object([
            'code' => S::optText(40),
            'firstName' => S::reqText('Il nome', 80),
            'lastName' => S::reqText('Il cognome', 80),
            'jobTitle' => S::optText(120),
            'status' => S::enum(['active', 'inactive'])->default('active'),
            'userId' => S::uuid()->nullable()->optional(),
        ]);
    }

    public static function costConfigBody(): Schema
    {
        $t = [Recipes::class, 't'];

        return S::object([
            'validFrom' => S::isoDate(),
            'grossMonthly' => S::dec(['min' => 0, 'label' => 'Il lordo mensile']),
            'extraMonthly' => S::decOpt(['min' => 0, 'label' => 'La voce extra']),
            // NUOVO: mensilità pagate (12–16) e mensilità della voce extra (0..mensilità)
            'monthsPaid' => S::int(12, 16)->nullable()->optional(),
            'extraMonths' => S::int(0, 16)->nullable()->optional(),
            'contributionsMode' => S::enum(['none', 'amount', 'percent']),
            'contributionsValue' => S::decOpt(['min' => 0, 'label' => 'Gli oneri']),
            'otherMonthlyCosts' => S::decOpt(['min' => 0, 'label' => 'Gli altri costi']),
            'productiveHours' => S::dec(['gt' => 0, 'max' => 744, 'label' => 'Le ore mensili produttive']),
            'notes' => S::optText(500),
        ])->superRefine(function ($b, $add) use ($t) {
            $mode = $b['contributionsMode'] ?? null;
            $value = $b['contributionsValue'] ?? null;
            if ($mode === 'none' && $t($value)) {
                $add('Hai scelto “nessun onere”: lascia vuoto l’importo.', ['contributionsValue']);
            }
            if ($mode !== null && $mode !== 'none' && ! $t($value)) {
                $add('Indica l’importo o la percentuale degli oneri.', ['contributionsValue']);
            }
            if (isset($b['extraMonths']) && $b['extraMonths'] > ($b['monthsPaid'] ?? 12)) {
                $add('La voce extra non può essere pagata su più mensilità di quelle del dipendente.', ['extraMonths']);
            }
            if ($mode === 'percent' && $t($value) && Dec::of($value)->gt(200)) {
                $add('Percentuale oneri non plausibile (oltre 200%).', ['contributionsValue']);
            }
        });
    }

    public static function ratesFor(array $c): array
    {
        $r = Calculators::employeeRates([
            'grossMonthly' => Dec::of($c['gross_monthly']),
            'extraMonthly' => Recipes::t($c['extra_monthly'] ?? null) ? Dec::of($c['extra_monthly']) : null,
            'monthsPaid' => isset($c['months_paid']) ? (int) $c['months_paid'] : null,
            'extraMonths' => isset($c['extra_months']) ? (int) $c['extra_months'] : null,
            'contributionsMode' => $c['contributions_mode'],
            'contributionsValue' => Recipes::t($c['contributions_value']) ? Dec::of($c['contributions_value']) : null,
            'otherMonthlyCosts' => Dec::of($c['other_monthly_costs']),
            'productiveHours' => Dec::of($c['productive_hours']),
        ]);

        return [
            'grossHourly' => $r['grossHourly']->toFixed(),
            'contributionsMonthly' => $r['contributions']->toFixed(),
            'companyMonthly' => $r['companyMonthly']->toFixed(),
            'annualCost' => $r['annualCost']->toFixed(),
            'companyHourly' => $r['companyHourly']->toFixed(),
            'costPerMinute' => $r['costPerMinute']->toFixed(),
            'basis' => $r['basis'],
        ];
    }

    /** Elenco: retribuzioni e costi orari compaiono SOLO con salaries.read (altrimenti i campi non ci sono). */
    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req);
        if (! $ctx->can('employees.read') && ! $ctx->can('recipes.manage')) {
            throw AppError::notFound('Elenco');
        }
        $q = $this->parseQuery($req, Schemas::listQuery(['status' => S::enum(['active', 'inactive'])->optional()]));
        $salaries = $ctx->can('salaries.read');
        $t = Clock::today();
        $query = DB::table('employees as e')->where('e.company_id', $ctx->companyId());
        if ($q['archived'] === '0') {
            $query->whereNull('e.archived_at');
        }
        if ($q['archived'] === '1') {
            $query->whereNotNull('e.archived_at');
        }
        if (! empty($q['status'])) {
            $query->where('e.status', $q['status']);
        }
        if (! empty($q['q'])) {
            $pat = Row::like($q['q']);
            $query->where(fn ($w) => $w->whereRaw(Row::likeSql('e.first_name'), [$pat])->orWhereRaw(Row::likeSql('e.last_name'), [$pat])
                ->orWhereRaw(Row::likeSql('e.code'), [$pat])->orWhereRaw(Row::likeSql('e.job_title'), [$pat]));
        }
        $sorts = ['name' => 'e.last_name', 'code' => 'e.code', 'job' => 'e.job_title', 'updated' => 'e.updated_at'];
        $col = $sorts[$q['sort'] ?? 'name'] ?? 'e.last_name';
        $total = (clone $query)->count();
        $rows = $query->orderByRaw("{$col} IS NULL ".($q['dir'] === 'desc' ? 'DESC' : 'ASC'))->orderBy($col, $q['dir'])->orderBy('e.first_name')->orderBy('e.id')
            ->limit($q['pageSize'])->offset(($q['page'] - 1) * $q['pageSize'])
            ->get(['e.id', 'e.code', 'e.first_name', 'e.last_name', 'e.job_title', 'e.status', 'e.archived_at']);
        $configs = Costing::latestAt('employee_cost_configs', 'employee_id', $rows->pluck('id')->all(), $t);

        return [
            'data' => $rows->map(function ($r) use ($configs, $salaries) {
                $c = $configs[$r->id] ?? null;
                $out = [
                    'id' => $r->id,
                    'code' => $r->code,
                    'firstName' => $r->first_name,
                    'lastName' => $r->last_name,
                    'name' => "{$r->first_name} {$r->last_name}",
                    'jobTitle' => $r->job_title,
                    'status' => $r->status,
                    'archived' => $r->archived_at !== null,
                    'hasCost' => $c !== null,
                ];
                if ($salaries && $c) {
                    $out['cost'] = [
                        'validFrom' => $c->valid_from,
                        'grossMonthly' => $c->gross_monthly,
                        'extraMonthly' => $c->extra_monthly,
                        'contributionsMode' => $c->contributions_mode,
                        ...self::ratesFor((array) $c),
                    ];
                }

                return $out;
            })->all(),
            'meta' => ['page' => $q['page'], 'pageSize' => $q['pageSize'], 'total' => $rows->isEmpty() ? 0 : $total, 'salariesVisible' => $salaries],
        ];
    }

    public function show(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'employees.read');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();
        $e = DB::table('employees')->where('id', $id)->where('company_id', $cid)->first();
        if (! $e) {
            throw AppError::notFound('Dipendente');
        }
        $salaries = $ctx->can('salaries.read');
        $configs = $salaries ? DB::table('employee_cost_configs')->where('employee_id', $id)->where('company_id', $cid)->orderByDesc('valid_from')->get() : collect();
        $t = Clock::today();
        $configCount = $salaries ? $configs->count() : DB::table('employee_cost_configs')->where('employee_id', $id)->count();
        $currentId = $configs->first(fn ($x) => $x->valid_from <= $t)?->id;
        $out = [
            'id' => $e->id,
            'code' => $e->code,
            'firstName' => $e->first_name,
            'lastName' => $e->last_name,
            'jobTitle' => $e->job_title,
            'status' => $e->status,
            'userId' => $e->user_id,
            'archived' => $e->archived_at !== null,
            'salariesVisible' => $salaries,
            'hasCost' => $configCount > 0,
        ];
        if ($salaries) {
            $out['costs'] = $configs->map(fn ($c) => [
                'id' => $c->id,
                'validFrom' => $c->valid_from,
                'grossMonthly' => $c->gross_monthly,
                'extraMonthly' => $c->extra_monthly,
                'monthsPaid' => $c->months_paid !== null ? (int) $c->months_paid : null,
                'extraMonths' => $c->extra_months !== null ? (int) $c->extra_months : null,
                'contributionsMode' => $c->contributions_mode,
                'contributionsValue' => $c->contributions_value,
                'otherMonthlyCosts' => $c->other_monthly_costs,
                'productiveHours' => $c->productive_hours,
                'notes' => $c->notes,
                'current' => $c->valid_from <= $t && $currentId === $c->id,
                'future' => $c->valid_from > $t,
                ...self::ratesFor((array) $c),
            ])->all();
        }

        return $out;
    }

    public function store(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'employees.manage');
        $body = $this->parseBody($req, self::employeeBody()->extend(['firstCost' => self::costConfigBody()->optional()]));
        if (isset($body['firstCost']) && ! $ctx->can('salaries.read')) {
            throw AppError::badRequest('forbidden_salary', 'Non hai i permessi per inserire dati retributivi.');
        }
        $cid = $ctx->companyId();

        return DB::transaction(function () use ($ctx, $body, $cid) {
            $code = $body['code'] ?? Codes::next('employees', $cid, 'DIP');
            if (DB::table('employees')->where('company_id', $cid)->where('code', $code)->exists()) {
                throw AppError::conflict('duplicate_code', "Il codice {$code} è già in uso.", ['fields' => ['code' => 'Codice già in uso.']]);
            }
            if (! empty($body['userId'])) {
                $this->assertMember($cid, $body['userId']);
            }
            $id = (string) Str::uuid();
            DB::table('employees')->insert([
                'id' => $id, 'company_id' => $cid, 'code' => $code, 'first_name' => $body['firstName'], 'last_name' => $body['lastName'],
                'job_title' => $body['jobTitle'] ?? null, 'status' => $body['status'], 'user_id' => $body['userId'] ?? null,
                'created_at' => Clock::now(), 'updated_at' => Clock::now(),
            ]);
            if (isset($body['firstCost'])) {
                self::insertConfig($cid, $ctx->userId(), $id, $body['firstCost']);
            }
            Audit::log($cid, $ctx->userId(), 'employee', $id, 'created', ['code' => $code]);

            return ['id' => $id, 'code' => $code];
        });
    }

    public function update(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'employees.manage');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, self::employeeBody()->extend(['code' => S::reqText('Il codice', 40)]));
        $cid = $ctx->companyId();
        if (DB::table('employees')->where('company_id', $cid)->where('code', $body['code'])->where('id', '<>', $id)->exists()) {
            throw AppError::conflict('duplicate_code', "Il codice {$body['code']} è già in uso.", ['fields' => ['code' => 'Codice già in uso.']]);
        }
        if (! empty($body['userId'])) {
            $this->assertMember($cid, $body['userId']);
        }
        if (! DB::table('employees')->where('id', $id)->where('company_id', $cid)->exists()) {
            throw AppError::notFound('Dipendente');
        }
        DB::table('employees')->where('id', $id)->update([
            'code' => $body['code'], 'first_name' => $body['firstName'], 'last_name' => $body['lastName'], 'job_title' => $body['jobTitle'] ?? null,
            'status' => $body['status'], 'user_id' => $body['userId'] ?? null, 'updated_at' => Clock::now(),
        ]);
        Audit::log($cid, $ctx->userId(), 'employee', $id, 'updated', ['code' => $body['code'], 'status' => $body['status']]);

        return ['ok' => true];
    }

    /** Nuova configurazione di costo con decorrenza: mantiene lo storico e aggiorna le ricette interessate. */
    public function addCost(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'employees.manage', 'salaries.read');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, self::costConfigBody());
        $cid = $ctx->companyId();
        if (! DB::table('employees')->where('id', $id)->where('company_id', $cid)->exists()) {
            throw AppError::notFound('Dipendente');
        }
        $watch = ChangeAlerts::watch($cid, 'employees', [$id]);
        $cfgId = DB::transaction(fn () => self::insertConfig($cid, $ctx->userId(), $id, $body));
        $affected = Costing::invalidate($cid, 'employees', [$id]);
        ChangeAlerts::commit($watch, $ctx->userId(), ['label' => 'Costo del personale aggiornato: '.self::nameOf($id)]);

        return ['id' => $cfgId, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    public function deleteCost(Request $req, string $id, string $configId): array
    {
        $ctx = $this->requireCompany($req, 'employees.manage', 'salaries.read');
        [$id, $configId] = $this->uuids(['id' => $id, 'configId' => $configId]);
        $cid = $ctx->companyId();
        $watch = ChangeAlerts::watch($cid, 'employees', [$id]);
        $n = DB::table('employee_cost_configs')->where('id', $configId)->where('employee_id', $id)->where('company_id', $cid)->delete();
        if (! $n) {
            throw AppError::notFound('Configurazione');
        }
        Audit::log($cid, $ctx->userId(), 'employee_cost', $configId, 'deleted');
        $affected = Costing::invalidate($cid, 'employees', [$id]);
        ChangeAlerts::commit($watch, $ctx->userId(), ['label' => 'Costo del personale aggiornato: '.self::nameOf($id)]);

        return ['ok' => true, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    private static function nameOf(string $id): string
    {
        $e = DB::table('employees')->where('id', $id)->first(['first_name', 'last_name', 'code']);

        return $e ? trim(($e->first_name ?? '').' '.($e->last_name ?? '')) ?: (string) $e->code : 'dipendente';
    }

    public function costPreview(Request $req): array
    {
        $this->requireCompany($req, 'salaries.read');
        $b = $this->parseBody($req, self::costConfigBody());

        return self::ratesFor([
            'gross_monthly' => $b['grossMonthly'],
            'extra_monthly' => $b['extraMonthly'] ?? null,
            'months_paid' => $b['monthsPaid'] ?? null,
            'extra_months' => $b['extraMonths'] ?? null,
            'contributions_mode' => $b['contributionsMode'],
            'contributions_value' => $b['contributionsValue'] ?? null,
            'other_monthly_costs' => $b['otherMonthlyCosts'] ?? '0',
            'productive_hours' => $b['productiveHours'],
        ]);
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
        $ctx = $this->requireCompany($req, 'employees.manage');
        $id = $this->uuid($id);
        if (! DB::table('employees')->where('id', $id)->where('company_id', $ctx->companyId())->exists()) {
            throw AppError::notFound('Dipendente');
        }
        DB::table('employees')->where('id', $id)->update(['archived_at' => $archived ? Clock::now() : null, 'updated_at' => Clock::now()]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'employee', $id, $archived ? 'archived' : 'restored');

        return ['ok' => true];
    }

    private function assertMember(string $companyId, string $userId): void
    {
        if (! DB::table('memberships')->where('company_id', $companyId)->where('user_id', $userId)->exists()) {
            throw AppError::badRequest('validation_failed', 'L’account collegato non appartiene a questa azienda.', ['fields' => ['userId' => 'Utente non valido.']]);
        }
    }

    public static function insertConfig(string $companyId, ?string $userId, string $employeeId, array $b, ?string $importId = null): string
    {
        if (DB::table('employee_cost_configs')->where('employee_id', $employeeId)->where('valid_from', $b['validFrom'])->exists()) {
            throw AppError::conflict('config_date_conflict', 'Esiste già una configurazione con questa decorrenza.', ['fields' => ['validFrom' => 'Data già usata.']]);
        }
        $id = (string) Str::uuid();
        DB::table('employee_cost_configs')->insert([
            'id' => $id,
            'company_id' => $companyId,
            'employee_id' => $employeeId,
            'valid_from' => $b['validFrom'],
            'gross_monthly' => $b['grossMonthly'],
            'extra_monthly' => $b['extraMonthly'] ?? null,
            'months_paid' => $b['monthsPaid'] ?? null,
            'extra_months' => isset($b['extraMonthly']) && Recipes::t($b['extraMonthly']) ? ($b['extraMonths'] ?? null) : null,
            'contributions_mode' => $b['contributionsMode'],
            'contributions_value' => $b['contributionsMode'] === 'none' ? null : $b['contributionsValue'],
            'other_monthly_costs' => $b['otherMonthlyCosts'] ?? '0',
            'productive_hours' => $b['productiveHours'],
            'notes' => $b['notes'] ?? null,
            'import_id' => $importId,
            'created_by' => $userId,
            'created_at' => Clock::now(),
        ]);
        // l'audit registra il fatto, non gli importi
        Audit::log($companyId, $userId, 'employee_cost', $id, 'created', ['employeeId' => $employeeId, 'validFrom' => $b['validFrom'], 'contributionsMode' => $b['contributionsMode']]);

        return $id;
    }
}
