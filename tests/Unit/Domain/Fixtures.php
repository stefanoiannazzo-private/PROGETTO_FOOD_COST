<?php

namespace Tests\Unit\Domain;

use App\Domain\Costing\Dec;

/** Port di packages/domain/test/fixtures.ts */
final class Fixtures
{
    public static function d(int|string $v): Dec
    {
        return Dec::of($v);
    }

    public static function ingredient(array $p): array
    {
        return array_merge(['code' => strtoupper($p['id']), 'name' => $p['id'], 'edibleYield' => Dec::of(1)], $p, [
            'packagePrice' => $p['packagePrice'] === null ? null : Dec::of($p['packagePrice']),
            'packageContent' => Dec::of($p['packageContent']),
        ]);
    }

    public static function recipe(array $p): array
    {
        return array_merge([
            'revisionId' => "{$p['id']}-r1", 'code' => strtoupper($p['id']), 'title' => $p['id'],
            'finalQuantity' => null, 'finalUnit' => null, 'finalWeightKg' => null, 'portions' => null, 'declaredDurationMinutes' => null,
            'phases' => [], 'components' => [], 'equipmentUses' => [], 'laborAssignments' => [],
        ], $p);
    }

    public static function ctx(array $parts): array
    {
        $by = fn (array $list, string $key) => array_column(array_map(fn ($x) => ['k' => $x[$key], 'v' => $x], $list), 'v', 'k');

        return [
            'date' => '2026-11-02',
            'recipes' => $by($parts['recipes'] ?? [], 'id'),
            'ingredients' => $by($parts['ingredients'] ?? [], 'id'),
            'equipment' => $by($parts['equipment'] ?? [], 'id'),
            'tariffs' => $by($parts['tariffs'] ?? [], 'id'),
            'employees' => $by($parts['employees'] ?? [], 'employeeId'),
        ];
    }

    /** Ricetta "a costo fisso" (caso E del capitolato). */
    public static function fixedCostRecipe(string $id, array $o): array
    {
        $ing = self::ingredient(['id' => "{$id}-ing", 'packagePrice' => $o['ingredients'], 'packageContent' => '1', 'packageUnit' => 'kg']);
        $tariff = ['id' => "{$id}-el", 'name' => "{$id} elettricità", 'kind' => 'electricity', 'unit' => 'kwh', 'pricePerUnit' => Dec::of($o['energy'])];
        $eq = ['id' => "{$id}-eq", 'code' => "{$id}-EQ", 'name' => "{$id} strumento", 'powerType' => 'electric', 'electric' => ['powerKw' => Dec::of(1), 'usageCoefficient' => Dec::of(1), 'tariffId' => $tariff['id']]];
        $emp = ['employeeId' => "{$id}-emp", 'code' => "{$id}-E", 'name' => "{$id} addetto", 'grossMonthly' => Dec::of($o['labor'])->times(60), 'contributionsMode' => 'amount', 'contributionsValue' => Dec::of(0), 'otherMonthlyCosts' => Dec::of(0), 'productiveHours' => Dec::of(60)];
        $r = self::recipe(array_merge([
            'id' => $id,
            'finalQuantity' => Dec::of($o['finalWeightKg']), 'finalUnit' => 'kg', 'finalWeightKg' => Dec::of($o['finalWeightKg']),
            'portions' => isset($o['portions']) ? Dec::of($o['portions']) : null,
            'components' => [['id' => "{$id}-c1", 'kind' => 'ingredient', 'ingredientId' => $ing['id'], 'quantity' => Dec::of(1), 'unit' => 'kg']],
            'equipmentUses' => [['id' => "{$id}-u1", 'equipmentId' => $eq['id'], 'segment' => 'work', 'minutes' => Dec::of(60), 'share' => Dec::of(1)]],
            'laborAssignments' => [['id' => "{$id}-l1", 'employeeId' => $emp['employeeId'], 'activeMinutes' => Dec::of(60), 'share' => Dec::of(1)]],
        ], $o['extra'] ?? []));

        return ['recipe' => $r, 'ingredient' => $ing, 'tariff' => $tariff, 'equipment' => $eq, 'employee' => $emp];
    }
}
