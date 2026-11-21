<?php

declare(strict_types=1);

namespace App\Domain\Costing;

/**
 * Formati italiani (port di format.ts): virgola decimale, punto per le migliaia.
 * Le API scambiano stringhe normalizzate col punto; questo serve alle importazioni.
 */
final class NumberFormat
{
    /** @param 'auto'|'it'|'en' $mode */
    public static function parseItalianNumber(string|int|float|null $input, string $mode = 'auto'): ?Dec
    {
        if ($input === null) {
            return null;
        }
        if (is_int($input) || is_float($input)) {
            return Dec::parse($input);
        }
        $s = preg_replace('/\s|€|\x{00A0}/u', '', trim($input)) ?? '';
        if ($s === '') {
            return null;
        }
        if ($mode === 'it') {
            if (! preg_match('/^[-+]?\d{1,3}(\.\d{3})*(,\d+)?$/', $s) && ! preg_match('/^[-+]?\d+(,\d+)?$/', $s)) {
                return null;
            }

            return Dec::parse(self::replaceFirst(',', '.', str_replace('.', '', $s)));
        }
        if ($mode === 'en') {
            if (! preg_match('/^[-+]?\d{1,3}(,\d{3})*(\.\d+)?$/', $s) && ! preg_match('/^[-+]?\d+(\.\d+)?$/', $s)) {
                return null;
            }

            return Dec::parse(str_replace(',', '', $s));
        }
        $hasComma = str_contains($s, ',');
        $hasDot = str_contains($s, '.');
        if ($hasComma && $hasDot) {
            if (strrpos($s, ',') > strrpos($s, '.')) {
                $s = self::replaceFirst(',', '.', str_replace('.', '', $s));
            } else {
                $s = str_replace(',', '', $s);
            }
        } elseif ($hasComma) {
            if (substr_count($s, ',') > 1) {
                return null;
            }
            $s = str_replace(',', '.', $s);
        } elseif ($hasDot) {
            $parts = explode('.', $s);
            if (count($parts) > 2) {
                foreach (array_slice($parts, 1) as $p) {
                    if (strlen($p) !== 3) {
                        return null;
                    }
                }
                $s = implode('', $parts);
            }
        }
        if (! preg_match('/^[-+]?\d+(\.\d+)?$/', $s)) {
            return null;
        }

        return Dec::parse($s);
    }

    private static function replaceFirst(string $search, string $replace, string $subject): string
    {
        $pos = strpos($subject, $search);

        return $pos === false ? $subject : substr_replace($subject, $replace, $pos, strlen($search));
    }
}
