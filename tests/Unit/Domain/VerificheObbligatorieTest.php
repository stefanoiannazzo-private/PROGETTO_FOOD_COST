<?php

namespace Tests\Unit\Domain;

use App\Domain\Costing\Calculators as C;
use App\Domain\Costing\DomainError;
use App\Domain\Costing\RecipeCostEngine;
use PHPUnit\Framework\TestCase;
use Tests\Unit\Domain\Fixtures as F;

/** Port di packages/domain/test/verifiche-obbligatorie.test.ts (verifiche numeriche del capitolato §14). */
class VerificheObbligatorieTest extends TestCase
{
    public function test_a_conversione_ingrediente(): void
    {
        $u = C::ingredientUsageCost(F::ingredient(['id' => 'farina', 'packagePrice' => '30', 'packageContent' => '5', 'packageUnit' => 'kg']), F::d(150), 'g');
        $this->assertSame('6', $u['unitPrice']->toFixed());
        $this->assertSame('0.9', $u['cost']->toFixed());
    }

    public function test_b_costo_dipendente(): void
    {
        $r = C::employeeRates(['grossMonthly' => F::d(2400), 'contributionsMode' => 'none', 'contributionsValue' => null, 'otherMonthlyCosts' => null, 'productiveHours' => F::d(160)]);
        $this->assertSame('15', $r['grossHourly']->toFixed());
        $this->assertSame('15', $r['companyHourly']->toFixed());
        $this->assertSame('0.25', $r['costPerMinute']->toFixed());
        $this->assertSame('gross_only', $r['basis']);
        $this->assertSame('3', C::laborCost(F::d(12), $r['costPerMinute'])->toFixed());
    }

    public function test_b_ricetta_segnala_solo_lordo(): void
    {
        $r = F::recipe(['id' => 'r', 'laborAssignments' => [['id' => 'l', 'employeeId' => 'e', 'activeMinutes' => F::d(12), 'share' => F::d(1)]]]);
        $res = RecipeCostEngine::valueRecipe(F::ctx(['recipes' => [$r], 'employees' => [['employeeId' => 'e', 'code' => 'E1', 'name' => 'Mario Rossi', 'grossMonthly' => F::d(2400), 'contributionsMode' => 'none', 'contributionsValue' => null, 'otherMonthlyCosts' => null, 'productiveHours' => F::d(160)]]]), 'r');
        $this->assertSame('3', $res['labor']->toFixed());
        $this->assertSame('gross_only', $res['laborLines'][0]['basis']);
        $this->assertTrue(collect($res['issues'])->contains(fn ($i) => $i['code'] === 'gross_only' && $i['severity'] === 'warning'));
    }

    public function test_c_consumo_elettrico(): void
    {
        $kwh = C::electricConsumptionKwh(F::d(3), F::d(40), F::d('0.8'));
        $this->assertSame('1.6', $kwh->toFixed());
        $this->assertSame('0.48', $kwh->times('0.30')->toFixed());
        $t = ['id' => 't', 'name' => 'Luce', 'kind' => 'electricity', 'unit' => 'kwh', 'pricePerUnit' => F::d('0.30')];
        $eq = ['id' => 'forno', 'code' => 'F1', 'name' => 'Forno', 'powerType' => 'electric', 'electric' => ['powerKw' => F::d(3), 'usageCoefficient' => F::d('0.8'), 'tariffId' => 't']];
        $e = C::energyForUse(['equipment' => $eq, 'segment' => 'work', 'minutes' => F::d(40), 'tariffs' => ['t' => $t]]);
        $this->assertSame([], $e['issues']);
        $this->assertSame('1.6', $e['sources'][0]['consumption']->toFixed());
        $this->assertSame('0.48', $e['sources'][0]['cost']->toFixed());
    }

    private function piastra(): array
    {
        return ['id' => 'piastra', 'code' => 'P1', 'name' => 'Piastra', 'powerType' => 'gas', 'gas' => ['mode' => 'flow', 'flowPerHour' => F::d(2), 'flowUnit' => 'm3', 'tariffId' => 'g']];
    }

    public function test_d_consumo_gas(): void
    {
        $this->assertSame('0.5', C::gasConsumption(F::d(2), F::d(15))->toFixed());
        $t = ['id' => 'g', 'name' => 'Gas', 'kind' => 'gas', 'unit' => 'm3', 'pricePerUnit' => F::d('1.20')];
        $e = C::energyForUse(['equipment' => $this->piastra(), 'segment' => 'work', 'minutes' => F::d(15), 'tariffs' => ['g' => $t]]);
        $this->assertSame([], $e['issues']);
        $this->assertSame('0.5', $e['sources'][0]['consumption']->toFixed());
        $this->assertSame('0.6', $e['sources'][0]['cost']->toFixed());
    }

    public function test_d_rifiuta_smc_senza_conversione(): void
    {
        $t = ['id' => 'g', 'name' => 'Gas Smc', 'kind' => 'gas', 'unit' => 'smc', 'pricePerUnit' => F::d('1.20')];
        try {
            C::convertGasToTariffUnit(F::d('0.5'), 'm3', $t);
            $this->fail('attesa DomainError');
        } catch (DomainError) {
        }
        $e = C::energyForUse(['equipment' => $this->piastra(), 'segment' => 'work', 'minutes' => F::d(15), 'tariffs' => ['g' => $t]]);
        $this->assertNull($e['sources'][0]['cost']);
        $this->assertSame('gas_unit_mismatch', $e['issues'][0]['code']);
    }

    public function test_d_accetta_smc_con_coefficiente(): void
    {
        $t = ['id' => 'g', 'name' => 'Gas Smc', 'kind' => 'gas', 'unit' => 'smc', 'pricePerUnit' => F::d('1.20'), 'm3ToSmc' => F::d('0.95')];
        $e = C::energyForUse(['equipment' => $this->piastra(), 'segment' => 'work', 'minutes' => F::d(15), 'tariffs' => ['g' => $t]]);
        $this->assertSame('0.475', $e['sources'][0]['billedConsumption']->toFixed());
        $this->assertSame('0.57', $e['sources'][0]['cost']->toFixed());
    }

    private function contextE(): array
    {
        $ragu = F::fixedCostRecipe('ragu', ['ingredients' => '20', 'energy' => '2', 'labor' => '12', 'finalWeightKg' => '5']);
        $las = F::fixedCostRecipe('lasagna', ['ingredients' => '8', 'energy' => '1', 'labor' => '6', 'finalWeightKg' => '2.4', 'portions' => '8']);
        $las['recipe']['components'][] = ['id' => 'lasagna-ragu', 'kind' => 'recipe', 'recipeId' => 'ragu', 'quantity' => F::d(600), 'unit' => 'g'];
        $all = [$ragu, $las];

        return F::ctx(['recipes' => array_column($all, 'recipe'), 'ingredients' => array_column($all, 'ingredient'), 'tariffs' => array_column($all, 'tariff'), 'equipment' => array_column($all, 'equipment'), 'employees' => array_column($all, 'employee')]);
    }

    public function test_e_ragu(): void
    {
        $r = RecipeCostEngine::valueRecipe($this->contextE(), 'ragu');
        $this->assertTrue($r['complete']);
        $this->assertSame(['20', '2', '12', '34', '6.8'], [$r['directIngredients']->toFixed(), $r['energy']->toFixed(), $r['labor']->toFixed(), $r['total']->toFixed(), $r['costPerKg']->toFixed()]);
    }

    public function test_e_lasagna(): void
    {
        $l = RecipeCostEngine::valueRecipe($this->contextE(), 'lasagna');
        $this->assertTrue($l['complete']);
        $this->assertSame('4.08', $l['subrecipeLines'][0]['cost']->toFixed());
        $this->assertSame('weight', $l['subrecipeLines'][0]['basis']);
        $this->assertSame(['8', '1', '6', '19.08', '7.95', '2.385'], [$l['directIngredients']->toFixed(), $l['energy']->toFixed(), $l['labor']->toFixed(), $l['total']->toFixed(), $l['costPerKg']->toFixed(), $l['costPerPortion']->toFixed()]);
        $this->assertSame('2.39', $l['costPerPortion']->toDecimalPlaces(2)->toFixed(2));
    }

    public function test_e_nessun_doppio_conteggio(): void
    {
        $l = RecipeCostEngine::valueRecipe($this->contextE(), 'lasagna');
        $this->assertSame('19.08', $l['directIngredients']->plus($l['subrecipes'])->plus($l['energy'])->plus($l['labor'])->toFixed());
        $x = $l['expanded'];
        $this->assertSame('10.4', $x['ingredients']->toFixed());
        $this->assertSame('1.24', $x['energy']->toFixed());
        $this->assertSame('7.44', $x['labor']->toFixed());
        $this->assertSame('19.08', $x['ingredients']->plus($x['energy'])->plus($x['labor'])->toFixed());
    }
}
