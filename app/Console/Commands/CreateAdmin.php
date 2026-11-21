<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Auth\Crypto;
use App\Support\Clock;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Crea il superadmin (amministratore della piattaforma) e, facoltativamente, la sua prima azienda.
 * Equivale a create-admin dell'originale. La password viene chiesta senza mostrarla, oppure letta da ADMIN_PASSWORD.
 *
 *   php artisan foodcost:create-admin --email=tu@dominio.it --name="Nome Cognome" [--company="Azienda"]
 *   php artisan foodcost:create-admin --email=tu@dominio.it --reset-password
 */
final class CreateAdmin extends Command
{
    protected $signature = 'foodcost:create-admin {--email=} {--name=} {--company=} {--reset-password}';

    protected $description = 'Crea il superadmin della piattaforma (o ne reimposta la password)';

    public function handle(): int
    {
        $email = mb_strtolower(trim((string) $this->option('email')));
        $name = trim((string) $this->option('name'));
        $company = trim((string) $this->option('company'));
        $reset = (bool) $this->option('reset-password');
        if (! filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->error('Indica un’email valida con --email.');

            return 1;
        }
        if (! $reset && $name === '') {
            $this->error('Indica --name (oppure usa --reset-password per un utente esistente).');

            return 1;
        }
        $password = getenv('ADMIN_PASSWORD') ?: null;
        if (! $password) {
            $password = (string) $this->secret('Password del nuovo amministratore');
            if ($password !== (string) $this->secret('Ripeti la password')) {
                $this->error('Le password non coincidono.');

                return 1;
            }
        }
        if (mb_strlen($password) < Crypto::PASSWORD_MIN_LENGTH) {
            $this->error('La password deve avere almeno '.Crypto::PASSWORD_MIN_LENGTH.' caratteri.');

            return 1;
        }
        $existing = DB::table('users')->where('email', $email)->first();
        if ($reset) {
            if (! $existing) {
                $this->error("Nessun utente con email {$email}.");

                return 1;
            }
            DB::transaction(function () use ($existing, $password) {
                DB::table('users')->where('id', $existing->id)->update(['password_hash' => Crypto::hashPassword($password), 'is_active' => 1]);
                DB::table('sessions')->where('user_id', $existing->id)->delete();
            });
            $this->info("Password reimpostata per {$email}. Le sessioni aperte sono state chiuse.");

            return 0;
        }
        if ($existing) {
            $this->error("Esiste già un utente con email {$email} (usa --reset-password).");

            return 1;
        }
        DB::transaction(function () use ($email, $name, $company, $password) {
            $uid = (string) Str::uuid();
            DB::table('users')->insert(['id' => $uid, 'email' => $email, 'name' => $name, 'password_hash' => Crypto::hashPassword($password), 'is_platform_admin' => 1, 'created_at' => Clock::now()]);
            if ($company !== '') {
                $cid = (string) Str::uuid();
                DB::table('companies')->insert(['id' => $cid, 'name' => $company, 'created_at' => Clock::now()]);
                DB::table('memberships')->insert(['id' => (string) Str::uuid(), 'company_id' => $cid, 'user_id' => $uid, 'role' => 'admin', 'extra_permissions' => '[]', 'is_active' => 1, 'created_at' => Clock::now()]);
            }
        });
        $this->info("Superadmin {$email} creato".($company !== '' ? " con l’azienda “{$company}”" : '').'.');

        return 0;
    }
}
