<?php

namespace Tests\Feature;

use Tests\TestCase;

/** NUOVO — fasi di attesa, durate delle fasi e avviso sui tempi dei semilavorati (caso pizza). */
class RecipePhasesTest extends TestCase
{
    public function test_impasto_con_attese_e_pizza_che_lo_usa(): void
    {
        $c = $this->createCompany('Pizzeria Fasi');
        $this->addMember($c, $this->createUser('a@fasi.test', 'A'), 'admin');
        $a = $this->loginAs('a@fasi.test');
        $luce = $this->ok($a->post('/api/tariffs', ['name' => 'Luce', 'kind' => 'electricity', 'unit' => 'kwh', 'firstVersion' => ['mode' => 'direct', 'pricePerUnit' => '0.5', 'validFrom' => '2026-01-01']]))['id'];
        $imp = $this->ok($a->post('/api/equipment', ['code' => 'IMP', 'name' => 'Impastatrice', 'powerType' => 'electric', 'electricPowerKw' => '1.5', 'usageCoefficient' => '0.8', 'electricTariffId' => $luce]))['id'];
        $frigo = $this->ok($a->post('/api/equipment', ['code' => 'FRI', 'name' => 'Frigorifero', 'powerType' => 'electric', 'electricPowerKw' => '0.4', 'usageCoefficient' => '0.4', 'holdCoefficient' => '0.4', 'electricTariffId' => $luce]))['id'];
        $farina = $this->ok($a->post('/api/ingredients', ['code' => 'FAR', 'name' => 'Farina', 'category' => 'Farine', 'supplier' => 'Molino', 'packageContent' => '25', 'packageUnit' => 'kg', 'usageUnit' => 'g', 'initialPrice' => ['packagePrice' => '20', 'validFrom' => '2026-01-01']]))['id'];

        $impasto = $this->ok($a->post('/api/recipes', ['code' => 'IMPASTO', 'title' => 'Impasto pizza', 'status' => 'active', 'revision' => [
            'finalWeightKg' => '10', 
            'phases' => [
                ['key' => 'f1', 'name' => 'Impasto', 'durationMinutes' => '20'],
                ['key' => 'f2', 'name' => 'Prima lievitazione', 'durationMinutes' => '120', 'waiting' => true],
                ['key' => 'f3', 'name' => 'Panetti', 'durationMinutes' => '25'],
                ['key' => 'f4', 'name' => 'Maturazione in frigo', 'durationMinutes' => '1440', 'waiting' => true],
                ['key' => 'f5', 'name' => 'Lievitazione fuori frigo', 'durationMinutes' => '225', 'waiting' => true],
            ],
            'components' => [['kind' => 'ingredient', 'ingredientId' => $farina, 'quantity' => '6', 'unit' => 'kg']],
            // frigorifero per le 24 h di maturazione, al 10% dello spazio
            'equipmentUses' => [
                ['phaseKey' => 'f1', 'equipmentId' => $imp, 'segment' => 'work', 'minutes' => '20'],
                ['phaseKey' => 'f4', 'equipmentId' => $frigo, 'segment' => 'hold', 'minutes' => '1440', 'sharePercent' => '10'],
            ],
        ]]))['id'];
        $d = $this->ok($a->get("/api/recipes/{$impasto}"));
        $this->assertSame([false, true, false, true, true], array_column($d['revision']['phases'], 'waiting'));
        $this->assertSame(['20.00', '120.00', '25.00', '1440.00', '225.00'], array_column($d['revision']['phases'], 'durationMinutes'));
        // energia: impastatrice 1,5 × 20/60 × 0,8 = 0,4 kWh = 0,20 €; frigo 0,4 × 24 × 0,4 × 10% = 0,384 kWh = 0,192 €
        $this->assertSame(['0.2', '0.192'], array_column($d['valuation']['equipmentLines'], 'cost'));

        $pizza = $this->ok($a->post('/api/recipes', ['code' => 'MARG', 'title' => 'Pizza margherita', 'revision' => [
            'portions' => '1', 'components' => [['kind' => 'recipe', 'recipeId' => $impasto, 'quantity' => '250', 'unit' => 'g']],
        ]]))['id'];
        $p = $this->ok($a->get("/api/recipes/{$pizza}"));
        $this->assertSame([['recipeId' => $impasto, 'title' => 'Impasto pizza', 'minutes' => '1830.00', 'waitingMinutes' => '1785.00']], $p['subrecipeLeadTimes']);
    }
}
