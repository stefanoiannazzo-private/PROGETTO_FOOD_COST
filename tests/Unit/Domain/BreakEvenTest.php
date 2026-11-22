<?php

namespace Tests\Unit\Domain;

use App\Domain\Costing\Dec;
use App\Domain\Profitability\BreakEven as B;
use PHPUnit\Framework\TestCase;

class BreakEvenTest extends TestCase
{
    private static function d(string|int $v): Dec
    {
        return Dec::of($v);
    }

    public function test_conversione_dei_periodi(): void
    {
        $this->assertSame('1200', B::monthly(self::d(1200), 'monthly')->toFixed());
        $this->assertSame('100', B::monthly(self::d(1200), 'yearly')->toFixed());
        $this->assertSame('433.33', B::monthly(self::d(100), 'weekly')->toDecimalPlaces(2)->toFixed());
    }

    public function test_prezzo_senza_iva(): void
    {
        $this->assertSame('8.18', B::netPrice(self::d(9), self::d(10))->toDecimalPlaces(2)->toFixed());
        $this->assertSame('10', B::netPrice(self::d('12.2'), self::d(22))->toFixed());
        $this->assertSame('5', B::netPrice(self::d(5), self::d(0))->toFixed());
    }

    /** Esempio discusso con il cliente: 13.000 €/mese, pizza a 9 € IVA 10%, ingredienti + energia 2,10 €. */
    public function test_esempio_pizzeria(): void
    {
        // costo variabile del lotto: 10 pizze da 2,10 €
        $r = B::dish(self::d(9), self::d(10), self::d('21'), self::d(10), self::d(13000), 7);
        $this->assertNull($r['issue']);
        $this->assertSame('2.1', $r['variableCost']->toFixed());
        $this->assertSame('6.08', $r['margin']->toDecimalPlaces(2)->toFixed());
        // 13.000 × 12 / 52 = 3.000 €/settimana → 3.000 / 6,0818 = 493,3 → 494
        $this->assertSame(494, $r['perWeek']);
        // 7 giorni: 428,57 €/giorno → 70,47 → 71
        $this->assertSame(71, $r['perOpenDay']);
        $this->assertSame(2138, $r['perMonth']);
        // 6 giorni di apertura: stessa settimana, più piatti per giorno
        $r6 = B::dish(self::d(9), self::d(10), self::d('21'), self::d(10), self::d(13000), 6);
        $this->assertSame(494, $r6['perWeek']);
        $this->assertSame(83, $r6['perOpenDay']);
    }

    public function test_arrotondamento_per_eccesso_e_valori_esatti(): void
    {
        $this->assertSame(83, B::ceil(self::d('82.2')));
        $this->assertSame(82, B::ceil(self::d('82')));
        $this->assertSame(1, B::ceil(self::d('0.0001')));
        // margine 5 €, 520 €/mese → 120 €/settimana → esattamente 24 piatti
        $r = B::dish(self::d(5), self::d(0), self::d(0), self::d(1), self::d(520), 5);
        $this->assertSame(24, $r['perWeek']);
        $this->assertSame(5, $r['perOpenDay']);
    }

    public function test_casi_senza_risposta(): void
    {
        $this->assertSame('missing_portions', B::dish(self::d(9), self::d(10), self::d(2), null, self::d(1000), 6)['issue']);
        $noPrice = B::dish(null, self::d(10), self::d(4), self::d(2), self::d(1000), 6);
        $this->assertSame('missing_price', $noPrice['issue']);
        $this->assertSame('2', $noPrice['variableCost']->toFixed());
        $this->assertSame('missing_cost', B::dish(self::d(9), self::d(10), null, self::d(2), self::d(1000), 6)['issue']);
        $loss = B::dish(self::d('2.2'), self::d(10), self::d(3), self::d(1), self::d(1000), 6);
        $this->assertSame('no_margin', $loss['issue']);
        $this->assertSame('-1', $loss['margin']->toFixed());
        $this->assertNull($loss['perWeek']);
    }

    public function test_quota_fissa_bolletta(): void
    {
        // 60 € di quote fisse su una bolletta di 61 giorni → 29,94 € al mese medio
        $this->assertSame('29.94', B::billMonthly(self::d(60), 61)->toDecimalPlaces(2)->toFixed());
    }
}
