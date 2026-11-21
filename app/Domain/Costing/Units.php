<?php

declare(strict_types=1);

namespace App\Domain\Costing;

/** Unità di misura e conversioni (port di units.ts). Grandezze: mass, volume, count. */
final class Units
{
    public const MEASURE_UNITS = ['g', 'kg', 'ml', 'cl', 'l', 'pz'];

    public const BASE_UNIT = ['mass' => 'kg', 'volume' => 'l', 'count' => 'pz'];

    private const INFO = [
        'g' => ['mass', '0.001'],
        'kg' => ['mass', '1'],
        'ml' => ['volume', '0.001'],
        'cl' => ['volume', '0.01'],
        'l' => ['volume', '1'],
        'pz' => ['count', '1'],
    ];

    public static function isMeasureUnit(mixed $u): bool
    {
        return is_string($u) && in_array($u, self::MEASURE_UNITS, true);
    }

    public static function dimensionOf(string $unit): string
    {
        return self::INFO[$unit][0];
    }

    public static function toBase(Dec $quantity, string $unit): Dec
    {
        return $quantity->times(self::INFO[$unit][1]);
    }

    public static function fromBase(Dec $quantity, string $unit): Dec
    {
        return $quantity->div(self::INFO[$unit][1]);
    }

    /**
     * Converte quantity/unit nella grandezza $target, espressa nell'unità di base.
     *
     * @param  array{densityKgPerL?: ?Dec, unitWeightKg?: ?Dec}  $data
     *
     * @throws UnitConversionError se mancano i dati necessari
     */
    public static function convertToDimension(Dec $quantity, string $unit, string $target, array $data = []): Dec
    {
        $source = self::dimensionOf($unit);
        $base = self::toBase($quantity, $unit);
        if ($source === $target) {
            return $base;
        }

        $d = $data['densityKgPerL'] ?? null;
        $w = $data['unitWeightKg'] ?? null;
        $density = $d !== null && $d->gt(0) ? $d : null;
        $unitWeight = $w !== null && $w->gt(0) ? $w : null;

        if ($source === 'mass') {
            $massKg = $base;
        } elseif ($source === 'volume') {
            if (! $density) {
                throw new UnitConversionError($unit, $target, 'density');
            }
            $massKg = $base->times($density);
        } else {
            if (! $unitWeight) {
                throw new UnitConversionError($unit, $target, $target === 'volume' && ! $density ? 'unit_weight_and_density' : 'unit_weight');
            }
            $massKg = $base->times($unitWeight);
        }

        if ($target === 'mass') {
            return $massKg;
        }
        if ($target === 'volume') {
            if (! $density) {
                throw new UnitConversionError($unit, $target, $source === 'count' ? 'unit_weight_and_density' : 'density');
            }

            return $massKg->div($density);
        }
        if (! $unitWeight) {
            throw new UnitConversionError($unit, $target, 'unit_weight');
        }

        return $massKg->div($unitWeight);
    }
}
