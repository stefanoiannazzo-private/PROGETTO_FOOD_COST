<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Support\AppError;
use Closure;
use Illuminate\Http\Request;

/**
 * Protezione CSRF dell'originale: le richieste che modificano dati devono arrivare dall'app
 * (header X-Requested-With: foodcost) e, se il browser indica l'origine, da un'origine ammessa.
 * Il cookie di sessione è httpOnly e SameSite=Lax.
 */
final class CsrfProtection
{
    private const SAFE = ['GET', 'HEAD', 'OPTIONS'];

    public function handle(Request $request, Closure $next)
    {
        if (! in_array($request->getMethod(), self::SAFE, true)) {
            if ($request->headers->get('X-Requested-With') !== 'foodcost') {
                throw new AppError(403, 'csrf', 'Richiesta non valida (protezione CSRF).');
            }
            $origin = $request->headers->get('Origin');
            if ($origin && ! in_array($origin, config('foodcost.allowed_origins'), true)) {
                throw new AppError(403, 'csrf', 'Origine della richiesta non ammessa.');
            }
        }

        return $next($request);
    }
}
