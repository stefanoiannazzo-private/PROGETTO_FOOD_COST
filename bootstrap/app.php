<?php

use App\Http\Middleware\CsrfProtection;
use App\Http\Middleware\LoadSession;
use App\Http\Middleware\SecurityHeaders;
use App\Support\AppError;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Foundation\Http\Middleware\ConvertEmptyStringsToNull;
use Illuminate\Foundation\Http\Middleware\TrimStrings;
use Illuminate\Http\Exceptions\PostTooLargeException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        commands: __DIR__.'/../routes/console.php',
        using: function () {
            Route::prefix('api')->middleware('api')->group(base_path('routes/api.php'));
            Route::middleware('web')->group(base_path('routes/web.php'));
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // I valori arrivano al validatore così come li ha inviati il browser (come nell'originale).
        $middleware->remove([TrimStrings::class, ConvertEmptyStringsToNull::class]);
        // Interfaccia e API stanno sullo stesso dominio, come nell'originale: nessuna intestazione CORS verso altri siti
        $middleware->remove(\Illuminate\Http\Middleware\HandleCors::class);
        $middleware->append(SecurityHeaders::class);
        $middleware->encryptCookies(except: ['fc_session']);
        $middleware->group('api', [CsrfProtection::class, LoadSession::class]);
        $middleware->trustProxies(at: env('TRUST_PROXIES', ''));
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $json = fn (int $status, string $code, string $message, mixed $details = null) => response()->json(
            ['error' => ['code' => $code, 'message' => $message, 'details' => $details]],
            $status,
            [],
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES,
        );
        $exceptions->dontReport([AppError::class]);
        $exceptions->render(function (Throwable $e, Request $request) use ($json) {
            if (! $request->is('api/*')) {
                return null;
            }
            if ($e instanceof AppError) {
                return $json($e->status, $e->errorCode, $e->getMessage(), $e->details);
            }
            if ($e instanceof PostTooLargeException) {
                $mb = (int) round(config('foodcost.import_max_bytes') / 1024 / 1024);

                return $json(413, 'file_too_large', "File troppo grande (massimo {$mb} MB).");
            }
            if ($e instanceof NotFoundHttpException || $e instanceof MethodNotAllowedHttpException) {
                return $json(404, 'not_found', 'Risorsa non trovata.');
            }
            if ($e instanceof HttpExceptionInterface && $e->getStatusCode() < 500) {
                return $json($e->getStatusCode(), 'bad_request', $e->getMessage() ?: 'Richiesta non valida.');
            }
            report($e);

            return $json(500, 'server_error', 'Errore interno: riprova o contatta l’assistenza.');
        });
    })->create();
