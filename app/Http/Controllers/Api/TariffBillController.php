<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Dec;
use App\Http\Controllers\Controller;
use App\Services\BillReader;
use App\Support\AppError;
use App\Services\Audit;
use App\Support\Clock;
use App\Support\RateLimit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * NUOVO — Bollette delle utenze: caricamento (PDF o foto), lettura automatica dei dati, archivio scaricabile.
 * La lettura precompila il modulo "Calcola da una bolletta": il valore della tariffa nasce solo quando
 * il ristoratore conferma (POST /tariffs/{id}/versions con billFileId).
 */
class TariffBillController extends Controller
{
    private const TYPES = [
        'application/pdf' => 'pdf',
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp',
    ];

    public function index(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.read');
        $id = $this->uuid($id);
        $this->tariff($ctx->companyId(), $id);
        $rows = DB::table('tariff_bills as b')
            ->leftJoin('users as u', 'u.id', '=', 'b.created_by')
            ->leftJoin('tariff_versions as v', 'v.id', '=', 'b.version_id')
            ->where('b.company_id', $ctx->companyId())->where('b.tariff_id', $id)
            ->orderByDesc('b.period_to')->orderByDesc('b.created_at')
            ->get(['b.id', 'b.original_name', 'b.mime', 'b.file_size', 'b.supplier', 'b.period_from', 'b.period_to', 'b.total_amount', 'b.extraction_status', 'b.version_id', 'v.valid_from as version_valid_from', 'v.price_per_unit as version_price', 'b.created_at', 'u.name as created_by']);

        return [
            'data' => $rows->map(fn ($r) => [
                'id' => $r->id,
                'fileName' => $r->original_name,
                'mime' => $r->mime,
                'size' => (int) $r->file_size,
                'supplier' => $r->supplier,
                'periodFrom' => $r->period_from,
                'periodTo' => $r->period_to,
                'totalAmount' => $r->total_amount,
                'readStatus' => $r->extraction_status,
                'version' => $r->version_id ? ['id' => $r->version_id, 'validFrom' => $r->version_valid_from, 'pricePerUnit' => $r->version_price] : null,
                'createdAt' => Clock::iso($r->created_at),
                'createdBy' => $r->created_by,
            ])->all(),
            'meta' => ['aiEnabled' => BillReader::configured()],
        ];
    }

    public function upload(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.manage');
        $id = $this->uuid($id);
        $cid = $ctx->companyId();
        $t = $this->tariff($cid, $id);
        RateLimit::hit('bill-upload', (string) $req->ip(), 20, 600);

        $file = $req->file('file') ?? (array_values($req->allFiles())[0] ?? null);
        if (! $file) {
            throw AppError::badRequest('no_file', 'Nessun file caricato.');
        }
        $max = (int) config('foodcost.bill_max_bytes');
        if (! $file->isValid() || $file->getSize() > $max) {
            throw AppError::badRequest('file_too_large', 'File troppo grande (massimo '.round($max / 1048576).' MB).');
        }
        $bytes = (string) file_get_contents($file->getRealPath());
        $mime = self::sniff($bytes);
        if (! $mime) {
            $lower = mb_strtolower($file->getClientOriginalName());
            throw AppError::badRequest('unsupported_type', str_ends_with($lower, '.heic') || str_ends_with($lower, '.heif')
                ? 'Le foto HEIC dell’iPhone non sono supportate: scattala in JPG (Impostazioni → Fotocamera → Formati → Più compatibile) o carica il PDF.'
                : 'Formato non supportato: carica la bolletta in PDF oppure una foto JPG o PNG.');
        }
        $sha = hash('sha256', $bytes);
        $dup = DB::table('tariff_bills')->where('company_id', $cid)->where('tariff_id', $id)->where('sha256', $sha)->first(['created_at']);

        $billId = (string) Str::uuid();
        $rel = "bills/{$cid}/{$billId}.".self::TYPES[$mime];
        $abs = storage_path('app/'.$rel);
        if (! is_dir(dirname($abs))) {
            mkdir(dirname($abs), 0700, true);
        }
        file_put_contents($abs, $bytes);
        @chmod($abs, 0600);

        // lettura automatica (sincrona: la risposta arriva in 10-40 secondi)
        $status = 'off';
        $error = null;
        $result = null;
        $raw = null;
        if (BillReader::configured()) {
            $used = DB::table('tariff_bills')->where('company_id', $cid)->whereIn('extraction_status', ['ok', 'failed'])
                ->where('created_at', '>=', substr(Clock::now(), 0, 7).'-01 00:00:00.000')->count();
            if ($used >= (int) config('foodcost.bill_ai.monthly_limit')) {
                $status = 'limit';
                $error = 'Raggiunto il limite mensile di letture automatiche: compila i dati a mano.';
            } else {
                @set_time_limit(150);
                try {
                    [$payload, $payloadMime] = self::forReading($bytes, $mime);
                    $raw = BillReader::read($payload, $payloadMime);
                    $result = BillReader::normalize($raw, $t->kind, $t->unit);
                    $status = 'ok';
                } catch (\Throwable $e) {
                    $status = 'failed';
                    $error = $e instanceof \RuntimeException ? $e->getMessage() : 'Lettura non riuscita.';
                    Log::warning('lettura bolletta non riuscita', ['err' => $e->getMessage()]);
                }
            }
        }

        DB::table('tariff_bills')->insert([
            'id' => $billId,
            'company_id' => $cid,
            'tariff_id' => $id,
            'original_name' => mb_substr($file->getClientOriginalName() ?: 'bolletta', 0, 200),
            'storage_path' => $rel,
            'mime' => $mime,
            'file_size' => strlen($bytes),
            'sha256' => $sha,
            'supplier' => $result['info']['supplier'] ?? null,
            'period_from' => $result['form']['periodFrom'] ?? null,
            'period_to' => $result['form']['periodTo'] ?? null,
            'total_amount' => isset($result['info']['totalAmount']) ? Dec::of($result['info']['totalAmount'])->toDecimalPlaces(2)->toFixed(2) : null,
            'extraction_status' => $status,
            'extraction_error' => $error ? mb_substr($error, 0, 500) : null,
            'extracted' => $raw ? json_encode($raw, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
            'created_by' => $ctx->userId(),
            'created_at' => Clock::now(),
        ]);
        Audit::log($cid, $ctx->userId(), 'tariff_bill', $billId, 'uploaded', ['tariffId' => $id, 'read' => $status]);

        $warnings = $result['warnings'] ?? [];
        if ($dup) {
            array_unshift($warnings, 'Questa bolletta era già stata caricata in questa utenza.');
        }

        return [
            'id' => $billId,
            'readStatus' => $status,
            'message' => match ($status) {
                'ok' => 'Dati letti dalla bolletta: controllali e conferma.',
                'off' => 'Bolletta archiviata. La lettura automatica non è attiva: compila i dati a mano.',
                default => $error.' La bolletta è comunque archiviata.',
            },
            'form' => $result['form'] ?? null,
            'info' => $result['info'] ?? null,
            'warnings' => $warnings,
        ];
    }

    public function file(Request $req, string $id, string $billId): Response
    {
        $ctx = $this->requireCompany($req, 'tariffs.read');
        [$id, $billId] = $this->uuids(['id' => $id, 'billId' => $billId]);
        $b = $this->bill($ctx->companyId(), $id, $billId);
        $abs = storage_path('app/'.$b->storage_path);
        if (! is_file($abs)) {
            throw AppError::notFound('File della bolletta');
        }
        $name = preg_replace('/[^\w.\- ]+/u', '_', $b->original_name) ?: 'bolletta';
        $disposition = $req->query('download') ? 'attachment' : 'inline';

        return response((string) file_get_contents($abs), 200, [
            'Content-Type' => $b->mime,
            'Content-Disposition' => $disposition.'; filename="'.addcslashes($name, '"\\').'"; filename*=UTF-8\'\''.rawurlencode($b->original_name),
            'X-Content-Type-Options' => 'nosniff',
            'Content-Security-Policy' => "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
            'Cache-Control' => 'private, no-store',
        ]);
    }

    public function destroy(Request $req, string $id, string $billId): array
    {
        $ctx = $this->requireCompany($req, 'tariffs.manage');
        [$id, $billId] = $this->uuids(['id' => $id, 'billId' => $billId]);
        $b = $this->bill($ctx->companyId(), $id, $billId);
        DB::table('tariff_bills')->where('id', $billId)->delete();
        @unlink(storage_path('app/'.$b->storage_path));
        Audit::log($ctx->companyId(), $ctx->userId(), 'tariff_bill', $billId, 'deleted', ['file' => $b->original_name]);

        return ['ok' => true];
    }

    /** Collega la bolletta al valore della tariffa appena creato (chiamato da TariffController::addVersion). */
    public static function attach(string $companyId, string $tariffId, string $billId, string $versionId): void
    {
        $n = DB::table('tariff_bills')->where('id', $billId)->where('company_id', $companyId)->where('tariff_id', $tariffId)->update(['version_id' => $versionId]);
        if (! $n) {
            throw AppError::badRequest('validation_failed', 'La bolletta indicata non appartiene a questa utenza.', ['fields' => ['billFileId' => 'Bolletta non trovata.']]);
        }
    }

    private function tariff(string $cid, string $id): object
    {
        $t = DB::table('utility_tariffs')->where('id', $id)->where('company_id', $cid)->first(['id', 'kind', 'unit']);
        if (! $t) {
            throw AppError::notFound('Tariffa');
        }

        return $t;
    }

    private function bill(string $cid, string $tariffId, string $billId): object
    {
        $b = DB::table('tariff_bills')->where('id', $billId)->where('tariff_id', $tariffId)->where('company_id', $cid)->first(['id', 'storage_path', 'mime', 'original_name']);
        if (! $b) {
            throw AppError::notFound('Bolletta');
        }

        return $b;
    }

    /** Tipo reale dal contenuto (non dall'estensione dichiarata). */
    public static function sniff(string $bytes): ?string
    {
        return match (true) {
            str_starts_with($bytes, '%PDF-') => 'application/pdf',
            str_starts_with($bytes, "\xFF\xD8\xFF") => 'image/jpeg',
            str_starts_with($bytes, "\x89PNG\r\n\x1A\n") => 'image/png',
            str_starts_with($bytes, 'RIFF') && substr($bytes, 8, 4) === 'WEBP' => 'image/webp',
            default => null,
        };
    }

    /**
     * Le foto del telefono sono spesso oltre i limiti del servizio (5 MB, lato lungo ampio):
     * si invia una copia ridotta a 2000 px in JPEG; l'archivio conserva sempre l'originale.
     *
     * @return array{0:string,1:string}
     */
    private static function forReading(string $bytes, string $mime): array
    {
        if ($mime === 'application/pdf' || ! function_exists('imagecreatefromstring')) {
            return [$bytes, $mime];
        }
        $size = @getimagesizefromstring($bytes);
        if ($size && max($size[0], $size[1]) <= 2000 && strlen($bytes) <= 3_500_000) {
            return [$bytes, $mime];
        }
        $img = @imagecreatefromstring($bytes);
        if (! $img) {
            return [$bytes, $mime];
        }
        $w = imagesx($img);
        $h = imagesy($img);
        $scale = min(1, 2000 / max($w, $h));
        $out = imagescale($img, max(1, (int) round($w * $scale)), max(1, (int) round($h * $scale)), IMG_BICUBIC);
        ob_start();
        imagejpeg($out ?: $img, null, 85);
        $jpg = (string) ob_get_clean();

        return [$jpg, 'image/jpeg'];
    }
}
