<?php

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Dec;
use App\Http\Controllers\Controller;
use App\Services\Sales;
use App\Support\AppError;
use App\Support\Validation\S;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * NUOVO — Statistiche di vendita (area Ordini): incassi, coperti, piatti più venduti, margini,
 * orari e giorni di punta, camerieri, tempi di tavolo e di cucina. Ora italiana.
 */
class SalesController extends Controller
{
    private const DAYS = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];

    public function stats(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'sales.read');
        $cid = $ctx->companyId();
        $q = $this->parseQuery($req, S::object(['from' => S::isoDate(), 'to' => S::isoDate()]));
        $from = CarbonImmutable::parse($q['from'], Sales::TZ)->startOfDay();
        $to = CarbonImmutable::parse($q['to'], Sales::TZ)->startOfDay()->addDay();
        if ($to <= $from || $from->diffInDays($to) > 366) {
            throw new AppError(422, 'validation_failed', 'Scegli un periodo di massimo un anno.');
        }
        $showCost = $ctx->can('costs.read');
        $lines = Sales::lines($cid, $from, $to);
        $c = Sales::contribution($lines);
        $sessions = DB::table('table_sessions')->where('company_id', $cid)->where('status', 'closed')
            ->where('closed_at', '>=', Sales::utc($from))->where('closed_at', '<', Sales::utc($to))->get();
        $revenue = Dec::sum($sessions->map(fn ($s) => Dec::of($s->total ?? '0'))->all());
        $covers = (int) $sessions->sum('covers');
        $local = fn (?string $utc) => $utc ? CarbonImmutable::parse($utc, 'UTC')->setTimezone(Sales::TZ) : null;

        // piatti
        $sections = DB::table('menu_items as m')->join('menu_sections as s', 's.id', '=', 'm.section_id')->where('m.company_id', $cid)->pluck('s.name', 'm.id');
        $items = $lines->groupBy(fn ($l) => $l->menu_item_id ?? $l->name)->map(function ($g) use ($sections, $showCost) {
            $f = $g->first();
            $cc = Sales::contribution($g);

            return [
                'name' => $f->name, 'section' => $sections[$f->menu_item_id] ?? null, 'qty' => (int) $g->sum('qty'),
                'revenue' => $this->m($cc['revenue']), 'margin' => $showCost && $cc['missingCostQty'] === 0 ? $this->m($cc['contribution']) : null,
                'marginPerDish' => $showCost && $cc['missingCostQty'] === 0 && $g->sum('qty') > 0 ? $this->m($cc['contribution']->div((string) $g->sum('qty'))) : null,
            ];
        })->sortByDesc('qty')->values();
        $bySection = $items->groupBy(fn ($i) => $i['section'] ?? 'Altro')->map(fn ($g, $k) => ['name' => $k, 'qty' => $g->sum('qty'), 'revenue' => $this->m(Dec::sum($g->map(fn ($i) => Dec::of($i['revenue']))->all()))])->sortByDesc('qty')->values();

        // orari e giorni
        $byHour = array_fill(0, 24, 0);
        foreach ($lines as $l) {
            $byHour[(int) $local($l->created_at)->format('G')] += (int) $l->qty;
        }
        $byWeekday = array_fill(0, 7, ['covers' => 0, 'revenue' => Dec::zero()]);
        $byDay = [];
        foreach ($sessions as $s) {
            $d = $local($s->closed_at);
            $w = (int) $d->format('N') - 1;
            $byWeekday[$w]['covers'] += (int) $s->covers;
            $byWeekday[$w]['revenue'] = $byWeekday[$w]['revenue']->plus($s->total ?? '0');
            $k = $d->format('Y-m-d');
            $byDay[$k] = ($byDay[$k] ?? Dec::zero())->plus($s->total ?? '0');
        }
        $days = [];
        for ($d = $from; $d < $to; $d = $d->addDay()) {
            $days[] = ['date' => $d->format('Y-m-d'), 'revenue' => $this->m($byDay[$d->format('Y-m-d')] ?? Dec::zero())];
        }

        // camerieri
        $names = DB::table('users')->whereIn('id', $lines->pluck('waiter_id')->filter()->unique()->merge($sessions->pluck('opened_by')->filter())->unique()->values())->pluck('name', 'id');
        $byWaiter = $lines->groupBy('waiter_id')->map(fn ($g, $uid) => [
            'name' => $names[$uid] ?? '—', 'items' => (int) $g->sum('qty'), 'revenue' => $this->m(Sales::contribution($g)['revenue']),
            'tables' => $sessions->where('opened_by', $uid)->count(),
        ])->sortByDesc('revenue')->values();

        // tempi
        $tableMinutes = $sessions->map(fn ($s) => (strtotime($s->closed_at) - strtotime($s->opened_at)) / 60)->filter(fn ($m) => $m > 0 && $m < 600);
        $prep = $lines->filter(fn ($l) => $l->sent_at && $l->ready_at)->map(fn ($l) => (strtotime($l->ready_at) - strtotime($l->sent_at)) / 60)->filter(fn ($m) => $m >= 0 && $m < 240);

        return [
            'from' => $q['from'], 'to' => $q['to'], 'costsVisible' => $showCost,
            'kpis' => [
                'revenue' => $this->m($revenue), 'tables' => $sessions->count(), 'covers' => $covers,
                'perCover' => $covers > 0 ? $this->m($revenue->div((string) $covers)) : null,
                'dishes' => (int) $lines->sum('qty'),
                'margin' => $showCost ? $this->m($c['contribution']) : null,
                'marginPercent' => $showCost && $c['revenueNet']->gt(0) ? $c['contribution']->div($c['revenueNet'])->times(100)->toDecimalPlaces(1)->toFixed() : null,
                'missingCostQty' => $c['missingCostQty'],
                'avgTableMinutes' => $tableMinutes->count() ? (int) round($tableMinutes->avg()) : null,
                'avgPrepMinutes' => $prep->count() ? (int) round($prep->avg()) : null,
                'openTables' => DB::table('table_sessions')->where('company_id', $cid)->where('status', 'open')->count(),
            ],
            'items' => $items->take(50)->all(),
            'sections' => $bySection->all(),
            'byHour' => array_map(fn ($h, $n) => ['hour' => $h, 'qty' => $n], array_keys($byHour), $byHour),
            'byWeekday' => array_map(fn ($i, $w) => ['day' => self::DAYS[$i], 'covers' => $w['covers'], 'revenue' => $this->m($w['revenue'])], array_keys($byWeekday), $byWeekday),
            'byDay' => $days,
            'waiters' => $byWaiter->all(),
        ];
    }

    private function m(Dec $v): string
    {
        return $v->toDecimalPlaces(2)->toFixed(2);
    }
}
