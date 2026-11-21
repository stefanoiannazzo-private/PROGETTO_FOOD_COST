<?php

declare(strict_types=1);

namespace App\Services\Imports;

/** Cella che contiene una formula: riportata come tale, mai calcolata. */
final class Formula
{
    public function __construct(public readonly string $formula)
    {
    }
}
