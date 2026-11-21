<?php

declare(strict_types=1);

namespace App\Support;

use DateTimeImmutable;
use DateTimeZone;

/** Date e orari. Il database lavora in UTC; la "data di oggi" si calcola nel fuso dell'applicazione (Europe/Rome). */
final class Clock
{
    public static function today(): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone(config('foodcost.tz', 'Europe/Rome'))))->format('Y-m-d');
    }

    /** Istante corrente per le colonne DATETIME(3) in UTC. */
    public static function now(): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s.v');
    }

    public static function plusSeconds(int $seconds): string
    {
        return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->modify("+{$seconds} seconds")->format('Y-m-d H:i:s.v');
    }

    /** "2026-11-21 18:00:00.123" (UTC) → "2026-11-21T18:00:00.123Z", come Date.toISOString(). */
    public static function iso(?string $dbValue): ?string
    {
        if ($dbValue === null) {
            return null;
        }
        $dt = new DateTimeImmutable($dbValue, new DateTimeZone('UTC'));

        return $dt->format('Y-m-d\TH:i:s.v\Z');
    }

    public static function isPast(string $dbValue): bool
    {
        return new DateTimeImmutable($dbValue, new DateTimeZone('UTC')) < new DateTimeImmutable('now', new DateTimeZone('UTC'));
    }

    public static function msSince(string $dbValue): float
    {
        $t = new DateTimeImmutable($dbValue, new DateTimeZone('UTC'));

        return (microtime(true) - (float) $t->format('U.u')) * 1000;
    }
}
