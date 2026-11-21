<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Services\Sessions;
use Closure;
use Illuminate\Http\Request;

/** Carica il contesto autenticato dal cookie di sessione (se presente e valido). */
final class LoadSession
{
    public function handle(Request $request, Closure $next)
    {
        $token = $request->cookies->get(Sessions::COOKIE);
        $request->attributes->set('auth', is_string($token) && $token !== '' ? Sessions::load($token) : null);

        return $next($request);
    }
}
