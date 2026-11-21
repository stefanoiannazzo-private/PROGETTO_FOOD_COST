<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Jobs;
use App\Support\AppError;
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
}
