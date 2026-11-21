<?php

declare(strict_types=1);

namespace App\Support\Validation;

/** Raccolta degli errori di validazione: il primo messaggio per ogni percorso, come validationError dell'originale. */
final class Issues
{
    /** @var array<string, string> */
    private array $fields = [];

    private int $count = 0;

    public function add(array $path, string $message): void
    {
        $this->count++;
        $key = $path === [] ? '_' : implode('.', $path);
        if (! isset($this->fields[$key])) {
            $this->fields[$key] = $message;
        }
    }

    public function any(): bool
    {
        return $this->count > 0;
    }

    public function count(): int
    {
        return $this->count;
    }

    /** @return array<string, string> */
    public function fields(): array
    {
        return $this->fields;
    }
}
