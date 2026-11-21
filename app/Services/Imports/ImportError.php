<?php

declare(strict_types=1);

namespace App\Services\Imports;

use RuntimeException;

/** Errore "atteso" dell'importazione (messaggio mostrato all'utente, nessun nuovo tentativo). */
class ImportError extends RuntimeException
{
}
