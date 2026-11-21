<?php

declare(strict_types=1);

namespace App\Services\Imports;

use Illuminate\Support\Facades\DB;

/**
 * Codici degli ingredienti di un'azienda tenuti in memoria durante l'applicazione di un'importazione.
 * Riproduce esattamente, senza una query per riga:
 * - Codes::next(): massimo dei codici PREFISSO-cifre (confronto sensibile alle maiuscole) + 1, considerando
 *   anche i codici già inseriti dalle righe precedenti della stessa importazione;
 * - il controllo di esistenza, che nel database non distingue maiuscole e minuscole (collation *_ci) ma
 *   distingue gli accenti (*_as_*).
 */
final class CodeBook
{
    /** @var array<string, true> */
    private array $codes = [];

    /** @var array<string, int> */
    private array $max = [];

    public function __construct(string $companyId)
    {
        foreach (DB::table('ingredients')->where('company_id', $companyId)->pluck('code') as $c) {
            $this->add((string) $c);
        }
    }

    public function exists(string $code): bool
    {
        return isset($this->codes[mb_strtolower($code, 'UTF-8')]);
    }

    public function add(string $code): void
    {
        $this->codes[mb_strtolower($code, 'UTF-8')] = true;
        if (preg_match('/^([A-Za-z]+)-(\d+)$/', $code, $m)) {
            $this->max[$m[1]] = max($this->max[$m[1]] ?? 0, (int) $m[2]);
        }
    }

    public function next(string $prefix): string
    {
        return $prefix.'-'.str_pad((string) (($this->max[$prefix] ?? 0) + 1), 5, '0', STR_PAD_LEFT);
    }
}
