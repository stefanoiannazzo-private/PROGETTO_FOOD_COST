<?php

declare(strict_types=1);

namespace App\Domain\Costing;

/** Converte ricorsivamente un risultato del motore in dati JSON puri: i Dec diventano stringhe con il punto. */
final class Serializer
{
    public static function serialize(mixed $value): mixed
    {
        if ($value instanceof Dec) {
            return $value->toFixed();
        }
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) {
                $out[$k] = self::serialize($v);
            }

            return $out;
        }

        return $value;
    }
}
