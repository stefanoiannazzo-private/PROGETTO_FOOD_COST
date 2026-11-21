<?php

declare(strict_types=1);

namespace App\Services\Imports;

use App\Domain\Costing\Dec;
use App\Domain\Costing\NumberFormat;
use App\Domain\Costing\Units;
use DateTimeImmutable;

/** Normalizzazione dei valori di cella (port di services/imports/normalize.ts). */
final class Normalize
{
    private const FORMULA = 'contiene una formula: inserisci un valore statico';

    public static function text(mixed $c): ?string
    {
        if ($c === null) {
            return null;
        }
        if ($c instanceof Formula) {
            throw new CellError(self::FORMULA);
        }
        if ($c instanceof DateTimeImmutable) {
            return $c->format('Y-m-d');
        }
        $s = trim(Reader::scalar($c));

        return $s === '' ? null : $s;
    }

    public static function number(mixed $c, string $numberFormat): ?string
    {
        if ($c === null) {
            return null;
        }
        if ($c instanceof Formula) {
            throw new CellError(self::FORMULA);
        }
        if (is_int($c)) {
            return (string) $c;
        }
        if (is_float($c)) {
            if (! is_finite($c)) {
                throw new CellError('numero non valido');
            }
            // i numeri Excel arrivano in virgola mobile: precisione di 15 cifre (toPrecision(15))
            return Dec::of(sprintf('%.14e', $c))->toFixed();
        }
        if ($c instanceof DateTimeImmutable) {
            throw new CellError('è una data, era atteso un numero');
        }
        $s = trim((string) $c);
        if ($s === '') {
            return null;
        }
        $v = NumberFormat::parseItalianNumber($s, $numberFormat);
        if ($v === null) {
            throw new CellError("“{$s}” non è un numero valido");
        }

        return $v->toFixed();
    }

    /** Date: celle data Excel, gg/mm/aaaa (anche gg-mm-aa), aaaa-mm-gg, numero seriale Excel. */
    public static function date(mixed $c): ?string
    {
        if ($c === null) {
            return null;
        }
        if ($c instanceof Formula) {
            throw new CellError(self::FORMULA);
        }
        if ($c instanceof DateTimeImmutable) {
            return $c->format('Y-m-d');
        }
        if (is_int($c) || is_float($c)) {
            if ($c > 20000 && $c < 80000) {
                $ms = (int) round(($c - 25569) * 86400000);

                return gmdate('Y-m-d', intdiv($ms, 1000) - ($ms < 0 && $ms % 1000 ? 1 : 0));
            }
            throw new CellError('data non valida');
        }
        $s = trim((string) $c);
        if ($s === '') {
            return null;
        }
        if (preg_match('/^(\d{4})-(\d{1,2})-(\d{1,2})$/', $s, $m)) {
            [$y, $mo, $dd] = [(int) $m[1], (int) $m[2], (int) $m[3]];
        } elseif (preg_match('/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/', $s, $m)) {
            [$dd, $mo, $y] = [(int) $m[1], (int) $m[2], (int) $m[3]];
            if ($y < 100) {
                $y += 2000;
            }
        } else {
            throw new CellError("“{$s}” non è una data valida (usa gg/mm/aaaa)");
        }
        if (! checkdate($mo, $dd, $y)) {
            throw new CellError("“{$s}” non è una data esistente");
        }
        if ($y < 2000 || $y > 2100) {
            throw new CellError("anno {$y} fuori intervallo");
        }

        return sprintf('%04d-%02d-%02d', $y, $mo, $dd);
    }

    public static function unit(mixed $c): ?string
    {
        $t = self::text($c);
        $s = $t === null ? null : preg_replace('/\.$/', '', mb_strtolower($t));
        if (! $s) {
            return null;
        }
        $alias = ['gr' => 'g', 'grammi' => 'g', 'kg' => 'kg', 'chili' => 'kg', 'lt' => 'l', 'litri' => 'l', 'litro' => 'l', 'pezzi' => 'pz', 'pz' => 'pz', 'pezzo' => 'pz', 'n' => 'pz', 'nr' => 'pz'];
        $u = $alias[$s] ?? $s;
        if (! Units::isMeasureUnit($u)) {
            throw new CellError("unità “{$s}” non riconosciuta (g, kg, ml, cl, l, pz)");
        }

        return $u;
    }

    public static function defaultUsageUnit(string $packageUnit): string
    {
        return $packageUnit === 'kg' ? 'g' : ($packageUnit === 'l' ? 'ml' : $packageUnit);
    }

    public static function sameDimension(string $a, string $b): bool
    {
        return Units::isMeasureUnit($a) && Units::isMeasureUnit($b) && Units::dimensionOf($a) === Units::dimensionOf($b);
    }

    public static function contributionsMode(mixed $c): ?string
    {
        $t = self::text($c);
        $s = $t === null ? null : mb_strtolower($t);
        if (! $s) {
            return null;
        }
        if (in_array($s, ['nessuno', 'nessuna', 'no', 'none', '-'], true)) {
            return 'none';
        }
        if (in_array($s, ['importo', 'euro', '€', 'amount'], true)) {
            return 'amount';
        }
        if (in_array($s, ['percentuale', '%', 'perc', 'percent'], true)) {
            return 'percent';
        }
        throw new CellError("modalità oneri “{$s}” non riconosciuta (nessuno, importo, percentuale)");
    }
}
