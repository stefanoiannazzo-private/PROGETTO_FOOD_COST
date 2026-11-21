<?php

declare(strict_types=1);

namespace App\Support\Validation;

use Closure;

/**
 * Nodo di schema: un parser di base più una catena di controlli e trasformazioni, nell'ordine dichiarato.
 */
final class Schema
{
    /** @var list<Closure> */
    private array $steps = [];

    private bool $nullable = false;

    private bool $optional = false;

    private bool $hasDefault = false;

    private mixed $default = null;

    public function __construct(private Closure $base, public readonly array $meta = [])
    {
    }

    public function run(mixed $v, array $path, Issues $issues): mixed
    {
        if ($v instanceof Missing) {
            if ($this->hasDefault) {
                return $this->default;
            }
            if ($this->optional) {
                return $v;
            }
        }
        if ($v === null && $this->nullable) {
            return null;
        }
        $before = $issues->count();
        $out = ($this->base)($v, $path, $issues);
        if ($out instanceof Missing && $issues->count() > $before) {
            return $out;
        }
        foreach ($this->steps as $step) {
            $out = $step($out, $path, $issues);
        }

        return $out;
    }

    private function with(Closure $step): self
    {
        $c = clone $this;
        $c->steps[] = $step;

        return $c;
    }

    public function nullable(): self
    {
        $c = clone $this;
        $c->nullable = true;

        return $c;
    }

    public function optional(): self
    {
        $c = clone $this;
        $c->optional = true;

        return $c;
    }

    public function default(mixed $value): self
    {
        $c = clone $this;
        $c->hasDefault = true;
        $c->default = $value;

        return $c;
    }

    public function trim(): self
    {
        return $this->with(fn ($v) => is_string($v) ? trim($v) : $v);
    }

    public function toLowerCase(): self
    {
        return $this->with(fn ($v) => is_string($v) ? mb_strtolower($v) : $v);
    }

    public function min(int $n, ?string $message = null): self
    {
        return $this->with(function ($v, $path, Issues $issues) use ($n, $message) {
            if (is_string($v) && mb_strlen($v) < $n) {
                $issues->add($path, $message ?? "Too small: expected string to have >={$n} characters");
            } elseif (is_array($v) && count($v) < $n) {
                $issues->add($path, $message ?? "Too small: expected array to have >={$n} items");
            }

            return $v;
        });
    }

    public function max(int $n, ?string $message = null): self
    {
        return $this->with(function ($v, $path, Issues $issues) use ($n, $message) {
            if (is_string($v) && mb_strlen($v) > $n) {
                $issues->add($path, $message ?? "Too big: expected string to have <={$n} characters");
            } elseif (is_array($v) && count($v) > $n) {
                $issues->add($path, $message ?? "Too big: expected array to have <={$n} items");
            }

            return $v;
        });
    }

    public function regex(string $pattern, string $message): self
    {
        return $this->with(function ($v, $path, Issues $issues) use ($pattern, $message) {
            if (is_string($v) && ! preg_match($pattern, $v)) {
                $issues->add($path, $message);
            }

            return $v;
        });
    }

    /** Controllo personalizzato; $at aggiunge un sotto-percorso (come path in superRefine/refine). */
    public function refine(Closure $check, string $message, array $at = []): self
    {
        return $this->with(function ($v, $path, Issues $issues) use ($check, $message, $at) {
            if (! $v instanceof Missing && ! $check($v)) {
                $issues->add([...$path, ...$at], $message);
            }

            return $v;
        });
    }

    /** Controlli multipli: $fn($value, $add) dove $add(string $message, array $subPath = []). */
    public function superRefine(Closure $fn): self
    {
        return $this->with(function ($v, $path, Issues $issues) use ($fn) {
            if (! $v instanceof Missing) {
                $fn($v, fn (string $m, array $sub = []) => $issues->add([...$path, ...$sub], $m));
            }

            return $v;
        });
    }

    public function transform(Closure $fn): self
    {
        return $this->with(fn ($v) => $v instanceof Missing ? $v : $fn($v));
    }

    /** Estende uno schema oggetto con altri campi (z.object().extend()). */
    public function extend(array $shape): self
    {
        return S::object(array_merge($this->meta['shape'] ?? [], $shape));
    }

    /** z.object().omit() */
    public function omit(array $keys): self
    {
        return S::object(array_diff_key($this->meta['shape'] ?? [], array_flip($keys)));
    }

    /** z.object().partial() */
    public function partial(): self
    {
        return S::object(array_map(fn (Schema $s) => $s->optional(), $this->meta['shape'] ?? []));
    }
}
