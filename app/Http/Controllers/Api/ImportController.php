<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Auth\AuthContext;
use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Imports\Fields;
use App\Services\Imports\Reader;
use App\Services\Imports\Validator;
use App\Services\Jobs;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\RateLimit;
use App\Support\Row;
use App\Support\Validation\S;
use App\Support\Validation\Schema;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use OpenSpout\Common\Entity\Row as XRow;
use OpenSpout\Common\Entity\Style\Style;
use OpenSpout\Writer\XLSX\Writer as XlsxWriter;

/**
 * Importazioni CSV/XLSX (port di apps/api/src/routes/imports.ts).
 * Hosting condiviso: la validazione e l'applicazione avanzano dopo la risposta, durante il polling dell'interfaccia
 * e con il cron, senza worker permanente (vedi App\Services\Jobs).
 */
final class ImportController extends Controller
{
    private static function optionsSchema(): Schema
    {
        return S::object([
            'sheet' => S::string()->max(120)->nullable()->optional(),
            'delimiter' => S::enum([';', ',', "\t"])->optional(),
            'encoding' => S::enum(['utf8', 'latin1'])->optional(),
            'headerRow' => S::coerceInt(1, 50)->default(1),
            'numberFormat' => S::enum(['it', 'en', 'auto'])->default('it'),
            'onExisting' => S::enum(['update', 'skip'])->default('update'),
            'onNew' => S::enum(['create', 'skip'])->default('create'),
            'generateCodes' => S::bool()->default(true),
        ]);
    }

    /** Neutralizza le celle che un foglio di calcolo interpreterebbe come formule (CSV/formula injection). */
    public static function safeCsvCell(mixed $v): string
    {
        $s = $v === null ? '' : (is_bool($v) ? ($v ? 'true' : 'false') : (string) $v);
        if (preg_match('/^[=+\-@\t\r]/', $s)) {
            $s = "'{$s}";
        }

        return preg_match('/[;"\n\r]/', $s) ? '"'.str_replace('"', '""', $s).'"' : $s;
    }

    /** Permessi richiesti: le importazioni dipendenti scrivono dati retributivi. */
    private function ctxFor(Request $req, string $type): AuthContext
    {
        $ctx = $this->requireCompany($req, 'imports.manage');
        if ($type === 'ingredients' && ! $ctx->can('ingredients.manage')) {
            throw AppError::forbidden();
        }
        if ($type === 'employees' && (! $ctx->can('employees.manage') || ! $ctx->can('salaries.read'))) {
            throw AppError::forbidden('Per importare i dipendenti servono la gestione dipendenti e la lettura delle retribuzioni.');
        }

        return $ctx;
    }

    private function loadImport(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'imports.manage');
        $id = $this->uuid($id);
        $imp = DB::table('imports')->where('id', $id)->where('company_id', $ctx->companyId())->first();
        if (! $imp) {
            throw AppError::notFound('Importazione');
        }
        $this->ctxFor($req, $imp->type);

        return [$ctx, $imp];
    }

    private static function path(string $rel): string
    {
        return storage_path('app/'.$rel);
    }

    private function previewFile(string $path, string $kind, array $opts, string $type): array
    {
        $sheets = $kind === 'xlsx' ? Reader::listSheets($path) : [];
        $delimiter = $opts['delimiter'] ?? null;
        $encoding = $opts['encoding'] ?? null;
        if ($kind === 'csv') {
            $sample = (string) file_get_contents($path, false, null, 0, 64 * 1024);
            $encoding ??= Reader::detectEncoding($sample);
            $text = $encoding === 'latin1' ? mb_convert_encoding($sample, 'UTF-8', 'Windows-1252') : $sample;
            $delimiter ??= Reader::detectDelimiter($text);
        }
        $headerRow = $opts['headerRow'] ?? 1;
        $rows = [];
        foreach (Reader::rows($path, $kind, ['sheet' => $opts['sheet'] ?? null, 'delimiter' => $delimiter, 'encoding' => $encoding]) as $r) {
            $rows[] = array_map([Reader::class, 'cellText'], $r['cells']);
            if (count($rows) >= $headerRow + 8) {
                break;
            }
        }
        $headers = array_map(fn ($h, $i) => $h !== '' ? $h : 'Colonna '.($i + 1), $rows[$headerRow - 1] ?? [], array_keys($rows[$headerRow - 1] ?? []));

        return [
            'sheets' => $sheets,
            'detected' => ['delimiter' => $delimiter, 'encoding' => $encoding, 'sheet' => $opts['sheet'] ?? ($sheets[0] ?? null), 'headerRow' => $headerRow],
            'headers' => $headers,
            'sample' => array_slice($rows, $headerRow, 8),
            'firstRows' => array_slice($rows, 0, min(count($rows), $headerRow + 2)),
            'suggestedMapping' => Fields::suggestMapping($type, $headers),
        ];
    }

    public function fields(Request $req, string $type): array
    {
        $type = $this->parse(S::object(['type' => S::enum(['ingredients', 'employees'])]), ['type' => $type])['type'];
        $this->ctxFor($req, $type);

        return ['data' => Fields::for($type), 'limits' => ['maxBytes' => config('foodcost.import_max_bytes'), 'maxRows' => config('foodcost.import_max_rows'), 'retentionDays' => config('foodcost.import_retention_days')]];
    }

    /** Modello scaricabile con colonne, esempio e spiegazioni (foglio "Istruzioni"). */
    public function template(Request $req, string $file)
    {
        $this->parse(S::object(['file' => S::string()->regex('/^(ingredients|employees)\.(csv|xlsx)$/', 'Invalid string: must match pattern /^(ingredients|employees)\.(csv|xlsx)$/')]), ['file' => $file]);
        [$type, $ext] = explode('.', $file);
        $this->ctxFor($req, $type);
        $fields = Fields::for($type);
        $name = $type === 'ingredients' ? 'modello-ingredienti' : 'modello-dipendenti';
        if ($ext === 'csv') {
            $lines = [implode(';', array_column($fields, 'label')), implode(';', array_map(fn ($f) => self::safeCsvCell($f['example']), $fields))];

            return response("\u{FEFF}".implode("\r\n", $lines)."\r\n", 200, [
                'Content-Type' => 'text/csv; charset=utf-8',
                'Content-Disposition' => "attachment; filename=\"{$name}.csv\"",
            ]);
        }
        $tmp = tempnam(sys_get_temp_dir(), 'fc').'.xlsx';
        $w = new XlsxWriter;
        $w->openToFile($tmp);
        $bold = (new Style)->setFontBold();
        $w->getCurrentSheet()->setName('Dati');
        $w->addRow(XRow::fromValues(array_column($fields, 'label'), $bold));
        $w->addRow(XRow::fromValues(array_column($fields, 'example')));
        $w->addNewSheetAndMakeItCurrent()->setName('Istruzioni');
        $w->addRow(XRow::fromValues(['Colonna', 'Obbligatoria', 'Descrizione', 'Esempio'], $bold));
        foreach ($fields as $f) {
            $w->addRow(XRow::fromValues([$f['label'], $f['required'] ? 'sì' : 'no', $f['help'], $f['example']]));
        }
        $w->addRow(XRow::fromValues([]));
        $w->addRow(XRow::fromValues(['Note', '', 'Importi netti IVA. Numeri con la virgola decimale (1.234,56). Date gg/mm/aaaa. Inserire valori, non formule. Il codice è la chiave di abbinamento: il nome non basta per aggiornare.']));
        $w->close();
        $bytes = file_get_contents($tmp);
        @unlink($tmp);

        return response($bytes, 200, [
            'Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition' => "attachment; filename=\"{$name}.xlsx\"",
        ]);
    }

    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'imports.manage');
        Jobs::maybeScheduleCleanup();
        $rows = DB::table('imports as i')->leftJoin('users as u', 'u.id', '=', 'i.created_by')
            ->where('i.company_id', $ctx->companyId())->orderByDesc('i.created_at')->limit(50)
            ->get(['i.id', 'i.type', 'i.status', 'i.original_name', 'i.file_kind', 'i.total_rows', 'i.summary', 'i.created_at', 'i.applied_at', 'i.error', 'u.name as created_by']);

        return ['data' => array_values(array_filter(Row::all($rows, [], ['summary']), fn ($r) => $r['type'] === 'ingredients' || $ctx->can('salaries.read')))];
    }

    /** Caricamento in storage privato (fuori dalla cartella pubblica), con limiti di dimensione e tipo. */
    public function upload(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'imports.manage');
        RateLimit::hit('upload', (string) $req->ip(), 30, 600);
        $file = $req->file('file') ?? (array_values($req->allFiles())[0] ?? null);
        if (! $file) {
            throw AppError::badRequest('no_file', 'Nessun file caricato.');
        }
        $type = $this->parse(S::enum(['ingredients', 'employees']), $req->request->get('type') ?? S::missing());
        $this->ctxFor($req, $type);
        $original = $file->getClientOriginalName();
        $lower = mb_strtolower($original);
        $kind = str_ends_with($lower, '.xlsx') ? 'xlsx' : (str_ends_with($lower, '.csv') ? 'csv' : null);
        if (! $kind) {
            throw AppError::badRequest('unsupported_type', str_ends_with($lower, '.xls') ? 'Il formato .xls non è supportato: salva il file come .xlsx o .csv.' : 'Formato non supportato: usa .xlsx o .csv.');
        }
        $max = config('foodcost.import_max_bytes');
        if (! $file->isValid() || $file->getSize() > $max) {
            throw AppError::badRequest('file_too_large', 'File troppo grande (massimo '.round($max / 1048576).' MB).');
        }
        $id = (string) Str::uuid();
        $dir = 'imports/'.$ctx->companyId();
        if (! is_dir(self::path($dir))) {
            mkdir(self::path($dir), 0700, true);
        }
        $rel = "{$dir}/{$id}.{$kind}";
        $abs = self::path($rel);
        $file->move(dirname($abs), basename($abs));
        @chmod($abs, 0600);
        $size = filesize($abs);
        // controllo del contenuto reale: un .xlsx è un archivio ZIP, un CSV non contiene byte nulli
        $head = (string) file_get_contents($abs, false, null, 0, 4096);
        $ok = $kind === 'xlsx' ? str_starts_with($head, "PK\x03\x04") : ! str_contains($head, "\0");
        if (! $ok || $size === 0) {
            @unlink($abs);
            throw AppError::badRequest('invalid_file', 'Il contenuto del file non corrisponde al formato indicato.');
        }
        try {
            $preview = $this->previewFile($abs, $kind, [], $type);
        } catch (\Throwable) {
            @unlink($abs);
            throw AppError::badRequest('unreadable', 'Il file non può essere letto: verifica che non sia protetto da password o danneggiato.');
        }
        $options = [...Validator::DEFAULT_OPTIONS, 'sheet' => $preview['detected']['sheet']];
        if ($preview['detected']['delimiter'] !== null) {
            $options['delimiter'] = $preview['detected']['delimiter'];
        }
        if ($preview['detected']['encoding'] !== null) {
            $options['encoding'] = $preview['detected']['encoding'];
        }
        DB::table('imports')->insert([
            'id' => $id,
            'company_id' => $ctx->companyId(),
            'type' => $type,
            'original_name' => mb_substr($original, 0, 200),
            'storage_path' => $rel,
            'file_size' => $size,
            'file_kind' => $kind,
            'options' => json_encode($options),
            'mapping' => json_encode((object) $preview['suggestedMapping'], JSON_UNESCAPED_UNICODE),
            'created_by' => $ctx->userId(),
            'created_at' => Clock::now(),
        ]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'import', $id, 'uploaded', ['type' => $type, 'file' => $original, 'size' => $size]);

        return ['id' => $id, 'options' => $options, ...$preview];
    }

    public function show(Request $req, string $id): array
    {
        [, $imp] = $this->loadImport($req, $id);
        // senza worker: la richiesta di avanzamento fa procedere il lavoro in attesa
        if (in_array($imp->status, ['validating', 'applying'], true)) {
            Jobs::runPending($imp->id, (float) config('foodcost.job_slice_seconds') * 5);
            $imp = DB::table('imports')->where('id', $imp->id)->first();
        }

        return [
            'id' => $imp->id,
            'type' => $imp->type,
            'status' => $imp->status,
            'originalName' => $imp->original_name,
            'fileKind' => $imp->file_kind,
            'fileSize' => (int) $imp->file_size,
            'options' => json_decode($imp->options, true) ?: new \stdClass,
            'mapping' => $imp->mapping !== null ? (json_decode($imp->mapping) ?: new \stdClass) : null,
            'summary' => $imp->summary !== null ? json_decode($imp->summary, true) : null,
            'progress' => (int) $imp->progress,
            'totalRows' => $imp->total_rows !== null ? (int) $imp->total_rows : null,
            'error' => $imp->error,
            'createdAt' => Clock::iso($imp->created_at),
            'validatedAt' => Clock::iso($imp->validated_at),
            'appliedAt' => Clock::iso($imp->applied_at),
            'lockVersion' => (int) $imp->lock_version,
            'fileAvailable' => $imp->storage_path !== '',
            'fields' => Fields::for($imp->type),
        ];
    }

    /** Anteprima del file con opzioni diverse (foglio, separatore, codifica, riga di intestazione). */
    public function preview(Request $req, string $id): array
    {
        [, $imp] = $this->loadImport($req, $id);
        if ($imp->storage_path === '') {
            throw AppError::conflict('expired', 'Il file non è più disponibile (periodo di conservazione scaduto).');
        }
        $opts = $this->parseBody($req, self::optionsSchema());

        return $this->previewFile(self::path($imp->storage_path), $imp->file_kind, $opts, $imp->type);
    }

    /** Salva opzioni e abbinamento colonne e avvia la validazione completa. */
    public function validateImport(Request $req, string $id)
    {
        [$ctx, $imp] = $this->loadImport($req, $id);
        if (in_array($imp->status, ['applying', 'applied'], true)) {
            throw AppError::conflict('locked', 'L’importazione è già stata applicata o è in corso.');
        }
        if ($imp->storage_path === '') {
            throw AppError::conflict('expired', 'Il file non è più disponibile.');
        }
        $body = $this->parseBody($req, S::object([
            'options' => self::optionsSchema(),
            'mapping' => S::any()->refine(fn ($m) => is_array($m) && array_reduce(array_values($m), fn ($ok, $v) => $ok && ($v === null || is_string($v)), true), 'Invalid input: expected record'),
        ]));
        // le opzioni non indicate (es. codifica e separatore rilevati al caricamento) restano quelle salvate
        $options = [...(json_decode($imp->options, true) ?: []), ...$body['options']];
        $allowed = array_column(Fields::for($imp->type), 'key');
        $mapping = array_filter($body['mapping'], fn ($k) => in_array($k, $allowed, true), ARRAY_FILTER_USE_KEY);
        $used = array_values(array_filter($mapping));
        if (count(array_unique($used)) !== count($used)) {
            throw AppError::badRequest('validation_failed', 'La stessa colonna è abbinata a più campi.');
        }
        DB::table('imports')->where('id', $imp->id)->update([
            'options' => json_encode($options),
            'mapping' => json_encode((object) $mapping, JSON_UNESCAPED_UNICODE),
            'status' => 'validating', 'progress' => 0, 'summary' => null, 'error' => null, 'validated_at' => null,
            'lock_version' => DB::raw('lock_version + 1'),
        ]);
        Jobs::enqueue('import.validate', ['importId' => $imp->id], "validate:{$imp->id}:".($imp->lock_version + 1));
        Audit::log($ctx->companyId(), $ctx->userId(), 'import', $imp->id, 'validation_requested');
        self::runAfterResponse($imp->id);

        return ['ok' => true, 'status' => 'validating'];
    }

    /** Righe validate con valori normalizzati, filtrabili per esito. */
    public function rows(Request $req, string $id): array
    {
        [, $imp] = $this->loadImport($req, $id);
        $q = $this->parseQuery($req, S::object([
            'action' => S::enum(['all', 'create', 'update', 'skip', 'error', 'warning'])->default('all'),
            'page' => S::coerceInt(1)->default(1),
            'pageSize' => S::coerceInt(1, 200)->default(50),
        ]));
        $query = DB::table('import_rows')->where('import_id', $imp->id);
        if ($q['action'] === 'warning') {
            $query->whereNotNull('warnings');
        } elseif ($q['action'] !== 'all') {
            $query->where('action', $q['action']);
        }
        $total = (clone $query)->count();
        $rows = $query->orderBy('row_number')->limit($q['pageSize'])->offset(($q['page'] - 1) * $q['pageSize'])
            ->get(['row_number', 'raw', 'normalized', 'action', 'errors', 'warnings']);

        return [
            'data' => $rows->map(fn ($r) => [
                'row_number' => (int) $r->row_number,
                'raw' => json_decode($r->raw) ?: new \stdClass,
                'normalized' => $r->normalized !== null ? json_decode($r->normalized) : null,
                'action' => $r->action,
                'errors' => $r->errors !== null ? json_decode($r->errors, true) : null,
                'warnings' => $r->warnings !== null ? json_decode($r->warnings, true) : null,
            ])->all(),
            'meta' => ['page' => $q['page'], 'pageSize' => $q['pageSize'], 'total' => $rows->isEmpty() ? 0 : $total],
        ];
    }

    /** Conferma esplicita: una seconda conferma non produce effetti duplicati. */
    public function confirm(Request $req, string $id): array
    {
        [$ctx, $imp] = $this->loadImport($req, $id);
        $body = $this->parseBody($req, S::object(['lockVersion' => S::int()]));
        if ($imp->status === 'applying' || $imp->status === 'applied') {
            return ['ok' => true, 'status' => $imp->status, 'alreadyConfirmed' => true];
        }
        if ($imp->status !== 'validated') {
            throw AppError::conflict('not_validated', 'Valida il file prima di confermare.');
        }
        if ((int) $imp->lock_version !== $body['lockVersion']) {
            throw AppError::conflict('stale', 'Le opzioni dell’importazione sono cambiate: rivedi il riepilogo prima di confermare.');
        }
        $summary = $imp->summary ? json_decode($imp->summary, true) : [];
        if (($summary['error'] ?? 0) > 0) {
            throw AppError::conflict('has_errors', 'Ci sono righe con errori: correggi il file e caricalo di nuovo. In modalità atomica nessuna riga viene applicata.');
        }
        $n = DB::table('imports')->where('id', $imp->id)->where('status', 'validated')->where('lock_version', $body['lockVersion'])
            ->update(['status' => 'applying', 'confirmed_at' => Clock::now()]);
        if (! $n) {
            return ['ok' => true, 'status' => 'applying', 'alreadyConfirmed' => true];
        }
        Jobs::enqueue('import.apply', ['importId' => $imp->id], "apply:{$imp->id}:{$body['lockVersion']}");
        Audit::log($ctx->companyId(), $ctx->userId(), 'import', $imp->id, 'confirmed');
        self::runAfterResponse($imp->id);

        return ['ok' => true, 'status' => 'applying'];
    }

    public function cancel(Request $req, string $id): array
    {
        [$ctx, $imp] = $this->loadImport($req, $id);
        if (in_array($imp->status, ['applying', 'applied'], true)) {
            throw AppError::conflict('locked', 'Un’importazione applicata o in corso non può essere annullata.');
        }
        DB::table('imports')->where('id', $imp->id)->update(['status' => 'cancelled']);
        if ($imp->storage_path !== '') {
            @unlink(self::path($imp->storage_path));
        }
        DB::table('imports')->where('id', $imp->id)->update(['storage_path' => '']);
        DB::table('import_rows')->where('import_id', $imp->id)->delete();
        Audit::log($ctx->companyId(), $ctx->userId(), 'import', $imp->id, 'cancelled');

        return ['ok' => true];
    }

    /** Report scaricabile delle righe (errori e avvisi), protetto da formula injection. */
    public function report(Request $req, string $id)
    {
        [, $imp] = $this->loadImport($req, $id);
        $q = $this->parseQuery($req, S::object(['only' => S::enum(['errors', 'all'])->default('errors')]));
        $label = ['create' => 'Nuovo', 'update' => 'Aggiornamento', 'skip' => 'Ignorata', 'error' => 'Errore'];
        $summary = $imp->summary ? json_decode($imp->summary, true) : null;
        $headers = $summary['headers'] ?? null;
        $lines = [];
        $offset = 0;
        for (;;) {
            $query = DB::table('import_rows')->where('import_id', $imp->id);
            if ($q['only'] === 'errors') {
                $query->where(fn ($w) => $w->where('action', 'error')->orWhereNotNull('warnings'));
            }
            $rows = $query->orderBy('row_number')->limit(1000)->offset($offset)->get(['row_number', 'raw', 'action', 'errors', 'warnings']);
            if ($rows->isEmpty()) {
                break;
            }
            $offset += $rows->count();
            foreach ($rows as $r) {
                $raw = json_decode($r->raw, true) ?: [];
                $headers ??= array_keys($raw);
                $cells = [$r->row_number, $label[$r->action ?? ''] ?? '', implode(' | ', $r->errors ? json_decode($r->errors, true) : []), implode(' | ', $r->warnings ? json_decode($r->warnings, true) : [])];
                foreach ($headers as $h) {
                    $cells[] = $raw[$h] ?? null;
                }
                $lines[] = implode(';', array_map([self::class, 'safeCsvCell'], $cells));
            }
        }
        $head = implode(';', array_map([self::class, 'safeCsvCell'], ['Riga', 'Esito', 'Errori', 'Avvisi', ...($headers ?? [])]));

        return response("\u{FEFF}".implode("\r\n", [$head, ...$lines])."\r\n", 200, [
            'Content-Type' => 'text/csv; charset=utf-8',
            'Content-Disposition' => 'attachment; filename="report-importazione-'.substr($imp->id, 0, 8).'.csv"',
        ]);
    }

    /** Esegue il lavoro appena accodato dopo aver inviato la risposta (PHP-FPM), senza far attendere l'utente. */
    private static function runAfterResponse(string $importId): void
    {
        if (app()->runningUnitTests()) {
            return;
        }
        app()->terminating(function () use ($importId) {
            if (function_exists('fastcgi_finish_request')) {
                @ignore_user_abort(true);
                Jobs::runPending($importId, 120);
            }
        });
    }
}
