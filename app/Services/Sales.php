<?php

namespace App\Services;

use App\Domain\Costing\Dec;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * NUOVO — Vendite registrate dall'area Ordini: righe ordinate (non annullate) dei tavoli chiusi o ancora aperti.
 * Il margine di ogni piatto = prezzo senza IVA − costo variabile del momento (ingredienti + energia),
 * lo stesso della Redditività: così «quanti piatti mancano al pareggio» torna con i costi fissi.
 */
class Sales
{
    public const TZ = 'Europe/Rome';

    /** Inizio e fine della settimana in corso, da lunedì a domenica, ora italiana. */
    public static function currentWeek(): array
    {
        $now = CarbonImmutable::now(self::TZ);
        $from = $now->startOfWeek(CarbonImmutable::MONDAY);

        return [$from, $from->addDays(7), $now];
    }

    public static function utc(CarbonImmutable $d): string
    {
        return $d->setTimezone('UTC')->format('Y-m-d H:i:s');
    }

    /** Righe vendute nel periodo (data dell'ordine), dei tavoli non annullati. */
    public static function lines(string $cid, CarbonImmutable $from, CarbonImmutable $to)
    {
        return DB::table('order_items as o')->join('table_sessions as s', 's.id', '=', 'o.session_id')
            ->where('o.company_id', $cid)->where('o.status', '<>', 'cancelled')->where('s.status', '<>', 'cancelled')
            ->where('o.created_at', '>=', self::utc($from))->where('o.created_at', '<', self::utc($to))
            ->get(['o.*', 's.covers', 's.opened_at', 's.closed_at', 's.status as session_status']);
    }

    /** Contributo ai costi fissi: Σ quantità × (prezzo netto − costo variabile). */
    public static function contribution($lines): array
    {
        $contribution = Dec::zero();
        $revenueNet = Dec::zero();
        $revenue = Dec::zero();
        $missing = 0;
        foreach ($lines as $l) {
            $qty = (string) $l->qty;
            $gross = Dec::of($l->unit_price)->times($qty);
            $net = Dec::of($l->unit_price)->div(Dec::of('1')->plus(Dec::of($l->vat_percent)->div('100')))->times($qty);
            $revenue = $revenue->plus($gross);
            $revenueNet = $revenueNet->plus($net);
            if ($l->unit_cost === null) {
                $missing += (int) $l->qty;

                continue;
            }
            $contribution = $contribution->plus($net->minus(Dec::of($l->unit_cost)->times($qty)));
        }

        return ['revenue' => $revenue, 'revenueNet' => $revenueNet, 'contribution' => $contribution, 'missingCostQty' => $missing];
    }
}
