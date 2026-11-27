<?php

declare(strict_types=1);

namespace App\Auth;

/** Contesto autenticato della richiesta (port di AuthContext/TenantContext). */
final class AuthContext
{
    /**
     * @param  array{id: string, email: string, name: string, isPlatformAdmin: bool}  $user
     * @param  array{id: string, name: string}|null  $company
     * @param  list<string>  $permissions
     * @param  bool  $assist  il superadmin opera su un'azienda di cui non è membro (modalità assistenza)
     */
    public function __construct(
        public readonly string $sessionHash,
        public readonly array $user,
        public readonly ?array $company,
        public readonly ?string $role,
        public readonly array $permissions,
        public readonly bool $assist = false,
        // NUOVO: tablet di servizio (area Ordini): solo sala e cucina, l'operatore si identifica con il PIN
        public readonly bool $serviceDevice = false,
    ) {
    }

    public function can(string $permission): bool
    {
        return in_array($permission, $this->permissions, true);
    }

    public function companyId(): string
    {
        return $this->company['id'];
    }

    public function userId(): string
    {
        return $this->user['id'];
    }

    public function isPlatformAdmin(): bool
    {
        return $this->user['isPlatformAdmin'];
    }
}
