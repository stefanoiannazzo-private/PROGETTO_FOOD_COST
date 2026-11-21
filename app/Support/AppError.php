<?php

declare(strict_types=1);

namespace App\Support;

use RuntimeException;

/** Errore applicativo con stato HTTP, codice e dettagli: reso come { error: { code, message, details } }. */
class AppError extends RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message, public readonly mixed $details = null)
    {
        parent::__construct($message);
    }

    public static function notFound(string $what = 'Risorsa'): self
    {
        return new self(404, 'not_found', "{$what} non trovata.");
    }

    public static function forbidden(string $message = 'Non hai i permessi per questa operazione.'): self
    {
        return new self(403, 'forbidden', $message);
    }

    public static function unauthorized(): self
    {
        return new self(401, 'unauthenticated', 'Sessione scaduta o non valida: effettua di nuovo l’accesso.');
    }

    public static function conflict(string $code, string $message, mixed $details = null): self
    {
        return new self(409, $code, $message, $details);
    }

    public static function badRequest(string $code, string $message, mixed $details = null): self
    {
        return new self(422, $code, $message, $details);
    }
}
