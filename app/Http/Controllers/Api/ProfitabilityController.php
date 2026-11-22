<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Auth\AuthContext;
use App\Domain\Costing\Calculators;
use App\Domain\Costing\Dec;
use App\Domain\Profitability\BreakEven;
use App\Http\Controllers\Controller;
use App\Services\Audit;
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
 * NUOVO — Coefficiente di redditività: quanti piatti servono per coprire i costi fissi.
 * Visibile e modificabile SOLO dall'amministratore dell'azienda (anche il superadmin in assistenza,
 * che entra come amministratore). Usa stipendi, affitti e finanziamenti: nessun altro ruolo lo vede.
 */
final class ProfitabilityController extends Controller
{
    public const CATEGORIES = [
        'rent' => 'Affitto',
        'mortgage' => 'Mutuo',
        'loan' => 'Finanziamento',
        'leasing' => 'Leasing / rate',
        'insurance' => 'Assicurazione',
        'utilities' => 'Utenze (canoni fissi)',
        'services' => 'Servizi (commercialista, software…)',
        'other' => 'Altro',
    ];

    private function admin(Request $req): AuthContext
    {
        $ctx = $this->requireCompany($req);
        if ($ctx->role !== 'admin') {
            throw AppError::forbidden();
        }

        return $ctx;
    }

    private static function money(?Dec $v): ?string
    {
        return $v?->toDecimalPlaces(4)->toFixed();
    }

    /** @return array{closedWeekdays: list<int>, includeStaff: bool, referenceRecipeId: ?string} */
    private static function settings(string $cid): array
    {
        $s = DB::table('profitability_settings')->where('company_id', $cid)->first();

        return [
            'closedWeekdays' => $s ? array_values(array_map('intval', json_decode($s->closed_weekdays, true))) : [],
            'includeStaff' => $s ? (bool) $s->include_staff : true,
            'referenceRecipeId' => $s->reference_recipe_id ?? null,
        ];
    }

    public function show(Request $req): array
    {
        $ctx = $this->admin($req);
        $cid = $ctx->companyId();
        $date = Clock::today();
        $settings = self::settings($cid);
        $openDays = 7 - count($settings['closedWeekdays']);

        // 1) costi fissi inseriti dall'amministratore
        $items = DB::table('fixed_costs')->where('company_id', $cid)->orderBy('valid_from')->orderBy('name')->get();
        $lines = [];
        $fixedCosts = [];
        foreach ($items as $f) {
            $active = $f->valid_from <= $date && ($f->valid_to === null || $f->valid_to >= $date);
            $monthly = BreakEven::monthly(Dec::of($f->amount), $f->period);
            $fixedCosts[] = [
                'id' => $f->id, 'name' => $f->name, 'category' => $f->category, 'categoryLabel' => self::CATEGORIES[$f->category] ?? $f->category,
                'amount' => Dec::of($f->amount)->toFixed(), 'period' => $f->period, 'validFrom' => $f->valid_from, 'validTo' => $f->valid_to,
                'notes' => $f->notes, 'monthly' => self::money($monthly), 'active' => $active,
                'status' => $active ? 'active' : ($f->valid_from > $date ? 'future' : 'ended'),
            ];
            if ($active) {
                $lines[] = ['source' => 'fixed_cost', 'label' => $f->name, 'detail' => self::CATEGORIES[$f->category] ?? null, 'monthly' => $monthly];
            }
        }

        // 2) personale: costo aziendale mensile dei dipendenti attivi (già comprende oneri, altri costi e voce extra)
        $staff = ['count' => 0, 'missing' => 0, 'monthly' => Dec::zero()];
        $empIds = DB::table('employees')->where('company_id', $cid)->whereNull('archived_at')->pluck('id')->all();
        if ($empIds) {
            $emps = Costing::loadEmployees($cid, $empIds, $date);
            $staff['missing'] = count($empIds) - count($emps);
            foreach ($emps as $e) {
                try {
                    $staff['monthly'] = $staff['monthly']->plus(Calculators::employeeRates($e)['companyMonthly']);
                    $staff['count']++;
                } catch (\Throwable) {
                    $staff['missing']++;
                }
            }
        }
        if ($settings['includeStaff'] && $staff['count'] > 0) {
            $lines[] = ['source' => 'staff', 'label' => 'Personale', 'detail' => $staff['count'] === 1 ? '1 dipendente' : "{$staff['count']} dipendenti", 'monthly' => $staff['monthly']];
        }

        // 3) quote fisse delle bollette NON incluse nel prezzo unitario (quelle incluse sono già nel costo dell'energia dei piatti)
        $tariffs = DB::table('utility_tariffs')->where('company_id', $cid)->whereNull('archived_at')->get(['id', 'name']);
        $versions = $tariffs->isEmpty() ? [] : Costing::latestAt('tariff_versions', 'tariff_id', $tariffs->pluck('id')->all(), $date);
        foreach ($tariffs as $t) {
            $v = $versions[$t->id] ?? null;
            if (! $v || $v->origin !== 'bill' || ! $v->bill) {
                continue;
            }
            $bill = json_decode($v->bill, true);
            $fixed = Dec::sum(array_map(fn ($c) => Dec::of($c['amount']), array_filter($bill['components'] ?? [], fn ($c) => ($c['kind'] ?? '') === 'fixed' && empty($c['include']))));
            if ($fixed->gt(0)) {
                $days = (int) (new \DateTimeImmutable($bill['periodFrom']))->diff(new \DateTimeImmutable($bill['periodTo']))->days + 1;
                $lines[] = ['source' => 'bill', 'label' => "Quote fisse · {$t->name}", 'detail' => "bolletta di {$days} giorni", 'monthly' => BreakEven::billMonthly($fixed, $days)];
            }
        }

        $monthly = Dec::sum(array_map(fn ($l) => $l['monthly'], $lines));
        $periods = $openDays > 0 ? BreakEven::fixedPeriods($monthly, $openDays) : null;

        // 4) piatti: ricette non archiviate con il loro prezzo in menu
        $recipes = DB::table('recipes as r')->leftJoin('recipe_prices as p', 'p.recipe_id', '=', 'r.id')
            ->where('r.company_id', $cid)->where('r.status', '!=', 'archived')->orderBy('r.title')
            ->get(['r.id', 'r.code', 'r.title', 'r.category', 'r.status', 'p.menu_price', 'p.vat_percent']);
        $vals = Costing::currentValuations($cid, $recipes->pluck('id')->all(), $date);
        $dishes = [];
        foreach ($recipes as $r) {
            $v = $vals[$r->id] ?? null;
            $variable = null;
            if ($v && isset($v['expanded']['ingredients'], $v['expanded']['energy'])) {
                $variable = Dec::of($v['expanded']['ingredients'])->plus($v['expanded']['energy']);
            }
            $vat = Dec::of($r->vat_percent ?? '10');
            $res = $openDays > 0
                ? BreakEven::dish($r->menu_price !== null ? Dec::of($r->menu_price) : null, $vat, $variable, isset($v['portions']) ? Dec::of($v['portions']) : null, $monthly, $openDays)
                : ['netPrice' => null, 'variableCost' => null, 'margin' => null, 'marginPercent' => null, 'perWeek' => null, 'perOpenDay' => null, 'perMonth' => null, 'issue' => 'no_open_days'];
            $dishes[] = [
                'recipeId' => $r->id, 'code' => $r->code, 'title' => $r->title, 'category' => $r->category, 'status' => $r->status,
                'menuPrice' => $r->menu_price !== null ? Dec::of($r->menu_price)->toFixed(2) : null, 'vatPercent' => $vat->toFixed(),
                'portions' => $v['portions'] ?? null, 'costComplete' => (bool) ($v['complete'] ?? false),
                'netPrice' => self::money($res['netPrice']), 'variableCost' => self::money($res['variableCost']),
                'margin' => self::money($res['margin']), 'marginPercent' => $res['marginPercent']?->toDecimalPlaces(2)->toFixed(),
                'perWeek' => $res['perWeek'], 'perOpenDay' => $res['perOpenDay'], 'perMonth' => $res['perMonth'], 'issue' => $res['issue'],
            ];
        }

        return [
            'date' => $date,
            'settings' => $settings,
            'openDaysPerWeek' => $openDays,
            'categories' => self::CATEGORIES,
            'fixedCosts' => $fixedCosts,
            'staff' => ['count' => $staff['count'], 'missing' => $staff['missing'], 'monthly' => self::money($staff['monthly']), 'included' => $settings['includeStaff']],
            'lines' => array_map(fn ($l) => [...$l, 'monthly' => self::money($l['monthly']), 'weekly' => self::money($l['monthly']->times(12)->div(52))], $lines),
            'totals' => ['monthly' => self::money($monthly), 'weekly' => self::money($periods['weekly'] ?? null), 'perOpenDay' => self::money($periods['perOpenDay'] ?? null)],
            'dishes' => $dishes,
        ];
    }

    public function updateSettings(Request $req): array
    {
        $ctx = $this->admin($req);
        $b = $this->parseBody($req, S::object([
            'closedWeekdays' => S::array(S::int(1, 7))->max(6, 'Almeno un giorno di apertura alla settimana.'),
            'includeStaff' => S::bool(),
            'referenceRecipeId' => S::uuid()->nullable(),
        ]));
        if ($b['referenceRecipeId'] && ! DB::table('recipes')->where('id', $b['referenceRecipeId'])->where('company_id', $ctx->companyId())->exists()) {
            throw AppError::badRequest('invalid_reference', 'La ricetta indicata non esiste.', ['fields' => ['referenceRecipeId' => 'Ricetta non trovata.']]);
        }
        $days = array_values(array_unique($b['closedWeekdays']));
        sort($days);
        DB::table('profitability_settings')->upsert([[
            'company_id' => $ctx->companyId(), 'closed_weekdays' => json_encode($days), 'include_staff' => $b['includeStaff'] ? 1 : 0,
            'reference_recipe_id' => $b['referenceRecipeId'], 'updated_at' => Clock::now(),
        ]], ['company_id'], ['closed_weekdays', 'include_staff', 'reference_recipe_id', 'updated_at']);
        Audit::log($ctx->companyId(), $ctx->userId(), 'profitability', null, 'settings_updated', ['closedWeekdays' => $days, 'includeStaff' => $b['includeStaff']]);

        return ['ok' => true];
    }

    private static function fixedCostSchema(): Schema
    {
        return S::object([
            'name' => S::reqText('Il nome della voce', 160),
            'category' => S::enum(array_keys(self::CATEGORIES)),
            'amount' => S::dec(['min' => 0, 'label' => 'L’importo']),
            'period' => S::enum(BreakEven::PERIODS),
            'validFrom' => S::isoDate(),
            'validTo' => S::isoDate()->nullable()->optional(),
            'notes' => S::optText(500),
        ])->refine(fn ($v) => empty($v['validTo']) || $v['validTo'] >= $v['validFrom'], 'La data di fine non può precedere l’inizio.', ['validTo']);
    }

    private static function fixedCostRow(array $b): array
    {
        return ['name' => $b['name'], 'category' => $b['category'], 'amount' => $b['amount'], 'period' => $b['period'], 'valid_from' => $b['validFrom'], 'valid_to' => $b['validTo'] ?? null, 'notes' => $b['notes'] ?? null];
    }

    public function storeFixedCost(Request $req): array
    {
        $ctx = $this->admin($req);
        $b = $this->parseBody($req, self::fixedCostSchema());
        $id = (string) Str::uuid();
        DB::table('fixed_costs')->insert([...self::fixedCostRow($b), 'id' => $id, 'company_id' => $ctx->companyId(), 'created_by' => $ctx->userId(), 'created_at' => Clock::now(), 'updated_at' => Clock::now()]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'fixed_cost', $id, 'created', ['name' => $b['name']]);

        return ['id' => $id];
    }

    public function updateFixedCost(Request $req, string $id): array
    {
        $ctx = $this->admin($req);
        $id = $this->uuid($id);
        $b = $this->parseBody($req, self::fixedCostSchema());
        $n = DB::table('fixed_costs')->where('id', $id)->where('company_id', $ctx->companyId())->update([...self::fixedCostRow($b), 'updated_at' => Clock::now()]);
        if (! $n && ! DB::table('fixed_costs')->where('id', $id)->where('company_id', $ctx->companyId())->exists()) {
            throw AppError::notFound();
        }
        Audit::log($ctx->companyId(), $ctx->userId(), 'fixed_cost', $id, 'updated', ['name' => $b['name']]);

        return ['ok' => true];
    }

    public function destroyFixedCost(Request $req, string $id): array
    {
        $ctx = $this->admin($req);
        $id = $this->uuid($id);
        if (! DB::table('fixed_costs')->where('id', $id)->where('company_id', $ctx->companyId())->delete()) {
            throw AppError::notFound();
        }
        Audit::log($ctx->companyId(), $ctx->userId(), 'fixed_cost', $id, 'deleted');

        return ['ok' => true];
    }

    /** Prezzo in menu (IVA inclusa) di una ricetta; menuPrice null = rimuovi il prezzo. */
    public function updatePrice(Request $req, string $recipeId): array
    {
        $ctx = $this->admin($req);
        $recipeId = $this->uuid($recipeId);
        $b = $this->parseBody($req, S::object([
            'menuPrice' => S::decOpt(['min' => 0, 'max' => 99999, 'label' => 'Il prezzo']),
            'vatPercent' => S::dec(['min' => 0, 'max' => 100, 'label' => 'L’IVA']),
        ]));
        if (! DB::table('recipes')->where('id', $recipeId)->where('company_id', $ctx->companyId())->exists()) {
            throw AppError::notFound();
        }
        if ($b['menuPrice'] === null) {
            DB::table('recipe_prices')->where('recipe_id', $recipeId)->delete();
        } else {
            DB::table('recipe_prices')->upsert([[
                'recipe_id' => $recipeId, 'company_id' => $ctx->companyId(), 'menu_price' => Dec::of($b['menuPrice'])->toDecimalPlaces(2)->toFixed(2),
                'vat_percent' => $b['vatPercent'], 'updated_at' => Clock::now(),
            ]], ['recipe_id'], ['menu_price', 'vat_percent', 'updated_at']);
        }
        Audit::log($ctx->companyId(), $ctx->userId(), 'recipe', $recipeId, 'menu_price_updated', ['menuPrice' => $b['menuPrice'], 'vatPercent' => $b['vatPercent']]);

        return ['ok' => true];
    }
}
