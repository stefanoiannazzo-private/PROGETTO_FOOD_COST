<?php

declare(strict_types=1);

namespace App\Auth;

/**
 * Password e token. Le password usano password_hash di PHP (bcrypt o argon2): non ci sono dati da migrare
 * dall'originale (decisione D3), quindi il formato scrypt non serve. I token sono salvati solo come hash SHA-256.
 */
final class Crypto
{
    public const PASSWORD_MIN_LENGTH = 10;

    public static function hashPassword(string $password): string
    {
        return password_hash($password, PASSWORD_DEFAULT);
    }

    public static function verifyPassword(string $password, ?string $stored): bool
    {
        return $stored !== null && $stored !== '' && password_verify($password, $stored);
    }

    public static function newToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }
}
