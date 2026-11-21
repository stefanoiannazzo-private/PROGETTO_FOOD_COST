<?php

namespace Tests\Unit\Domain;

use App\Domain\Costing\Calculators as C;
use App\Domain\Costing\Dec;
use App\Domain\Costing\DomainError;
use App\Domain\Costing\Graph;
use App\Domain\Costing\NumberFormat;
use App\Domain\Costing\RecipeCostEngine as E;
use App\Domain\Costing\Serializer;
use App\Domain\Costing\UnitConversionError;
use App\Domain\Costing\Units;
use PHPUnit\Framework\TestCase;
use Tests\Unit\Domain\Fixtures as F;

/** Port di packages/domain/test/dominio.test.ts */
class DominioTest extends TestCase
{
    private static function has(array $issues, callable $fn): bool
    {
        foreach ($issues as $i) {
            if ($fn($i)) {
                return true;
            }
        }

        return false;
    }

    private function assertThrowsClass(string $class, callable $fn): void
    {
        try {
            $fn();
        } catch (\Throwable $e) {
            $this->assertInstanceOf($class, $e);

            return;
        }
        $this->fail("attesa eccezione {$class}");
    }

    // Resa edibile
    public function test_quantita_netta_e_resa(): void
    {
        $u = C::ingredientUsageCost(F::ingredient(['id' => 'carciofi', 'packagePrice' => '10', 'packageContent' => '1', 'packageUnit' => 'kg', 'edibleYield' => F::d('0.4')]), F::d(200), 'g');
        $this->assertSame('0.2', $u['netBaseQuantity']->toFixed());
        $this->assertSame('0.5', $u['grossBaseQuantity']->toFixed());
        $this->assertSame('5', $u['cost']->toFixed());
    }

    public function test_resa_nulla_o_oltre_100(): void
    {
        $this->assertThrowsClass(DomainError::class, fn () => C::ingredientUsageCost(F::ingredient(['id' => 'x', 'packagePrice' => '1', 'packageContent' => '1', 'packageUnit' => 'kg', 'edibleYield' => F::d(0)]), F::d(1), 'kg'));
        $this->assertThrowsClass(DomainError::class, fn () => C::ingredientUsageCost(F::ingredient(['id' => 'x', 'packagePrice' => '1', 'packageContent' => '1', 'packageUnit' => 'kg', 'edibleYield' => F::d('1.1')]), F::d(1), 'kg'));
    }

    // Conversioni di unità
    public function test_l_ml_kg_g(): void
    {
        $this->assertSame('0.75', Units::convertToDimension(F::d(750), 'ml', 'volume')->toFixed());
        $this->assertSame('0.15', Units::convertToDimension(F::d(150), 'g', 'mass')->toFixed());
    }

    public function test_conversioni_senza_dati(): void
    {
        $this->assertThrowsClass(UnitConversionError::class, fn () => Units::convertToDimension(F::d(1), 'l', 'mass'));
        $this->assertThrowsClass(UnitConversionError::class, fn () => Units::convertToDimension(F::d(100), 'g', 'count'));
    }

    public function test_conversioni_con_dati(): void
    {
        $this->assertSame('0.92', Units::convertToDimension(F::d(1), 'l', 'mass', ['densityKgPerL' => F::d('0.92')])->toFixed());
        $this->assertSame('2', Units::convertToDimension(F::d(120), 'g', 'count', ['unitWeightKg' => F::d('0.06')])->toFixed());
    }

    public function test_pezzi_in_grammi_richiede_peso_unitario(): void
    {
        $uova = F::ingredient(['id' => 'uova', 'packagePrice' => '3.6', 'packageContent' => '12', 'packageUnit' => 'pz']);
        $r = F::recipe(['id' => 'r', 'components' => [['id' => 'c', 'kind' => 'ingredient', 'ingredientId' => 'uova', 'quantity' => F::d(120), 'unit' => 'g']]]);
        $res = E::valueRecipe(F::ctx(['recipes' => [$r], 'ingredients' => [$uova]]), 'r');
        $this->assertFalse($res['complete']);
        $this->assertTrue(self::has($res['issues'], fn ($i) => $i['code'] === 'unit_conversion'));
        $ok = E::valueRecipe(F::ctx(['recipes' => [$r], 'ingredients' => [array_merge($uova, ['unitWeightKg' => F::d('0.06')])]]), 'r');
        $this->assertSame('0.6', $ok['directIngredients']->toFixed());
    }

    // Dati mancanti, zero e divisori nulli
    public function test_prezzo_mancante(): void
    {
        $a = F::ingredient(['id' => 'a', 'packagePrice' => null, 'packageContent' => '1', 'packageUnit' => 'kg']);
        $b = F::ingredient(['id' => 'b', 'packagePrice' => '4', 'packageContent' => '1', 'packageUnit' => 'kg']);
        $r = F::recipe(['id' => 'r', 'components' => [
            ['id' => 'c1', 'kind' => 'ingredient', 'ingredientId' => 'a', 'quantity' => F::d(1), 'unit' => 'kg'],
            ['id' => 'c2', 'kind' => 'ingredient', 'ingredientId' => 'b', 'quantity' => F::d(1), 'unit' => 'kg'],
        ]]);
        $res = E::valueRecipe(F::ctx(['recipes' => [$r], 'ingredients' => [$a, $b]]), 'r');
        $this->assertFalse($res['complete']);
        $this->assertSame('4', $res['total']->toFixed());
        $this->assertNull($res['ingredientLines'][0]['cost']);
        $this->assertTrue(self::has($res['issues'], fn ($i) => $i['code'] === 'missing_price' && $i['severity'] === 'error'));
    }

    public function test_prezzo_zero_valido_e_segnalato(): void
    {
        $a = F::ingredient(['id' => 'a', 'packagePrice' => '0', 'packageContent' => '1', 'packageUnit' => 'kg']);
        $r = F::recipe(['id' => 'r', 'components' => [['id' => 'c', 'kind' => 'ingredient', 'ingredientId' => 'a', 'quantity' => F::d(1), 'unit' => 'kg']]]);
        $res = E::valueRecipe(F::ctx(['recipes' => [$r], 'ingredients' => [$a]]), 'r');
        $this->assertTrue($res['complete']);
        $this->assertTrue($res['ingredientLines'][0]['zeroPrice']);
        $this->assertTrue(self::has($res['issues'], fn ($i) => $i['code'] === 'zero_price' && $i['severity'] === 'info'));
    }

    public function test_quantita_zero_non_valida(): void
    {
        $a = F::ingredient(['id' => 'a', 'packagePrice' => '5', 'packageContent' => '1', 'packageUnit' => 'kg']);
        $r = F::recipe(['id' => 'r', 'components' => [['id' => 'c', 'kind' => 'ingredient', 'ingredientId' => 'a', 'quantity' => F::d(0), 'unit' => 'kg']]]);
        $res = E::valueRecipe(F::ctx(['recipes' => [$r], 'ingredients' => [$a]]), 'r');
        $this->assertFalse($res['complete']);
        $this->assertNull($res['ingredientLines'][0]['cost']);
    }

    public function test_senza_peso_e_porzioni(): void
    {
        $res = E::valueRecipe(F::ctx(['recipes' => [F::recipe(['id' => 'r'])]]), 'r');
        $this->assertNull($res['costPerKg']);
        $this->assertNull($res['costPerPortion']);
        $codes = array_column($res['issues'], 'code');
        $this->assertContains('missing_final_weight', $codes);
        $this->assertContains('missing_portions', $codes);
    }

    public function test_ore_produttive_zero(): void
    {
        $this->assertThrowsClass(DomainError::class, fn () => C::employeeRates(['grossMonthly' => F::d(1000), 'contributionsMode' => 'none', 'contributionsValue' => null, 'otherMonthlyCosts' => null, 'productiveHours' => F::d(0)]));
    }

    public function test_componente_con_entrambi_i_riferimenti(): void
    {
        $r = F::recipe(['id' => 'r', 'components' => [['id' => 'c', 'kind' => 'ingredient', 'ingredientId' => 'a', 'recipeId' => 'b', 'quantity' => F::d(1), 'unit' => 'kg']]]);
        $this->assertSame('invalid_component', E::valueRecipe(F::ctx(['recipes' => [$r]]), 'r')['issues'][0]['code']);
    }

    // Costo del lavoro
    public function test_oneri_percentuali_e_altri_costi(): void
    {
        $r = C::employeeRates(['grossMonthly' => F::d(2000), 'contributionsMode' => 'percent', 'contributionsValue' => F::d(30), 'otherMonthlyCosts' => F::d(200), 'productiveHours' => F::d(160)]);
        $this->assertSame('2800', $r['companyMonthly']->toFixed());
        $this->assertSame('17.5', $r['companyHourly']->toFixed());
        $this->assertSame('company_cost', $r['basis']);
    }

    public function test_piu_dipendenti_e_quota(): void
    {
        $emp = fn ($id) => ['employeeId' => $id, 'code' => $id, 'name' => $id, 'grossMonthly' => F::d(2400), 'contributionsMode' => 'amount', 'contributionsValue' => F::d(0), 'otherMonthlyCosts' => F::d(0), 'productiveHours' => F::d(160)];
        $r = F::recipe(['id' => 'r', 'laborAssignments' => [
            ['id' => 'l1', 'employeeId' => 'a', 'phaseId' => 'f1', 'activeMinutes' => F::d(10), 'share' => F::d(1)],
            ['id' => 'l2', 'employeeId' => 'b', 'phaseId' => 'f1', 'activeMinutes' => F::d(20), 'share' => F::d('0.5')],
        ]]);
        $res = E::valueRecipe(F::ctx(['recipes' => [$r], 'employees' => [$emp('a'), $emp('b')]]), 'r');
        $this->assertSame('5', $res['labor']->toFixed());
        $this->assertSame('30', $res['personMinutes']->toFixed());
    }

    // Energia
    private function tariffs(): array
    {
        return [
            't' => ['id' => 't', 'name' => 'Luce', 'kind' => 'electricity', 'unit' => 'kwh', 'pricePerUnit' => F::d('0.30')],
            'g' => ['id' => 'g', 'name' => 'Gas', 'kind' => 'gas', 'unit' => 'm3', 'pricePerUnit' => F::d('1.20')],
        ];
    }

    public function test_consumo_misurato_sostituisce_stima(): void
    {
        $eq = ['id' => 'f', 'code' => 'F', 'name' => 'Forno', 'powerType' => 'electric', 'electric' => ['powerKw' => F::d(3), 'usageCoefficient' => F::d('0.8'), 'tariffId' => 't']];
        $e = C::energyForUse(['equipment' => $eq, 'segment' => 'work', 'minutes' => F::d(40), 'measuredElectricKwh' => F::d(2), 'tariffs' => $this->tariffs()]);
        $this->assertFalse($e['sources'][0]['estimated']);
        $this->assertSame('0.6', $e['sources'][0]['cost']->toFixed());
    }

    public function test_alimentazione_mista(): void
    {
        $eq = ['id' => 'm', 'code' => 'M', 'name' => 'Forno misto', 'powerType' => 'mixed', 'electric' => ['powerKw' => F::d(3), 'usageCoefficient' => F::d('0.8'), 'tariffId' => 't'], 'gas' => ['mode' => 'flow', 'flowPerHour' => F::d(2), 'flowUnit' => 'm3', 'tariffId' => 'g']];
        $both = C::energyForUse(['equipment' => $eq, 'segment' => 'work', 'minutes' => F::d(40), 'tariffs' => $this->tariffs()]);
        $this->assertSame([['electric', '0.48'], ['gas', '1.6']], array_map(fn ($s) => [$s['source'], $s['cost']->toFixed()], $both['sources']));
        $onlyGas = C::energyForUse(['equipment' => $eq, 'segment' => 'work', 'minutes' => F::d(40), 'sources' => ['gas'], 'tariffs' => $this->tariffs()]);
        $this->assertCount(1, $onlyGas['sources']);
    }

    public function test_strumento_manuale(): void
    {
        $r = F::recipe(['id' => 'r', 'equipmentUses' => [['id' => 'u', 'equipmentId' => 'mano', 'segment' => 'work', 'minutes' => F::d(10), 'share' => F::d(1)]]]);
        $res = E::valueRecipe(F::ctx(['recipes' => [$r], 'equipment' => [['id' => 'mano', 'code' => 'M', 'name' => 'Mattarello', 'powerType' => 'manual']]]), 'r');
        $this->assertTrue($res['complete']);
        $this->assertSame('0', $res['equipmentLines'][0]['cost']->toFixed());
    }

    public function test_parametri_mancanti_mai_inventati(): void
    {
        $t = $this->tariffs()['t'];
        $eq = ['id' => 'f', 'code' => 'F', 'name' => 'Forno', 'powerType' => 'electric', 'electric' => ['powerKw' => null, 'usageCoefficient' => F::d('0.8'), 'tariffId' => 't']];
        $r = F::recipe(['id' => 'r', 'equipmentUses' => [['id' => 'u', 'equipmentId' => 'f', 'segment' => 'work', 'minutes' => F::d(10), 'share' => F::d(1)]]]);
        $res = E::valueRecipe(F::ctx(['recipes' => [$r], 'equipment' => [$eq], 'tariffs' => [$t]]), 'r');
        $this->assertFalse($res['complete']);
        $this->assertTrue(self::has($res['issues'], fn ($i) => $i['code'] === 'missing_power'));
    }

    public function test_forno_condiviso_e_preriscaldamento(): void
    {
        $t = $this->tariffs()['t'];
        $eq = ['id' => 'f', 'code' => 'F', 'name' => 'Forno', 'powerType' => 'electric', 'electric' => ['powerKw' => F::d(6), 'usageCoefficient' => F::d('0.5'), 'preheatCoefficient' => F::d(1), 'tariffId' => 't']];
        $r = F::recipe(['id' => 'r', 'equipmentUses' => [
            ['id' => 'pre', 'equipmentId' => 'f', 'segment' => 'preheat', 'minutes' => F::d(10), 'share' => F::d('0.5')],
            ['id' => 'cott', 'equipmentId' => 'f', 'segment' => 'work', 'minutes' => F::d(60), 'share' => F::d('0.5')],
        ]]);
        $res = E::valueRecipe(F::ctx(['recipes' => [$r], 'equipment' => [$eq], 'tariffs' => [$t]]), 'r');
        $this->assertSame(['0.3', '0.9'], array_map(fn ($l) => $l['fullCost']->toFixed(), $res['equipmentLines']));
        $this->assertSame('0.6', $res['energy']->toFixed());
        $this->assertSame('70', $res['machineMinutes']->toFixed());
    }

    // Ricette annidate
    public function test_cicli_su_piu_livelli(): void
    {
        $edges = ['a' => ['b'], 'b' => ['c'], 'c' => []];
        $this->assertSame(['c', 'a', 'b', 'c'], Graph::findCycle($edges, 'c', ['a']));
        $this->assertNull(Graph::findCycle($edges, 'c', []));
        $this->assertSame(['a', 'a'], Graph::findCycle($edges, 'a', ['a']));
    }

    public function test_motore_segnala_cicli(): void
    {
        $a = F::recipe(['id' => 'A', 'components' => [['id' => 'c1', 'kind' => 'recipe', 'recipeId' => 'B', 'quantity' => F::d(1), 'unit' => 'kg']]]);
        $b = F::recipe(['id' => 'B', 'finalWeightKg' => F::d(1), 'components' => [['id' => 'c2', 'kind' => 'recipe', 'recipeId' => 'A', 'quantity' => F::d(1), 'unit' => 'kg']]]);
        $res = E::valueRecipe(F::ctx(['recipes' => [$a, $b]]), 'A');
        $cycle = collect($res['issues'])->firstWhere('code', 'cycle');
        $this->assertSame(['A', 'B', 'A'], $cycle['path']);
    }

    private static function ctxWith(array $base, array $recipes): array
    {
        return F::ctx(['recipes' => array_merge([$base['recipe']], $recipes), 'ingredients' => [$base['ingredient']], 'tariffs' => [$base['tariff']], 'equipment' => [$base['equipment']], 'employees' => [$base['employee']]]);
    }

    public function test_sottoricetta_condivisa_fabbisogni_sommati(): void
    {
        $base = F::fixedCostRecipe('besciamella', ['ingredients' => '10', 'energy' => '0', 'labor' => '0', 'finalWeightKg' => '2']);
        $r = F::recipe(['id' => 'piatto', 'components' => [
            ['id' => 'x1', 'kind' => 'recipe', 'recipeId' => 'besciamella', 'quantity' => F::d(500), 'unit' => 'g'],
            ['id' => 'x2', 'kind' => 'recipe', 'recipeId' => 'besciamella', 'quantity' => F::d(1), 'unit' => 'kg'],
        ]]);
        $res = E::valueRecipe(self::ctxWith($base, [$r]), 'piatto');
        $this->assertSame(['2.5', '5'], array_map(fn ($l) => $l['cost']->toFixed(), $res['subrecipeLines']));
        $this->assertSame('7.5', $res['total']->toFixed());
    }

    public function test_tre_livelli(): void
    {
        $brodo = F::fixedCostRecipe('brodo', ['ingredients' => '4', 'energy' => '0', 'labor' => '0', 'finalWeightKg' => '4']);
        $ragu = F::recipe(['id' => 'ragu', 'finalWeightKg' => F::d(2), 'components' => [['id' => 'r1', 'kind' => 'recipe', 'recipeId' => 'brodo', 'quantity' => F::d(2), 'unit' => 'kg']]]);
        $las = F::recipe(['id' => 'lasagna', 'finalWeightKg' => F::d(1), 'components' => [['id' => 'l1', 'kind' => 'recipe', 'recipeId' => 'ragu', 'quantity' => F::d(500), 'unit' => 'g']]]);
        $res = E::valueRecipe(self::ctxWith($brodo, [$ragu, $las]), 'lasagna');
        $this->assertSame('0.5', $res['total']->toFixed());
        $this->assertSame('0.5', $res['expanded']['ingredients']->toFixed());
    }

    public function test_dosaggio_incompatibile_con_resa(): void
    {
        $salsa = F::recipe(['id' => 'salsa', 'finalQuantity' => F::d(2), 'finalUnit' => 'l']);
        $r = F::recipe(['id' => 'r', 'components' => [['id' => 'c', 'kind' => 'recipe', 'recipeId' => 'salsa', 'quantity' => F::d(100), 'unit' => 'g']]]);
        $this->assertTrue(self::has(E::valueRecipe(F::ctx(['recipes' => [$salsa, $r]]), 'r')['issues'], fn ($i) => $i['code'] === 'incompatible_subrecipe_unit'));
        $r2 = F::recipe(['id' => 'r2', 'components' => [['id' => 'c', 'kind' => 'recipe', 'recipeId' => 'salsa', 'quantity' => F::d(500), 'unit' => 'ml']]]);
        $ok = E::valueRecipe(F::ctx(['recipes' => [$salsa, $r2]]), 'r2');
        $this->assertSame('yield', $ok['subrecipeLines'][0]['basis']);
        $this->assertSame('0.25', $ok['subrecipeLines'][0]['fraction']->toFixed());
    }

    public function test_dipendenti_indiretti(): void
    {
        $d = Graph::dependentsOf(['lasagna' => ['ragu'], 'ragu' => ['brodo'], 'torta' => []], ['brodo']);
        sort($d);
        $this->assertSame(['lasagna', 'ragu'], $d);
    }

    // Formati italiani
    public function test_numeri_italiani(): void
    {
        $p = fn ($s, $m = 'auto') => NumberFormat::parseItalianNumber($s, $m)?->toFixed();
        $this->assertSame('1234.56', $p('1.234,56'));
        $this->assertSame('0.9', $p('0,9'));
        $this->assertSame('2400', $p('2.400', 'it'));
        $this->assertSame('12.5', $p('12.5'));
        $this->assertSame('1234.56', $p('1,234.56', 'en'));
        $this->assertSame('30', $p('€ 30,00'));
        $this->assertNull($p('abc'));
        $this->assertNull($p('1,2,3'));
    }

    public function test_serializza_decimali_come_stringhe(): void
    {
        $this->assertSame(['a' => '0.3', 'b' => ['2.385']], Serializer::serialize(['a' => Dec::of('0.1')->plus('0.2'), 'b' => [Dec::of('2.385')]]));
    }
}
