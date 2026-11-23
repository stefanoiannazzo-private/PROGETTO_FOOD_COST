<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Jobs;
use App\Support\AppError;
use Illuminate\Support\Str;
use App\Support\Validation\S;
use App\Support\Clock;
use App\Services\Audit;
use App\Auth\Crypto;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Indirizzo per il cron dell'hosting (Aruba: Pannello → Hosting Linux → Processi Cron, ogni 5–15 minuti):
 *   https://<dominio>/api/cron?k=<CRON_KEY>
 * Fa avanzare i lavori in coda (importazioni) e la pulizia periodica. Senza CRON_KEY l'indirizzo è disattivato.
 */
final class SystemController extends Controller
{
    public function cron(Request $req): array
    {
        $key = (string) config('foodcost.cron_key');
        if ($key === '' || ! hash_equals($key, (string) $req->query('k', ''))) {
            throw AppError::notFound();
        }
        @ignore_user_abort(true);
        Jobs::maybeScheduleCleanup();
        $done = Jobs::runPending(null, 50);
        // sessioni e token scaduti
        DB::table('sessions')->where('expires_at', '<', now('UTC')->format('Y-m-d H:i:s.v'))->delete();
        // NUOVO: avvisi di variazione più vecchi di 90 giorni
        \App\Services\ChangeAlerts::prune();

        return ['ok' => true, 'jobs' => $done];
    }

    /**
     * NUOVO: passo finale del deploy automatico su hosting senza SSH (chiamato da GitHub Actions dopo il caricamento FTP).
     * Esegue le migrazioni e ricostruisce la cache di configurazione. Protetto da DEPLOY_KEY (header X-Deploy-Key):
     * con la chiave vuota l'indirizzo non esiste.
     */
    public function deploy(Request $req): array
    {
        $key = (string) config('foodcost.deploy_key');
        if ($key === '' || ! hash_equals($key, (string) $req->headers->get('X-Deploy-Key', ''))) {
            throw AppError::notFound();
        }
        @ignore_user_abort(true);
        @set_time_limit(300);
        // cartelle di lavoro (il caricamento FTP non crea le cartelle vuote)
        foreach (['app/imports', 'app/outbox', 'framework/cache/data', 'framework/views', 'framework/sessions', 'logs'] as $dir) {
            if (! is_dir(storage_path($dir))) {
                @mkdir(storage_path($dir), 0755, true);
            }
        }
        if (! is_dir(base_path('bootstrap/cache'))) {
            @mkdir(base_path('bootstrap/cache'), 0755, true);
        }
        $out = [];
        foreach ([['migrate', ['--force' => true]], ['config:clear', []], ['route:clear', []], ['config:cache', []]] as [$cmd, $args]) {
            $code = Artisan::call($cmd, $args);
            $out[] = ['command' => $cmd, 'exit' => $code, 'output' => trim(Artisan::output())];
            if ($code !== 0) {
                throw new AppError(500, 'deploy_failed', "Comando {$cmd} non riuscito.", ['steps' => $out]);
            }
        }
        Log::info('deploy completato', ['steps' => array_column($out, 'command')]);

        return ['ok' => true, 'steps' => $out];
    }

    /**
     * NUOVO: primo superadmin su un hosting senza SSH (alternativa a `php artisan foodcost:create-admin`).
     * Protetto da DEPLOY_KEY e utilizzabile solo finché non esiste nessun amministratore di piattaforma.
     * Non riceve password: crea l'utente e restituisce un link monouso (60 minuti) per impostarla.
     */
    public function firstAdmin(Request $req): array
    {
        $key = (string) config('foodcost.deploy_key');
        if ($key === '' || ! hash_equals($key, (string) $req->headers->get('X-Deploy-Key', ''))) {
            throw AppError::notFound();
        }
        $body = $this->parseBody($req, S::object([
            'email' => S::string()->trim()->toLowerCase()->refine(fn ($v) => filter_var($v, FILTER_VALIDATE_EMAIL) !== false, 'Email non valida.'),
            'name' => S::string()->trim()->min(2, 'Indica il nome.')->max(120),
        ]));

        return DB::transaction(function () use ($body) {
            if (DB::table('users')->where('is_platform_admin', 1)->lockForUpdate()->exists()) {
                throw AppError::conflict('already_initialized', 'Esiste già un amministratore di piattaforma: usa il recupero password.');
            }
            if (DB::table('users')->where('email', $body['email'])->exists()) {
                throw AppError::conflict('email_in_use', 'Esiste già un utente con questa email.');
            }
            $uid = (string) Str::uuid();
            DB::table('users')->insert(['id' => $uid, 'email' => $body['email'], 'name' => $body['name'], 'password_hash' => null, 'is_platform_admin' => 1, 'created_at' => Clock::now()]);
            $token = Crypto::newToken();
            DB::table('password_resets')->insert(['token_hash' => Crypto::hashToken($token), 'user_id' => $uid, 'expires_at' => Clock::plusSeconds(3600), 'created_at' => Clock::now()]);
            Audit::log(null, $uid, 'user', $uid, 'platform_admin_bootstrap');

            return ['ok' => true, 'setPasswordLink' => config('foodcost.app_url')."/reimposta-password?token={$token}", 'expiresInMinutes' => 60];
        });
    }
}
