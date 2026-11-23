<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Dec;
use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\ChangeAlerts;
use App\Services\Costing;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Row;
use App\Support\Validation\S;
use App\Support\Validation\Schema;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Utenze: tariffe e versioni con decorrenza, modalità diretta o da bolletta (port di routes/tariffs.ts). */
final class TariffController extends Controller
{
    private const KIND_UNITS = ['electricity' => ['kwh'], 'gas' => ['m3', 'smc', 'kwh'], 'water' => ['m3']];

    private static function tariffBody(array $extra = []): Schema
    {
        return S::object([
            'name' => S::reqText('Il nome', 120),
            'kind' => S::enum(['electricity', 'gas', 'water']),
            'unit' => S::enum(['kwh', 'm3', 'smc']),
            'notes' => S::optText(1000),
            ...$extra,
        ])->refine(
            fn ($b) => ! isset($b['kind'], $b['unit']) || in_array($b['unit'], self::KIND_UNITS[$b['kind']], true),
            'Unità non compatibile: elettricità in kWh (energia, non kW di potenza); gas in m³, Smc o kWh; acqua in m³.',
            ['unit'],
        );
    }

    private static function conversions(): array
    {
        return [
            'm3ToSmc' => S::decOpt(['gt' => 0, 'label' => 'Il coefficiente m³→Smc']),
            'smcToKwh' => S::decOpt(['gt' => 0, 'label' => 'Il coefficiente kWh/Smc']),
        ];
    }

    private static function directVersion(): Schema
    {
        return S::object([
            'mode' => S::literal('direct'),
            'pricePerUnit' => S::dec(['min' => 0, 'label' => 'Il prezzo unitario']),
            'validFrom' => S::isoDate(),
            'notes' => S::optText(500),
            ...self::conversions(),
        ]);
    }

    /** Modalità assistita da bolletta: prezzo medio = voci selezionate / consumo del periodo. */
    public static function billVersion(): Schema
    {
        return S::object([
            'mode' => S::literal('bill'),
            'validFrom' => S::isoDate(),
            'periodFrom' => S::isoDate(),
            'periodTo' => S::isoDate(),
            'consumption' => S::dec(['gt' => 0, 'label' => 'Il consumo del periodo']),
            'consumptionUnit' => S::enum(['kwh', 'm3', 'smc']),
            'vatBasis' => S::literal('net', 'Tutti gli importi devono essere netti IVA.'),
            'components' => S::array(S::object([
                'label' => S::reqText('La descrizione della voce', 120),
                'amount' => S::dec(['min' => 0, 'label' => 'L’importo']),
                'kind' => S::enum(['variable', 'fixed']),
                'include' => S::bool(),
            ]))->min(1, 'Inserisci almeno una voce di costo.'),
            'notes' => S::optText(500),
            // NUOVO: bolletta caricata da cui sono stati letti i dati (resta nell'archivio collegata a questo valore)
            'billFileId' => S::uuid()->optional(),
            ...self::conversions(),
        ]);
    }

    private static function versionBody(): Schema
    {
        return S::discriminated('mode', ['direct' => self::directVersion(), 'bill' => self::billVersion()]);
    }

    public static function computeBillTariff(array $b): array
    {
        $included = array_values(array_filter($b['components'], fn ($c) => $c['include']));
        if (! $included) {
            throw AppError::badRequest('validation_failed', 'Seleziona almeno una voce da includere nella tariffa.', ['fields' => ['components' => 'Nessuna voce inclusa.']]);
        }
        $variable = Dec::sum(array_map(fn ($c) => Dec::of($c['amount']), array_filter($included, fn ($c) => $c['kind'] === 'variable')));
        $fixed = Dec::sum(array_map(fn ($c) => Dec::of($c['amount']), array_filter($included, fn ($c) => $c['kind'] === 'fixed')));
        $selected = $variable->plus($fixed);

        return [
            'pricePerUnit' => $selected->div($b['consumption']),
            'variableOnly' => $variable->div($b['consumption']),
            'selected' => $selected,
            'variable' => $variable,
            'fixed' => $fixed,
            'includesFixed' => $fixed->gt(0),
        ];
    }

    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.read');
        $q = $this->parseQuery($req, S::object(['archived' => S::enum(['0', '1', 'all'])->default('0'), 'date' => S::isoDate()->optional()]));
        $date = $q['date'] ?? Clock::today();
        $query = DB::table('utility_tariffs as t')->where('t.company_id', $ctx->companyId());
        if ($q['archived'] === '0') {
            $query->whereNull('t.archived_at');
        }
        if ($q['archived'] === '1') {
            $query->whereNotNull('t.archived_at');
        }
        $rows = $query->orderBy('t.kind')->orderBy('t.name')->get(['t.id', 't.name', 't.kind', 't.unit', 't.notes', 't.archived_at']);
        $versions = Costing::latestAt('tariff_versions', 'tariff_id', $rows->pluck('id')->all(), $date, ['tariff_id', 'price_per_unit', 'valid_from', 'origin', 'm3_to_smc', 'smc_to_kwh']);

        return [
            'data' => $rows->map(function ($r) use ($versions) {
                $v = $versions[$r->id] ?? null;

                return [
                    'id' => $r->id,
                    'name' => $r->name,
                    'kind' => $r->kind,
                    'unit' => $r->unit,
                    'notes' => $r->notes,
                    'archived' => $r->archived_at !== null,
                    'current' => $v ? ['pricePerUnit' => $v->price_per_unit, 'validFrom' => $v->valid_from, 'origin' => $v->origin, 'm3ToSmc' => $v->m3_to_smc, 'smcToKwh' => $v->smc_to_kwh] : null,
                ];
            })->all(),
            'meta' => ['date' => $date],
        ];
    }

    public function show(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.read');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();
        $t = DB::table('utility_tariffs')->where('id', $id)->where('company_id', $cid)->first();
        if (! $t) {
            throw AppError::notFound('Tariffa');
        }
        $versions = Row::all(DB::table('tariff_versions as v')->leftJoin('users as u', 'u.id', '=', 'v.created_by')
            ->where('v.tariff_id', $id)->where('v.company_id', $cid)->orderByDesc('v.valid_from')
            ->get(['v.id', 'v.price_per_unit', 'v.valid_from', 'v.origin', 'v.m3_to_smc', 'v.smc_to_kwh', 'v.bill', 'v.notes', 'v.created_at', 'u.name as created_by']), [], ['bill']);
        $equipment = DB::table('equipment')->where('company_id', $cid)
            ->where(fn ($w) => $w->where('electric_tariff_id', $id)->orWhere('gas_tariff_id', $id))->orderBy('name')
            ->get(['id', 'code', 'name']);
        $t0 = Clock::today();
        $current = null;
        foreach ($versions as $v) {
            if ($v['valid_from'] <= $t0) {
                $current = $v;
                break;
            }
        }

        return [
            'id' => $t->id,
            'name' => $t->name,
            'kind' => $t->kind,
            'unit' => $t->unit,
            'notes' => $t->notes,
            'archived' => $t->archived_at !== null,
            'versions' => array_map(fn ($v) => [...$v, 'future' => $v['valid_from'] > $t0], $versions),
            'current' => $current,
            'equipment' => Row::all($equipment),
        ];
    }

    public function store(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.manage');
        $body = $this->parseBody($req, self::tariffBody(['firstVersion' => self::versionBody()->optional()]));
        $cid = $ctx->companyId();

        return DB::transaction(function () use ($ctx, $body, $cid) {
            $id = (string) Str::uuid();
            DB::table('utility_tariffs')->insert([
                'id' => $id, 'company_id' => $cid, 'name' => $body['name'], 'kind' => $body['kind'], 'unit' => $body['unit'],
                'notes' => $body['notes'] ?? null, 'created_at' => Clock::now(), 'updated_at' => Clock::now(),
            ]);
            if (isset($body['firstVersion'])) {
                self::insertVersion($cid, $ctx->userId(), ['id' => $id, 'unit' => $body['unit'], 'kind' => $body['kind']], $body['firstVersion']);
            }
            Audit::log($cid, $ctx->userId(), 'tariff', $id, 'created', ['name' => $body['name'], 'kind' => $body['kind'], 'unit' => $body['unit']]);

            return ['id' => $id, 'name' => $body['name']];
        });
    }

    public function update(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.manage');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, S::object(['name' => S::reqText('Il nome', 120), 'notes' => S::optText(1000)]));
        $exists = DB::table('utility_tariffs')->where('id', $id)->where('company_id', $ctx->companyId())->exists();
        if (! $exists) {
            throw AppError::notFound('Tariffa');
        }
        DB::table('utility_tariffs')->where('id', $id)->update(['name' => $body['name'], 'notes' => $body['notes'] ?? null, 'updated_at' => Clock::now()]);

        return ['ok' => true];
    }

    /** Anteprima del calcolo da bolletta, senza salvare. */
    public function billPreview(Request $req): array
    {
        $this->requireCompany($req, 'tariffs.read');
        $r = self::computeBillTariff($this->parseBody($req, self::billVersion()));

        return [
            'pricePerUnit' => $r['pricePerUnit']->toFixed(),
            'variableOnlyPricePerUnit' => $r['variableOnly']->toFixed(),
            'selectedTotal' => $r['selected']->toFixed(),
            'variableTotal' => $r['variable']->toFixed(),
            'fixedTotal' => $r['fixed']->toFixed(),
            'includesFixed' => $r['includesFixed'],
            'note' => 'Tariffa media del periodo: costo delle voci selezionate diviso il consumo.',
        ];
    }

    public function addVersion(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.manage');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, self::versionBody());
        $cid = $ctx->companyId();
        $t = DB::table('utility_tariffs')->where('id', $id)->where('company_id', $cid)->first(['id', 'unit', 'kind']);
        if (! $t) {
            throw AppError::notFound('Tariffa');
        }
        $watch = ChangeAlerts::watch($cid, 'tariffs', [$id]);
        $v = DB::transaction(function () use ($cid, $ctx, $t, $body, $id) {
            $v = self::insertVersion($cid, $ctx->userId(), (array) $t, $body);
            if (! empty($body['billFileId'])) {
                TariffBillController::attach($cid, $id, $body['billFileId'], $v);
            }

            return $v;
        });
        $affected = Costing::invalidate($cid, 'tariffs', [$id]);
        ChangeAlerts::commit($watch, $ctx->userId(), ['source' => ! empty($body['billFileId']) || ($body['mode'] ?? '') === 'bill' ? 'Nuova bolletta' : 'Nuovo valore dell’utenza']);

        return ['id' => $v, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    public function deleteVersion(Request $req, string $id, string $versionId): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.manage');
        [$id, $versionId] = $this->uuids(['id' => $id, 'versionId' => $versionId]);
        $cid = $ctx->companyId();
        $watch = ChangeAlerts::watch($cid, 'tariffs', [$id]);
        $n = DB::table('tariff_versions')->where('id', $versionId)->where('tariff_id', $id)->where('company_id', $cid)->delete();
        if (! $n) {
            throw AppError::notFound('Versione della tariffa');
        }
        Audit::log($cid, $ctx->userId(), 'tariff_version', $versionId, 'deleted');
        $affected = Costing::invalidate($cid, 'tariffs', [$id]);
        ChangeAlerts::commit($watch, $ctx->userId(), ['source' => 'Valore dell’utenza eliminato']);

        return ['ok' => true, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    /** NUOVO — modifica di un valore già registrato (correzione di un errore): stesso modulo dell'inserimento. */
    public function updateVersion(Request $req, string $id, string $versionId): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.manage');
        [$id, $versionId] = $this->uuids(['id' => $id, 'versionId' => $versionId]);
        $body = $this->parseBody($req, self::versionBody());
        $cid = $ctx->companyId();
        $t = DB::table('utility_tariffs')->where('id', $id)->where('company_id', $cid)->first(['id', 'unit', 'kind']);
        $old = $t ? DB::table('tariff_versions')->where('id', $versionId)->where('tariff_id', $id)->where('company_id', $cid)->first(['id', 'price_per_unit', 'valid_from']) : null;
        if (! $t || ! $old) {
            throw AppError::notFound('Valore della tariffa');
        }
        [$price, $bill] = self::priceAndBill((array) $t, $body);
        if (DB::table('tariff_versions')->where('tariff_id', $id)->where('valid_from', $body['validFrom'])->where('id', '<>', $versionId)->exists()) {
            throw AppError::conflict('version_date_conflict', 'Esiste già un valore con questa data di validità.', ['fields' => ['validFrom' => 'Data già usata.']]);
        }
        $watch = ChangeAlerts::watch($cid, 'tariffs', [$id]);
        DB::transaction(function () use ($versionId, $price, $bill, $body, $cid, $id) {
            DB::table('tariff_versions')->where('id', $versionId)->update([
                'price_per_unit' => Dec::of($price)->toFixed(8),
                'valid_from' => $body['validFrom'],
                'origin' => $body['mode'],
                'm3_to_smc' => $body['m3ToSmc'] ?? null,
                'smc_to_kwh' => $body['smcToKwh'] ?? null,
                'bill' => $bill ? json_encode($bill, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
                'notes' => $body['notes'] ?? null,
            ]);
            if (! empty($body['billFileId'])) {
                TariffBillController::attach($cid, $id, $body['billFileId'], $versionId);
            }
        });
        Audit::log($cid, $ctx->userId(), 'tariff_version', $versionId, 'updated', ['before' => ['pricePerUnit' => $old->price_per_unit, 'validFrom' => $old->valid_from], 'after' => ['pricePerUnit' => $price, 'validFrom' => $body['validFrom']]]);
        $affected = Costing::invalidate($cid, 'tariffs', [$id]);
        ChangeAlerts::commit($watch, $ctx->userId(), ['source' => 'Valore dell’utenza corretto']);

        return ['ok' => true, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    /**
     * NUOVO — eliminazione di un'utenza creata per errore, con valori e bollette archiviate.
     * Non è possibile se uno strumento la usa (si scollega lo strumento o si archivia l'utenza).
     */
    public function destroy(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.manage');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();
        $t = DB::table('utility_tariffs')->where('id', $id)->where('company_id', $cid)->first(['id', 'name']);
        if (! $t) {
            throw AppError::notFound('Tariffa');
        }
        $eq = DB::table('equipment')->where('company_id', $cid)->where(fn ($q) => $q->where('electric_tariff_id', $id)->orWhere('gas_tariff_id', $id))->orderBy('name')->pluck('name');
        if ($eq->isNotEmpty()) {
            $names = $eq->take(3)->implode(', ').($eq->count() > 3 ? ' e altri '.($eq->count() - 3) : '');
            throw AppError::conflict('tariff_in_use', "L’utenza è collegata a {$eq->count()} strumenti ({$names}): collega gli strumenti a un’altra utenza oppure archiviala.");
        }
        $files = DB::table('tariff_bills')->where('tariff_id', $id)->where('company_id', $cid)->pluck('storage_path');
        DB::transaction(function () use ($id) {
            DB::table('tariff_bills')->where('tariff_id', $id)->delete();
            DB::table('tariff_versions')->where('tariff_id', $id)->delete();
            DB::table('utility_tariffs')->where('id', $id)->delete();
        });
        foreach ($files as $f) {
            @unlink(storage_path('app/'.$f));
        }
        Audit::log($cid, $ctx->userId(), 'tariff', $id, 'deleted', ['name' => $t->name, 'bills' => $files->count()]);

        return ['ok' => true];
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
        $ctx = $this->requireCompany($req, 'tariffs.manage');
        $id = $this->uuid($id);
        $exists = DB::table('utility_tariffs')->where('id', $id)->where('company_id', $ctx->companyId())->exists();
        if (! $exists) {
            throw AppError::notFound('Tariffa');
        }
        DB::table('utility_tariffs')->where('id', $id)->update(['archived_at' => $archived ? Clock::now() : null]);

        return ['ok' => true];
    }

    /** Prezzo e dettaglio da bolletta di un valore (comune a inserimento e modifica). @return array{0:string,1:?array} */
    private static function priceAndBill(array $t, array $body): array
    {
        $bill = null;
        if ($body['mode'] === 'direct') {
            $price = $body['pricePerUnit'];
        } else {
            if ($body['consumptionUnit'] !== $t['unit']) {
                throw AppError::badRequest('validation_failed', "Il consumo in bolletta deve essere espresso nell’unità della tariffa ({$t['unit']}).", ['fields' => ['consumptionUnit' => 'Unità non coerente.']]);
            }
            if ($body['periodTo'] < $body['periodFrom']) {
                throw AppError::badRequest('validation_failed', 'Il periodo della bolletta non è coerente.', ['fields' => ['periodTo' => 'Fine precedente all’inizio.']]);
            }
            $r = self::computeBillTariff($body);
            $price = $r['pricePerUnit']->toFixed();
            $bill = [
                'periodFrom' => $body['periodFrom'],
                'periodTo' => $body['periodTo'],
                'consumption' => $body['consumption'],
                'consumptionUnit' => $body['consumptionUnit'],
                'vatBasis' => 'net',
                'components' => $body['components'],
                'selectedTotal' => $r['selected']->toFixed(),
                'variableTotal' => $r['variable']->toFixed(),
                'fixedTotal' => $r['fixed']->toFixed(),
                'includesFixed' => $r['includesFixed'],
            ];
        }
        if ($t['kind'] !== 'gas' && (! empty($body['m3ToSmc']) || ! empty($body['smcToKwh']))) {
            throw AppError::badRequest('validation_failed', 'I coefficienti di conversione si applicano solo alle tariffe gas.');
        }

        return [$price, $bill];
    }

    private static function insertVersion(string $companyId, string $userId, array $t, array $body): string
    {
        [$price, $bill] = self::priceAndBill($t, $body);
        if (DB::table('tariff_versions')->where('tariff_id', $t['id'])->where('valid_from', $body['validFrom'])->exists()) {
            throw AppError::conflict('version_date_conflict', 'Esiste già un valore con questa data di validità.', ['fields' => ['validFrom' => 'Data già usata.']]);
        }
        $id = (string) Str::uuid();
        DB::table('tariff_versions')->insert([
            'id' => $id,
            'company_id' => $companyId,
            'tariff_id' => $t['id'],
            // NUMERIC(18,8) dell'originale: arrotondamento a 8 decimali come PostgreSQL
            'price_per_unit' => Dec::of($price)->toFixed(8),
            'valid_from' => $body['validFrom'],
            'origin' => $body['mode'],
            'm3_to_smc' => $body['m3ToSmc'] ?? null,
            'smc_to_kwh' => $body['smcToKwh'] ?? null,
            'bill' => $bill ? json_encode($bill, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
            'notes' => $body['notes'] ?? null,
            'created_by' => $userId,
            'created_at' => Clock::now(),
        ]);
        Audit::log($companyId, $userId, 'tariff_version', $id, 'created', ['tariffId' => $t['id'], 'pricePerUnit' => $price, 'validFrom' => $body['validFrom'], 'origin' => $body['mode']]);

        return $id;
    }
}
