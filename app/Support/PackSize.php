<?php

namespace App\Support;

/**
 * NUOVO — formato della confezione ricavato dal nome del prodotto, solo quando l'unità è scritta
 * (es. «tanica3L» → 3 l, «vasc.1,5k» → 1,5 kg, «400g», «GLASSA 500ml», «2x5lt» → 10 l).
 * Sigle senza unità come «B.0,25» non vengono interpretate: serve la conferma di una persona.
 */
class PackSize
{
    private const UNITS = ['kg' => 'kg', 'k' => 'kg', 'g' => 'g', 'gr' => 'g', 'grammi' => 'g', 'l' => 'l', 'lt' => 'l', 'litri' => 'l', 'ml' => 'ml', 'cl' => 'cl'];

    /** @return array{qty: string, unit: string}|null */
    public static function fromName(?string $name): ?array
    {
        $s = mb_strtolower((string) $name);
        $num = '(\d+(?:[.,]\d+)?)';
        $unit = '(kg|k|grammi|gr|g|litri|lt|l|ml|cl)(?![a-z])';
        if (preg_match("/{$num}\s*x\s*{$num}\s*{$unit}/u", $s, $m)) {
            $qty = (float) str_replace(',', '.', $m[1]) * (float) str_replace(',', '.', $m[2]);

            return ['qty' => self::fmt($qty), 'unit' => self::UNITS[$m[3]]];
        }
        if (preg_match_all("/(?<![a-z0-9]){$num}\s*{$unit}|(?<=[a-z.]){$num}\s*{$unit}/u", $s, $all, PREG_SET_ORDER)) {
            $m = end($all);
            $q = $m[1] !== '' ? $m[1] : $m[3];
            $u = $m[2] !== '' ? $m[2] : $m[4];
            $qty = (float) str_replace(',', '.', $q);
            if ($qty > 0) {
                return ['qty' => self::fmt($qty), 'unit' => self::UNITS[$u]];
            }
        }

        return null;
    }

    private static function fmt(float $v): string
    {
        return rtrim(rtrim(number_format($v, 3, '.', ''), '0'), '.');
    }
}
