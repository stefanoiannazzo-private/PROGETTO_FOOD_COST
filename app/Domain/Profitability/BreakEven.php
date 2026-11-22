<?php

declare(strict_types=1);

namespace App\Domain\Profitability;

use App\Domain\Costing\Dec;
use Brick\Math\RoundingMode;

/**
 * NUOVO — Coefficiente di redditività (punto di pareggio espresso in piatti).
 *
 *   piatti da vendere = costi fissi del periodo ÷ guadagno per piatto
 *   guadagno per piatto = prezzo in menu senza IVA − costo variabile per porzione
 *   costo variabile per porzione = (ingredienti + energia, inclusi i semilavorati) ÷ porzioni
 *
 * La manodopera NON è un costo variabile: gli stipendi si pagano comunque e sono già tra i costi fissi
 * (contarla anche nel piatto la conterebbe due volte).
 * Periodi: un mese medio vale 52/12 settimane; i costi annuali valgono 1/12 al mese, quelli settimanali 52/12.
 * Il numero di piatti è sempre arrotondato per eccesso: 82,2 piatti significa che ne servono 83.
 */
final class BreakEven
{
    public const PERIODS = ['weekly', 'monthly', 'yearly'];

    /** Importo di una voce di costo fisso riportato al mese. */
    public static function monthly(Dec $amount, string $period): Dec
    {
        return match ($period) {
            'weekly' => $amount->times(52)->div(12),
            'monthly' => $amount,
            'yearly' => $amount->div(12),
        };
    }

    /** Quota fissa di una bolletta (voci fisse non incluse nel prezzo unitario) riportata al mese medio. */
    public static function billMonthly(Dec $fixedNotIncluded, int $periodDays): Dec
    {
        return $fixedNotIncluded->div($periodDays)->times('30.4375');
    }

    public static function netPrice(Dec $menuPrice, Dec $vatPercent): Dec
    {
        return $menuPrice->div(Dec::of(100)->plus($vatPercent))->times(100);
    }

    public static function ceil(Dec $v): int
    {
        return $v->big()->toScale(0, RoundingMode::Ceiling)->toInt();
    }

    /**
     * @param  Dec  $monthlyFixed  somma dei costi fissi mensili
     * @param  int  $openDaysPerWeek  giorni di apertura in una settimana (1–7)
     * @return array{weekly: Dec, perOpenDay: Dec}
     */
    public static function fixedPeriods(Dec $monthlyFixed, int $openDaysPerWeek): array
    {
        $weekly = $monthlyFixed->times(12)->div(52);

        return ['weekly' => $weekly, 'perOpenDay' => $weekly->div($openDaysPerWeek)];
    }

    /**
     * Risultato per un piatto.
     *
     * @return array{netPrice: ?Dec, variableCost: ?Dec, margin: ?Dec, marginPercent: ?Dec, perWeek: ?int, perOpenDay: ?int, perMonth: ?int, issue: ?string}
     */
    public static function dish(?Dec $menuPrice, Dec $vatPercent, ?Dec $variableBatch, ?Dec $portions, Dec $monthlyFixed, int $openDaysPerWeek): array
    {
        $out = ['netPrice' => null, 'variableCost' => null, 'margin' => null, 'marginPercent' => null, 'perWeek' => null, 'perOpenDay' => null, 'perMonth' => null, 'issue' => null];
        if ($portions === null || ! $portions->gt(0)) {
            $out['issue'] = 'missing_portions';

            return $out;
        }
        if ($variableBatch !== null) {
            $out['variableCost'] = $variableBatch->div($portions);
        }
        if ($menuPrice === null) {
            $out['issue'] = 'missing_price';

            return $out;
        }
        $out['netPrice'] = self::netPrice($menuPrice, $vatPercent);
        if ($out['variableCost'] === null) {
            $out['issue'] = 'missing_cost';

            return $out;
        }
        $out['margin'] = $out['netPrice']->minus($out['variableCost']);
        if (! $out['netPrice']->isZero()) {
            $out['marginPercent'] = $out['margin']->div($out['netPrice'])->times(100);
        }
        if (! $out['margin']->gt(0)) {
            $out['issue'] = 'no_margin';

            return $out;
        }
        $p = self::fixedPeriods($monthlyFixed, $openDaysPerWeek);
        $out['perWeek'] = self::ceil($p['weekly']->div($out['margin']));
        $out['perOpenDay'] = self::ceil($p['perOpenDay']->div($out['margin']));
        $out['perMonth'] = self::ceil($monthlyFixed->div($out['margin']));

        return $out;
    }
}
