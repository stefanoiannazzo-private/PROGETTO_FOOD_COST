<?php

declare(strict_types=1);

namespace App\Domain\Costing;

use Brick\Math\BigDecimal;
use Brick\Math\BigNumber;
use Brick\Math\RoundingMode;
use InvalidArgumentException;
use JsonSerializable;
use Stringable;

/**
 * Decimale ad alta precisione usato in tutto il dominio.
 *
 * Emula fedelmente decimal.js configurato come nell'originale (precision 40, ROUND_HALF_UP):
 * ogni operazione aritmetica restituisce il risultato arrotondato a 40 cifre significative,
 * con arrotondamento "metà verso l'alto" (lontano dallo zero). Il costruttore non arrotonda.
 * Nessun arrotondamento nei calcoli intermedi oltre a questo: si arrotonda solo in visualizzazione.
 */
final class Dec implements JsonSerializable, Stringable
{
    public const PRECISION = 40;

    private function __construct(private readonly BigDecimal $v)
    {
    }

    public static function of(Dec|BigNumber|int|string $value): self
    {
        if ($value instanceof self) {
            return $value;
        }
        if (is_string($value)) {
            $value = trim($value);
            if (! preg_match('/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/', $value)) {
                throw new InvalidArgumentException("Decimale non valido: {$value}");
            }
            if (str_starts_with($value, '+')) {
                $value = substr($value, 1);
            }
            if (str_starts_with($value, '.')) {
                $value = '0'.$value;
            } elseif (str_starts_with($value, '-.')) {
                $value = '-0'.substr($value, 1);
            }
            if (preg_match('/\.$/', $value)) {
                $value .= '0';
            }
            if (preg_match('/^(.*?)\.([eE].*)$/', $value, $m)) {
                $value = $m[1].'.0'.$m[2];
            }
        }

        return new self(BigDecimal::of($value)->strippedOfTrailingZeros());
    }

    /** Interpreta un decimale arrivato dall'esterno; null se non valido (come parseDec dell'originale). */
    public static function parse(mixed $value): ?self
    {
        if ($value === null || $value === '') {
            return null;
        }
        if ($value instanceof self) {
            return $value;
        }
        if (is_float($value)) {
            if (! is_finite($value)) {
                return null;
            }
            $value = self::floatToString($value);
        }
        if (is_bool($value) || is_array($value) || is_object($value)) {
            return null;
        }
        try {
            return self::of(is_int($value) ? $value : (string) $value);
        } catch (\Throwable) {
            return null;
        }
    }

    /** Rappresentazione più breve che identifica il float, come Number.prototype.toString di JavaScript. */
    private static function floatToString(float $f): string
    {
        $s = var_export($f, true);

        return str_contains($s, 'E') || str_contains($s, 'e') ? sprintf('%.17g', $f) : $s;
    }

    public static function zero(): self
    {
        static $z;

        return $z ??= new self(BigDecimal::zero());
    }

    public static function one(): self
    {
        static $o;

        return $o ??= new self(BigDecimal::one());
    }

    public static function sixty(): self
    {
        static $s;

        return $s ??= new self(BigDecimal::of(60));
    }

    /** @param iterable<Dec> $values */
    public static function sum(iterable $values): self
    {
        $acc = self::zero();
        foreach ($values as $v) {
            $acc = $acc->plus($v);
        }

        return $acc;
    }

    public function plus(Dec|int|string $o): self
    {
        return new self(self::round($this->v->plus(self::of($o)->v)));
    }

    public function minus(Dec|int|string $o): self
    {
        return new self(self::round($this->v->minus(self::of($o)->v)));
    }

    public function times(Dec|int|string $o): self
    {
        return new self(self::round($this->v->multipliedBy(self::of($o)->v)));
    }

    public function div(Dec|int|string $o): self
    {
        $b = self::of($o)->v;
        if ($b->isZero()) {
            throw new \DivisionByZeroError('Divisione per zero.');
        }
        if ($this->v->isZero()) {
            return self::zero();
        }
        // Risultato troncato con almeno una cifra di guardia oltre le 40 significative,
        // poi arrotondato HALF_UP: equivale all'arrotondamento esatto del quoziente reale.
        $diff = self::adjustedExponent($this->v) - self::adjustedExponent($b);
        $scale = max(0, self::PRECISION + 2 - $diff);
        $q = $this->v->dividedBy($b, $scale, RoundingMode::Down);
        $exact = $q->multipliedBy($b)->isEqualTo($this->v);
        if (! $exact && $q->isZero()) {
            $q = $this->v->dividedBy($b, $scale + self::PRECISION, RoundingMode::Down);
        }

        return new self(self::roundTruncated($q, $exact));
    }

    public function neg(): self
    {
        return new self($this->v->negated());
    }

    public function abs(): self
    {
        return new self($this->v->abs());
    }

    public function cmp(Dec|int|string $o): int
    {
        return $this->v->compareTo(self::of($o)->v);
    }

    public function eq(Dec|int|string $o): bool
    {
        return $this->cmp($o) === 0;
    }

    public function gt(Dec|int|string $o): bool
    {
        return $this->cmp($o) > 0;
    }

    public function gte(Dec|int|string $o): bool
    {
        return $this->cmp($o) >= 0;
    }

    public function lt(Dec|int|string $o): bool
    {
        return $this->cmp($o) < 0;
    }

    public function lte(Dec|int|string $o): bool
    {
        return $this->cmp($o) <= 0;
    }

    public function isZero(): bool
    {
        return $this->v->isZero();
    }

    public function isNeg(): bool
    {
        return $this->v->isNegative();
    }

    /** Arrotondamento di visualizzazione (mai usato nei calcoli), come toDecimalPlaces(places, ROUND_HALF_UP). */
    public function toDecimalPlaces(int $places = 2): self
    {
        if ($this->v->getScale() <= $places) {
            return $this;
        }

        return new self($this->v->toScale($places, RoundingMode::HalfUp)->strippedOfTrailingZeros());
    }

    /** Stringa decimale con il punto, senza notazione esponenziale né zeri finali (toFixed() di decimal.js). */
    public function toFixed(?int $places = null): string
    {
        if ($places === null) {
            return (string) $this->v;
        }

        return (string) $this->v->toScale($places, RoundingMode::HalfUp);
    }

    public function toFloat(): float
    {
        return $this->v->toFloat();
    }

    public function big(): BigDecimal
    {
        return $this->v;
    }

    public function __toString(): string
    {
        return $this->toFixed();
    }

    public function jsonSerialize(): string
    {
        return $this->toFixed();
    }

    /* ----------------------------------------------------------------- */

    private static function digits(BigDecimal $v): int
    {
        $u = (string) $v->getUnscaledValue();

        return strlen(ltrim($u, '-'));
    }

    /** Esponente della cifra più significativa: 123.4 → 2, 0.05 → -2. */
    private static function adjustedExponent(BigDecimal $v): int
    {
        return self::digits($v) - $v->getScale() - 1;
    }

    /** Arrotonda un valore esatto a PRECISION cifre significative (HALF_UP). */
    private static function round(BigDecimal $v): BigDecimal
    {
        if ($v->isZero()) {
            return BigDecimal::zero();
        }
        $p = self::digits($v);
        if ($p <= self::PRECISION) {
            return $v->strippedOfTrailingZeros();
        }
        return self::toSignificant($v, $v->getScale() - ($p - self::PRECISION));
    }

    /**
     * Arrotonda un quoziente troncato. Se il troncamento ha scartato qualcosa (non esatto),
     * le cifre di guardia garantiscono che la decisione HALF_UP sia la stessa del valore reale.
     */
    private static function roundTruncated(BigDecimal $q, bool $exact): BigDecimal
    {
        if ($q->isZero()) {
            return BigDecimal::zero();
        }
        $p = self::digits($q);
        if ($p <= self::PRECISION) {
            // Possibile solo se il quoziente è esatto (le cifre sono sufficienti) o intero grande.
            return $q->strippedOfTrailingZeros();
        }
        return self::toSignificant($q, $q->getScale() - ($p - self::PRECISION));
    }

    /** Arrotonda HALF_UP alla scala indicata, anche negativa (interi con più di 40 cifre). */
    private static function toSignificant(BigDecimal $v, int $newScale): BigDecimal
    {
        if ($newScale >= 0) {
            return $v->toScale($newScale, RoundingMode::HalfUp)->strippedOfTrailingZeros();
        }
        $factor = BigDecimal::one()->withPointMovedRight(-$newScale);

        return $v->dividedBy($factor, 0, RoundingMode::HalfUp)->multipliedBy($factor)->strippedOfTrailingZeros();
    }
}
