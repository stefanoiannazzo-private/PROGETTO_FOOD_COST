<?php

use Illuminate\Support\Facades\Route;

/*
 * Interfaccia (SPA React compilata con Vite in public/app/index.html): ogni percorso che non è /api
 * restituisce la pagina dell'applicazione, così funzionano anche i link diretti (es. /ricette/<id>).
 */
Route::get('/{path?}', function () {
    $index = public_path('app/index.html');
    if (! is_file($index)) {
        return response('Interfaccia non ancora compilata: esegui "npm run build" nella cartella frontend.', 503);
    }

    return response()->file($index, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-cache']);
})->where('path', '^(?!api(/|$)).*');
