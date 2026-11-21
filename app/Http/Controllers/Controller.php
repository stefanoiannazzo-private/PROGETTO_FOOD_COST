<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Auth\AuthContext;
use App\Support\AppError;
use App\Support\Validation\S;
use App\Support\Validation\Schema;
use Illuminate\Http\Request;

abstract class Controller
{
    protected function auth(Request $req): ?AuthContext
    {
        return $req->attributes->get('auth');
    }

    protected function requireAuth(Request $req): AuthContext
    {
        $auth = $this->auth($req);
        if (! $auth) {
            throw AppError::unauthorized();
        }

        return $auth;
    }

    /**
     * Contesto aziendale: deriva SEMPRE dalla sessione autenticata e dalla membership verificata,
     * mai da un identificativo passato dal browser.
     */
    protected function requireCompany(Request $req, string ...$perms): AuthContext
    {
        $auth = $this->requireAuth($req);
        if (! $auth->company || ! $auth->role) {
            throw new AppError(409, 'no_active_company', 'Seleziona un’azienda per continuare.');
        }
        foreach ($perms as $p) {
            if (! $auth->can($p)) {
                throw AppError::forbidden();
            }
        }

        return $auth;
    }

    /** Solo il superadmin di piattaforma. */
    protected function requirePlatformAdmin(Request $req): AuthContext
    {
        $auth = $this->requireAuth($req);
        if (! $auth->isPlatformAdmin()) {
            throw AppError::forbidden();
        }

        return $auth;
    }

    protected function body(Request $req): mixed
    {
        if ($req->isJson()) {
            $data = json_decode($req->getContent() ?: 'null', true);

            return $data;
        }

        return $req->request->all();
    }

    protected function parse(Schema $schema, mixed $data): mixed
    {
        return S::parse($schema, $data);
    }

    protected function parseBody(Request $req, Schema $schema): array
    {
        return S::parse($schema, $this->body($req));
    }

    protected function parseQuery(Request $req, Schema $schema): array
    {
        return S::parse($schema, $req->query->all());
    }

    protected function uuid(string $id): string
    {
        S::parse(S::object(['id' => S::uuid()]), ['id' => $id]);

        return strtolower($id);
    }
}
