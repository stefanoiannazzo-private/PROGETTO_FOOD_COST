<?php

declare(strict_types=1);

namespace App\Domain\Costing;

use RuntimeException;

class UnitConversionError extends RuntimeException
{
    /** @param 'density'|'unit_weight'|'unit_weight_and_density' $missing */
    public function __construct(public readonly string $from, public readonly string $to, public readonly string $missing)
    {
        $what = match ($missing) {
            'density' => 'la densità (kg/l)',
            'unit_weight' => 'il peso medio unitario (kg/pz)',
            default => 'peso medio unitario e densità',
        };
        parent::__construct("Impossibile convertire {$from} in ".Units::BASE_UNIT[$to].": serve {$what}.");
    }
}
