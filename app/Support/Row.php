<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Normalizza le righe lette da MySQL perché il JSON sia identico a quello dell'originale (pg + JSON.stringify):
 * colonne *_at in ISO 8601 UTC con millisecondi, booleani come true/false, JSON decodificato.
 */
final class Row
{
    public static function one(?object $row, array $bools = [], array $json = []): ?array
    {
        if ($row === null) {
            return null;
        }
        $out = [];
        foreach ((array) $row as $k => $v) {
            if ($v !== null && str_ends_with($k, '_at') && is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/', $v)) {
                $v = Clock::iso($v);
            } elseif (in_array($k, $bools, true)) {
                $v = $v === null ? null : (bool) $v;
            } elseif (in_array($k, $json, true) && is_string($v)) {
                $v = json_decode($v, true);
            }
            $out[$k] = $v;
        }

        return $out;
    }

    /** @param iterable<object> $rows */
    public static function all(iterable $rows, array $bools = [], array $json = []): array
    {
        $out = [];
        foreach ($rows as $r) {
            $out[] = self::one($r, $bools, $json);
        }

        return $out;
    }

    /** Condizione LIKE sensibile agli accenti e non alle maiuscole, come lower(col) LIKE di PostgreSQL. */
    public static function likeSql(string $col): string
    {
        return "LOWER({$col}) COLLATE utf8mb4_0900_as_cs LIKE ?";
    }

    /** Pattern sicuro per LIKE (minuscole, caratteri speciali protetti), come likePattern dell'originale. */
    public static function like(string $q): string
    {
        return '%'.preg_replace('/[\\\\%_]/', '\\\\$0', mb_strtolower($q)).'%';
    }
}
