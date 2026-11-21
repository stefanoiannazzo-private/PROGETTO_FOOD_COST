<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Support\Facades\RateLimiter;

/** Limiti di frequenza per IP, come @fastify/rate-limit: conta ogni richiesta nella finestra. */
final class RateLimit
{
    public static function hit(string $name, string $ip, int $max, int $windowSeconds): void
    {
        if (app()->runningUnitTests() && ! config('foodcost.rate_limit_in_tests')) {
            return;
        }
        $key = "fc:{$name}:{$ip}";
        if (RateLimiter::tooManyAttempts($key, $max)) {
            throw new AppError(429, 'rate_limited', 'Troppi tentativi: riprova tra poco.');
        }
        RateLimiter::hit($key, $windowSeconds);
    }
}
