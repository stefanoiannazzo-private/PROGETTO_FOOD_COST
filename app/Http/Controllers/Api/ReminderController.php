<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Support\Clock;
use App\Support\Validation\S;
use Carbon\CarbonImmutable;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * NUOVO — Promemoria mensile: dal giorno 10 del mese (ora italiana), alla prima apertura dell'app
 * e alle 3 successive, ricorda di caricare le fatture dei fornitori e le bollette.
 * Solo a chi può farlo, mai in «Assisti». «Ho già fatto» lo chiude fino al mese dopo.
 */
class ReminderController extends Controller
{
    public function current(Request $req): array
    {
        $auth = $this->requireCompany($req);
        $now = $this->now();
        $period = $now->format('Y-m');
        $canInvoices = $auth->can('imports.manage') && $auth->can('ingredients.manage') && $auth->can('costs.read');
        $canBills = $auth->can('tariffs.manage');
        $times = max(1, (int) config('foodcost.reminder_times'));
        $row = DB::table('reminder_views')->where(['user_id' => $auth->userId(), 'company_id' => $auth->companyId(), 'period' => $period])->first();
        $shown = (int) ($row->shown ?? 0);
        $due = ! $auth->assist && ($canInvoices || $canBills)
            && (int) $now->format('j') >= (int) config('foodcost.reminder_day')
            && ! ($row->done_at ?? null) && $shown < $times;

        $monthStart = $now->startOfMonth()->setTimezone('UTC')->format('Y-m-d H:i:s');
        $cid = $auth->companyId();

        return [
            'due' => $due,
            'period' => $period,
            'monthLabel' => self::MONTHS[(int) $now->format('n') - 1],
            'timesLeft' => max(0, $times - $shown - ($due ? 1 : 0)),
            'canInvoices' => $canInvoices,
            'canBills' => $canBills,
            'status' => [
                'invoicesThisMonth' => $canInvoices ? DB::table('supplier_invoices')->where('company_id', $cid)->where('created_at', '>=', $monthStart)->count() : null,
                'lastInvoiceAt' => $canInvoices ? Clock::iso(DB::table('supplier_invoices')->where('company_id', $cid)->max('created_at')) : null,
                'billsThisMonth' => $canBills ? DB::table('tariff_bills')->where('company_id', $cid)->where('created_at', '>=', $monthStart)->count() : null,
                'lastBillAt' => $canBills ? Clock::iso(DB::table('tariff_bills')->where('company_id', $cid)->max('created_at')) : null,
            ],
        ];
    }

    /** Il promemoria è stato mostrato (una volta per apertura dell'app). */
    public function seen(Request $req): array
    {
        $auth = $this->requireCompany($req);
        $period = $this->period($req);
        if (! $auth->assist) {
            $key = ['user_id' => $auth->userId(), 'company_id' => $auth->companyId(), 'period' => $period];
            DB::table('reminder_views')->insertOrIgnore([...$key, 'shown' => 0]);
            DB::table('reminder_views')->where($key)->update(['shown' => DB::raw('shown + 1'), 'last_shown_at' => Clock::now()]);
        }

        return ['ok' => true];
    }

    /** «Ho già fatto»: non mostrarlo più per questo mese. */
    public function done(Request $req): array
    {
        $auth = $this->requireCompany($req);
        $period = $this->period($req);
        if (! $auth->assist) {
            $key = ['user_id' => $auth->userId(), 'company_id' => $auth->companyId(), 'period' => $period];
            DB::table('reminder_views')->insertOrIgnore([...$key, 'shown' => 0]);
            DB::table('reminder_views')->where($key)->update(['done_at' => Clock::now()]);
        }

        return ['ok' => true];
    }

    private const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

    private function now(): CarbonImmutable
    {
        return CarbonImmutable::now((string) config('foodcost.reminder_timezone'));
    }

    /** Solo il mese corrente (o quello appena finito, se l'app era aperta a cavallo di mezzanotte). */
    private function period(Request $req): string
    {
        $body = $this->parseBody($req, S::object(['period' => S::string()->regex('/^\d{4}-\d{2}$/', 'Periodo non valido.')]));
        $now = $this->now();
        if (! in_array($body['period'], [$now->format('Y-m'), $now->subMonthNoOverflow()->format('Y-m')], true)) {
            throw new \App\Support\AppError(422, 'validation_failed', 'Periodo non valido.');
        }

        return $body['period'];
    }
}
