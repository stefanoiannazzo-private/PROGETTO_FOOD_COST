<?php

declare(strict_types=1);

namespace App\Support\Validation;

use App\Domain\Costing\Dec;
use App\Domain\Costing\Units;
use App\Support\AppError;
use Closure;

/**
 * Schemi di validazione equivalenti a quelli Zod dell'originale (apps/api/src/http/schemas.ts e rotte).
 *
 * Perché non solo le regole di Laravel: l'originale trasforma i valori mentre li valida (trim, minuscole,
 * decimali normalizzati "1234.56", stringa vuota → null, valori predefiniti) e il frontend si aspetta
 * esattamente gli stessi messaggi italiani e la stessa forma { fields: { "percorso.campo": messaggio } }.
 * Le Form Request dell'applicazione (app/Http/Requests) usano questi schemi.
 */
final class S
{
    /** Valore assente (undefined in JavaScript), distinto da null. */
    public static function missing(): Missing
    {
        static $m;

        return $m ??= new Missing;
    }

    public static function parse(Schema $schema, mixed $data): mixed
    {
        $issues = new Issues;
        $out = $schema->run($data ?? [], [], $issues);
        if ($issues->any()) {
            throw new AppError(422, 'validation_failed', 'Alcuni dati non sono validi.', ['fields' => $issues->fields()]);
        }

        return $out;
    }

    /* -------------------------- costruttori -------------------------- */

    public static function object(array $shape): Schema
    {
        return new Schema(function ($v, array $path, Issues $issues) use ($shape) {
            if (! is_array($v) || (array_is_list($v) && $v !== [])) {
                $issues->add($path, 'Invalid input: expected object, received '.self::typeOf($v));

                return S::missing();
            }
            $out = [];
            foreach ($shape as $key => $schema) {
                $raw = array_key_exists($key, $v) ? $v[$key] : S::missing();
                $res = $schema->run($raw, [...$path, $key], $issues);
                if (! $res instanceof Missing) {
                    $out[$key] = $res;
                }
            }

            return $out;
        }, ['shape' => $shape]);
    }

    public static function array(Schema $item): Schema
    {
        return new Schema(function ($v, array $path, Issues $issues) use ($item) {
            if (! is_array($v) || ! array_is_list($v)) {
                $issues->add($path, 'Invalid input: expected array, received '.self::typeOf($v));

                return S::missing();
            }
            $out = [];
            foreach ($v as $i => $x) {
                $out[] = $item->run($x, [...$path, $i], $issues);
            }

            return $out;
        });
    }

    public static function string(?string $typeError = null): Schema
    {
        return new Schema(function ($v, array $path, Issues $issues) use ($typeError) {
            if (! is_string($v)) {
                $issues->add($path, $typeError ?? 'Invalid input: expected string, received '.self::typeOf($v));

                return S::missing();
            }

            return $v;
        });
    }

    public static function bool(): Schema
    {
        return new Schema(function ($v, array $path, Issues $issues) {
            if (! is_bool($v)) {
                $issues->add($path, 'Invalid input: expected boolean, received '.self::typeOf($v));

                return S::missing();
            }

            return $v;
        });
    }

    /** z.number().int() */
    public static function int(?int $min = null, ?int $max = null): Schema
    {
        return new Schema(function ($v, array $path, Issues $issues) use ($min, $max) {
            if (! is_int($v) && ! (is_float($v) && floor($v) === $v)) {
                $issues->add($path, is_float($v) ? 'Invalid input: expected int, received number' : 'Invalid input: expected number, received '.self::typeOf($v));

                return S::missing();
            }
            $v = (int) $v;
            if ($min !== null && $v < $min) {
                $issues->add($path, "Too small: expected number to be >={$min}");
            }
            if ($max !== null && $v > $max) {
                $issues->add($path, "Too big: expected number to be <={$max}");
            }

            return $v;
        });
    }

    /** z.coerce.number().int() (query string) */
    public static function coerceInt(?int $min = null, ?int $max = null): Schema
    {
        return self::preprocess(fn ($v) => $v instanceof Missing ? $v : (is_numeric($v) ? $v + 0 : $v), self::int($min, $max));
    }

    public static function enum(array $values): Schema
    {
        return new Schema(function ($v, array $path, Issues $issues) use ($values) {
            if (! is_string($v) || ! in_array($v, $values, true)) {
                $issues->add($path, 'Invalid option: expected one of '.implode('|', array_map(fn ($x) => '"'.$x.'"', $values)));

                return S::missing();
            }

            return $v;
        });
    }

    public static function measureUnit(): Schema
    {
        return self::enum(Units::MEASURE_UNITS);
    }

    public static function uuid(): Schema
    {
        return self::string()->refine(
            fn ($v) => (bool) preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $v),
            'Invalid UUID',
        );
    }

    public static function email(): Schema
    {
        return self::string()->refine(fn ($v) => filter_var($v, FILTER_VALIDATE_EMAIL) !== false, 'Invalid email address');
    }

    public static function isoDate(): Schema
    {
        return self::string()
            ->regex('/^\d{4}-\d{2}-\d{2}$/', 'Data non valida (formato aaaa-mm-gg).')
            ->refine(fn ($v) => self::validDate($v), 'Data non valida.');
    }

    /** Date.parse di JavaScript su "aaaa-mm-gg": rifiuta mesi e giorni fuori intervallo, non il 31 aprile. */
    private static function validDate(string $v): bool
    {
        if (! preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m)) {
            return false;
        }
        $mo = (int) $m[2];
        $d = (int) $m[3];

        return $mo >= 1 && $mo <= 12 && $d >= 1 && $d <= 31;
    }

    /** Testo facoltativo: stringa vuota → null; trim; lunghezza massima. */
    public static function optText(int $max = 2000): Schema
    {
        return self::preprocess(
            fn ($v) => is_string($v) && trim($v) === '' ? null : $v,
            self::string()->trim()->max($max)->nullable()->optional(),
        );
    }

    /** Testo obbligatorio con messaggio "<label> è obbligatorio.". */
    public static function reqText(string $label, int $max = 200): Schema
    {
        return self::string("{$label} è obbligatorio.")->trim()->min(1, "{$label} è obbligatorio.")->max($max);
    }

    /**
     * Decimale in ingresso: numero oppure stringa normalizzata ("1234.56"); tollerata la sola virgola decimale.
     * Restituisce la stringa normalizzata col punto.
     *
     * @param  array{min?: int|string, gt?: int|string, max?: int|string, label?: string}  $o
     */
    public static function dec(array $o = []): Schema
    {
        $label = $o['label'] ?? 'Il valore';

        return new Schema(function ($v, array $path, Issues $issues) use ($o, $label) {
            if (! is_string($v) && ! is_int($v) && ! is_float($v)) {
                $issues->add($path, self::typeOf($v) === 'undefined'
                    ? 'Invalid input: expected string, received undefined'
                    : 'Invalid input: expected string, received '.self::typeOf($v));

                return S::missing();
            }
            $parsed = self::parseApiNumber($v);
            if ($parsed === null) {
                $issues->add($path, "{$label} non è un numero valido (usa il formato 1234.56).");

                return S::missing();
            }
            if (isset($o['gt']) && ! $parsed->gt((string) $o['gt'])) {
                $issues->add($path, "{$label} deve essere maggiore di {$o['gt']}.");
            }
            if (isset($o['min']) && $parsed->lt((string) $o['min'])) {
                $issues->add($path, "{$label} non può essere inferiore a {$o['min']}.");
            }
            if (isset($o['max']) && $parsed->gt((string) $o['max'])) {
                $issues->add($path, "{$label} non può superare {$o['max']}.");
            }

            return $parsed->toFixed();
        });
    }

    /** Decimale facoltativo: stringa vuota, assente o null → null. */
    public static function decOpt(array $o = []): Schema
    {
        return self::preprocess(fn ($v) => $v === '' || $v instanceof Missing ? null : $v, self::dec($o)->nullable());
    }

    public static function parseApiNumber(string|int|float $v): ?Dec
    {
        if (is_int($v) || is_float($v)) {
            return Dec::parse($v);
        }
        $s = trim($v);
        if (preg_match('/^[-+]?\d+([.,]\d+)?$/', $s)) {
            return Dec::parse(preg_replace('/,/', '.', $s, 1));
        }

        return null;
    }

    public static function preprocess(Closure $fn, Schema $schema): Schema
    {
        return new Schema(fn ($v, array $path, Issues $issues) => $schema->run($fn($v), $path, $issues));
    }

    /** Qualsiasi valore (z.unknown()). */
    public static function any(): Schema
    {
        return new Schema(fn ($v) => $v);
    }

    public static function typeOf(mixed $v): string
    {
        return match (true) {
            $v instanceof Missing => 'undefined',
            $v === null => 'null',
            is_bool($v) => 'boolean',
            is_int($v), is_float($v) => 'number',
            is_string($v) => 'string',
            is_array($v) && array_is_list($v) => 'array',
            default => 'object',
        };
    }
}
