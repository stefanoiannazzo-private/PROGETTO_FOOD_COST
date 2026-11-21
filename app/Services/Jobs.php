<?php

declare(strict_types=1);

namespace App\Services;

use App\Services\Imports\Applier;
use App\Services\Imports\ApplyError;
use App\Services\Imports\ImportError;
use App\Services\Imports\Validator;
use App\Support\Clock;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Coda di lavoro su database (port di services/jobs.ts) adattata all'hosting condiviso: non c'è un worker
 * sempre acceso. I lavori vengono eseguiti:
 *  - subito dopo la risposta che li accoda (quando il server lo consente);
 *  - dalle richieste di avanzamento che l'interfaccia invia mentre attende (polling ogni 700 ms);
 *  - dal cron dell'hosting (/api/cron?k=...), come riserva.
 * Un lavoro con la stessa chiave non viene accodato due volte; la presa in carico è atomica.
 */
final class Jobs
{
    public static function enqueue(string $type, array $payload, ?string $dedupeKey = null): bool
    {
        return DB::table('jobs')->insertOrIgnore([
            'type' => $type,
            'payload' => json_encode($payload),
            'dedupe_key' => $dedupeKey,
            'run_at' => Clock::now(),
            'created_at' => Clock::now(),
        ]) > 0;
    }

    /** Esegue i lavori disponibili (facoltativamente solo quelli di un'importazione) entro il tempo indicato. */
    public static function runPending(?string $importId = null, float $budgetSeconds = 20): int
    {
        $start = microtime(true);
        $done = 0;
        while (microtime(true) - $start < $budgetSeconds) {
            $job = self::claim($importId);
            if (! $job) {
                break;
            }
            self::execute($job);
            $done++;
        }

        return $done;
    }

    /** Presa in carico atomica: un solo processo esegue ciascun lavoro (anche con più richieste in parallelo). */
    private static function claim(?string $importId): ?object
    {
        $q = DB::table('jobs')
            ->where(function ($w) {
                $w->where(fn ($a) => $a->where('status', 'queued')->where('run_at', '<=', Clock::now()))
                    ->orWhere(fn ($b) => $b->where('status', 'running')->where('locked_at', '<', Clock::plusSeconds(-600)));
            })
            ->orderBy('run_at')->orderBy('id');
        if ($importId) {
            $q->where('payload', 'like', '%"importId":"'.$importId.'"%');
        }
        foreach ($q->limit(5)->get(['id']) as $candidate) {
            $n = DB::table('jobs')->where('id', $candidate->id)
                ->where(function ($w) {
                    $w->where(fn ($a) => $a->where('status', 'queued')->where('run_at', '<=', Clock::now()))
                        ->orWhere(fn ($b) => $b->where('status', 'running')->where('locked_at', '<', Clock::plusSeconds(-600)));
                })
                ->update(['status' => 'running', 'locked_at' => Clock::now(), 'attempts' => DB::raw('attempts + 1')]);
            if ($n === 1) {
                return DB::table('jobs')->where('id', $candidate->id)->first();
            }
        }

        return null;
    }

    private static function execute(object $job): void
    {
        @set_time_limit(300);
        try {
            self::handle($job->type, json_decode($job->payload, true) ?: []);
            DB::table('jobs')->where('id', $job->id)->update(['status' => 'done', 'error' => null]);
        } catch (\Throwable $e) {
            $retry = ! ($e instanceof ImportError || $e instanceof ApplyError) && $job->attempts < 3;
            DB::table('jobs')->where('id', $job->id)->update([
                'status' => $retry ? 'queued' : 'failed',
                'error' => mb_substr($e->getMessage(), 0, 2000),
                'run_at' => Clock::plusSeconds(5 * (int) $job->attempts),
            ]);
            if (! ($e instanceof ImportError || $e instanceof ApplyError)) {
                Log::error('lavoro non riuscito', ['job' => $job->id, 'type' => $job->type, 'err' => $e->getMessage()]);
            }
        }
    }

    private static function handle(string $type, array $payload): void
    {
        $importId = $payload['importId'] ?? null;
        if ($type === 'import.validate') {
            DB::table('imports')->where('id', $importId)->update(['status' => 'validating', 'progress' => 0, 'error' => null, 'summary' => null]);
            try {
                $summary = Validator::run($importId, config('foodcost.import_max_rows'), function (int $n) use ($importId) {
                    DB::table('imports')->where('id', $importId)->update(['progress' => $n]);
                });
                DB::table('imports')->where('id', $importId)->update([
                    'status' => 'validated', 'summary' => json_encode($summary, JSON_UNESCAPED_UNICODE), 'total_rows' => $summary['totalRows'],
                    'progress' => $summary['totalRows'], 'validated_at' => Clock::now(), 'lock_version' => DB::raw('lock_version + 1'),
                ]);
            } catch (\Throwable $e) {
                $known = $e instanceof ImportError;
                DB::table('imports')->where('id', $importId)->update([
                    'status' => 'failed',
                    'error' => $known ? $e->getMessage() : 'Il file non può essere letto: verifica formato, foglio e separatore.',
                ]);
                throw $e;
            }
        } elseif ($type === 'import.apply') {
            try {
                Applier::run($importId);
            } catch (ApplyError $e) {
                DB::table('imports')->where('id', $importId)->where('status', 'applying')->update(['status' => 'failed', 'error' => $e->getMessage()]);
                throw $e;
            }
        } elseif ($type === 'imports.cleanup') {
            self::cleanupImports();
        }
    }

    /** Conservazione: file e righe di staging eliminati dopo IMPORT_RETENTION_DAYS; resta il riepilogo. */
    public static function cleanupImports(): int
    {
        $limit = Clock::plusSeconds(-config('foodcost.import_retention_days') * 86400);
        $old = DB::table('imports')->where('created_at', '<', $limit)->where('storage_path', '<>', '')->get(['id', 'storage_path']);
        foreach ($old as $o) {
            @unlink(storage_path('app/'.$o->storage_path));
            DB::table('import_rows')->where('import_id', $o->id)->delete();
            DB::table('imports')->where('id', $o->id)->update(['storage_path' => '']);
        }

        return $old->count();
    }

    /** Pulizia periodica senza cron: al massimo una volta ogni 6 ore, accodata durante le richieste. */
    public static function maybeScheduleCleanup(): void
    {
        self::enqueue('imports.cleanup', [], 'cleanup:'.gmdate('Y-m-d').':'.intdiv((int) gmdate('G'), 6));
    }
}
