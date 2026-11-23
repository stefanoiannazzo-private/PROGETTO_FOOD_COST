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

    // mai in cache (nemmeno nelle cache dell'hosting): dopo un aggiornamento deve puntare subito ai nuovi file
    return response((string) file_get_contents($index), 200, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store, private']);
})->where('path', '^(?!api(/|$)).*');
