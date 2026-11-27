<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Dec;
use App\Domain\Costing\Units;
use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Codes;
use App\Services\ChangeAlerts;
use App\Services\Costing;
use App\Services\Invoices\FatturaPA;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * NUOVO — Fatture elettroniche dei fornitori caricate a mano nella pagina Importazioni.
 *
 * 1. upload: legge XML/P7M/ZIP e crea una bozza per ogni fattura (le fatture già importate vengono saltate);
 * 2. show: righe della fattura con il suggerimento ricordato per quel fornitore;
 * 3. confirm: per ogni riga "nuovo prodotto" (categoria e modalità obbligatorie), "prodotto esistente" o "ignora";
 *    i prezzi vengono registrati alla data della fattura, al netto di IVA e sconti di riga.
 */
final class SupplierInvoiceController extends Controller
{
    private const PERMS = ['imports.manage', 'ingredients.manage', 'costs.read'];

    private const MAX_FILES = 30;

    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req, ...self::PERMS);
        $rows = DB::table('supplier_invoices as s')->leftJoin('users as u', 'u.id', '=', 's.created_by')
            ->where('s.company_id', $ctx->companyId())
            ->orderByRaw("s.status = 'draft' DESC")->orderByDesc('s.created_at')->limit(200)
            ->get(['s.id', 's.status', 's.supplier_name', 's.number', 's.invoice_date', 's.total_amount', 's.original_name', 's.summary', 's.lines', 's.created_at', 's.applied_at', 'u.name as created_by']);

        return ['data' => $rows->map(fn ($r) => [
            'id' => $r->id,
            'status' => $r->status,
            'supplier' => $r->supplier_name,
            'number' => $r->number,
            'date' => $r->invoice_date,
            'total' => $r->total_amount,
            'fileName' => $r->original_name,
            'lineCount' => count(json_decode((string) $r->lines, true) ?: []),
            'summary' => $r->summary ? json_decode((string) $r->summary, true) : null,
            'createdAt' => Clock::iso($r->created_at),
            'appliedAt' => $r->applied_at ? Clock::iso($r->applied_at) : null,
            'createdBy' => $r->created_by,
        ])->all()];
    }

    public function upload(Request $req): array
    {
        $ctx = $this->requireCompany($req, ...self::PERMS);
        $cid = $ctx->companyId();
        $files = [];
        foreach ($req->allFiles() as $f) {
            array_push($files, ...(is_array($f) ? $f : [$f]));
        }
        if ($files === []) {
            throw AppError::badRequest('file_missing', 'Seleziona almeno un file .xml, .p7m o .zip.');
        }
        if (count($files) > self::MAX_FILES) {
            throw AppError::badRequest('too_many_files', 'Puoi caricare al massimo '.self::MAX_FILES.' file alla volta (oppure un unico .zip).');
        }
        $max = (int) config('foodcost.bill_max_bytes');
        $created = [];
        $duplicates = [];
        $errors = [];
        foreach ($files as $file) {
            $name = mb_substr($file->getClientOriginalName() ?: 'fattura.xml', 0, 200);
            if (! $file->isValid() || $file->getSize() > $max) {
                $errors[] = ['file' => $name, 'message' => 'File troppo grande (massimo '.round($max / 1048576).' MB).'];

                continue;
            }
            foreach (FatturaPA::extract((string) file_get_contents($file->getRealPath()), $name) as $doc) {
                if (isset($doc['error'])) {
                    $errors[] = ['file' => $doc['name'], 'message' => $doc['error']];

                    continue;
                }
                try {
                    $invoices = FatturaPA::parse($doc['xml']);
                } catch (AppError $e) {
                    $errors[] = ['file' => $doc['name'], 'message' => $e->getMessage()];

                    continue;
                }
                foreach ($invoices as $inv) {
                    $dup = DB::table('supplier_invoices')->where('company_id', $cid)->where('supplier_vat', $inv['supplierVat'])
                        ->where('number', $inv['number'])->where('invoice_date', $inv['date'])->first(['id', 'status']);
                    if ($dup && $dup->status === 'applied') {
                        $duplicates[] = ['file' => $doc['name'], 'supplier' => $inv['supplierName'], 'number' => $inv['number'], 'date' => $inv['date'], 'id' => $dup->id];

                        continue;
                    }
                    if ($dup) {
                        $created[] = $dup->id; // bozza già presente: la riprendiamo

                        continue;
                    }
                    $id = (string) Str::uuid();
                    DB::table('supplier_invoices')->insert([
                        'id' => $id,
                        'company_id' => $cid,
                        'status' => 'draft',
                        'supplier_name' => $inv['supplierName'],
                        'supplier_vat' => $inv['supplierVat'],
                        'doc_type' => $inv['docType'],
                        'number' => $inv['number'],
                        'invoice_date' => $inv['date'],
                        'total_amount' => $inv['total'],
                        'original_name' => $doc['name'],
                        'sha256' => hash('sha256', $doc['xml']),
                        'xml' => $doc['xml'],
                        'lines' => json_encode($inv['lines'], JSON_UNESCAPED_UNICODE),
                        'created_by' => $ctx->userId(),
                        'created_at' => Clock::now(),
                    ]);
                    $created[] = $id;
                }
            }
        }
        if ($created !== []) {
            Audit::log($cid, $ctx->userId(), 'supplier_invoice', $created[0], 'uploaded', ['count' => count($created)]);
        }

        return ['created' => array_values(array_unique($created)), 'duplicates' => $duplicates, 'errors' => $errors];
    }

    public function show(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, ...self::PERMS);
        $id = $this->uuid($id);
        $cid = $ctx->companyId();
        $inv = $this->find($cid, $id);
        $lines = json_decode((string) $inv->lines, true) ?: [];
        $maps = DB::table('invoice_line_maps')->where('company_id', $cid)->where('supplier_vat', $inv->supplier_vat)->get()->keyBy('match_key');
        $products = DB::table('ingredients')->where('company_id', $cid)->whereNull('archived_at')->orderBy('name')
            ->get(['id', 'code', 'name', 'category', 'supplier', 'purchase_unit', 'package_content', 'package_unit']);
        $byName = [];
        foreach ($products as $p) {
            $byName[mb_strtolower(trim($p->name))] ??= $p->id;
        }
        $out = [];
        foreach ($lines as $l) {
            $m = $maps[self::key($l)] ?? null;
            $suggest = null;
            if ($m) {
                $suggest = $m->action === 'ignore'
                    ? ['action' => 'ignore', 'remembered' => true]
                    : ['action' => 'existing', 'ingredientId' => $m->ingredient_id, 'mode' => $m->mode, 'packageContent' => $m->package_content !== null ? Dec::of($m->package_content)->toFixed() : null, 'packageUnit' => $m->package_unit, 'purchaseUnit' => $m->purchase_unit, 'remembered' => true];
            } elseif ($l['skip']) {
                $suggest = ['action' => 'ignore', 'remembered' => false];
            } elseif (isset($byName[mb_strtolower(self::cleanName($l['description']))])) {
                $suggest = ['action' => 'existing', 'ingredientId' => $byName[mb_strtolower(self::cleanName($l['description']))], 'remembered' => false];
            }
            $out[] = [...$l, 'suggestedName' => self::cleanName($l['description']), 'suggestion' => $suggest];
        }

        return [
            'id' => $inv->id,
            'status' => $inv->status,
            'supplier' => $inv->supplier_name,
            'supplierVat' => $inv->supplier_vat,
            'docType' => $inv->doc_type,
            'number' => $inv->number,
            'date' => $inv->invoice_date,
            'total' => $inv->total_amount,
            'fileName' => $inv->original_name,
            'summary' => $inv->summary ? json_decode((string) $inv->summary, true) : null,
            'lines' => $out,
            'products' => $products->map(fn ($p) => [
                'id' => $p->id, 'code' => $p->code, 'name' => $p->name, 'category' => $p->category, 'supplier' => $p->supplier,
                'purchaseUnit' => $p->purchase_unit, 'packageContent' => Dec::of($p->package_content)->toFixed(), 'packageUnit' => $p->package_unit,
            ])->all(),
            'categories' => DB::table('ingredients')->where('company_id', $cid)->whereNotNull('category')->where('category', '<>', '')->distinct()->orderBy('category')->pluck('category')->all(),
            'nextDraft' => DB::table('supplier_invoices')->where('company_id', $cid)->where('status', 'draft')->where('id', '<>', $id)->orderBy('created_at')->value('id'),
        ];
    }

    public function confirm(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, ...self::PERMS);
        $id = $this->uuid($id);
        $cid = $ctx->companyId();
        $body = $this->parseBody($req, S::object([
            'lines' => S::array(S::object([
                'n' => S::int(0),
                'action' => S::enum(['new', 'existing', 'ignore']),
                'ingredientId' => S::uuid()->nullable()->optional(),
                'name' => S::optText(160),
                'category' => S::optText(80),
                'mode' => S::enum(['kg', 'l', 'conf'])->nullable()->optional(),
                'packageContent' => S::decOpt(['gt' => 0, 'label' => 'Il contenuto della confezione'])->optional(),
                'packageUnit' => S::measureUnit()->nullable()->optional(),
                'purchaseUnit' => S::optText(40),
                // NUOVO: confezione «a pezzi» → quanto pesa o contiene un pezzo (g o ml)
                'pieceSize' => S::decOpt(['gt' => 0, 'label' => 'Il peso del pezzo'])->optional(),
                'pieceUnit' => S::enum(['g', 'ml'])->nullable()->optional(),
                'remember' => S::bool()->default(true),
            ]))->max(2000),
        ]));

        // NUOVO: prodotti già esistenti toccati dalla fattura, per gli avvisi di variazione
        $watchIds = array_values(array_filter(array_map(fn ($d) => $d['action'] === 'existing' ? ($d['ingredientId'] ?? null) : null, $body['lines'])));
        $names = array_values(array_filter(array_map(fn ($d) => $d['action'] === 'new' ? mb_strtolower(trim((string) ($d['name'] ?? ''))) : null, $body['lines'])));
        if ($names) {
            array_push($watchIds, ...DB::table('ingredients')->where('company_id', $cid)->whereIn(DB::raw('LOWER(name)'), $names)->pluck('id')->all());
        }
        $watch = ChangeAlerts::watch($cid, 'ingredients', $watchIds);
        $head = DB::table('supplier_invoices')->where('id', $id)->where('company_id', $cid)->first(['number', 'invoice_date', 'supplier_name']);

        $summary = DB::transaction(function () use ($ctx, $cid, $id, $body) {
            $inv = DB::table('supplier_invoices')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first();
            if (! $inv) {
                throw AppError::notFound('Fattura');
            }
            if ($inv->status !== 'draft') {
                throw AppError::conflict('already_applied', 'Questa fattura è già stata importata.');
            }
            $lines = [];
            foreach (json_decode((string) $inv->lines, true) ?: [] as $l) {
                $lines[$l['n']] = $l;
            }
            $decisions = [];
            foreach ($body['lines'] as $d) {
                $decisions[$d['n']] = $d;
            }
            // tutte le righe devono avere una scelta
            $fields = [];
            foreach ($lines as $n => $l) {
                if (! isset($decisions[$n])) {
                    $fields["line{$n}"] = 'Scegli cosa fare di questa riga.';
                }
            }
            $date = $inv->invoice_date ?? Clock::today();
            $source = mb_substr('Fattura '.$inv->number.' del '.date('d/m/Y', strtotime($date)), 0, 120);
            $created = 0;
            $prices = 0;
            $skipped = [];
            $ignored = 0;
            $touched = [];
            $newByName = [];
            foreach ($decisions as $n => $d) {
                $l = $lines[$n] ?? null;
                if (! $l) {
                    continue;
                }
                $key = self::key($l);
                if ($d['action'] === 'ignore') {
                    $ignored++;
                    if ($d['remember']) {
                        self::remember($cid, $inv->supplier_vat, $key, ['action' => 'ignore']);
                    }

                    continue;
                }
                $mode = $d['mode'] ?? null;
                if (! $mode) {
                    $fields["line{$n}.mode"] = 'Scegli al kg, al litro o a confezione.';

                    continue;
                }
                [$content, $unit, $purchase] = match ($mode) {
                    'kg' => ['1', 'kg', 'kg'],
                    'l' => ['1', 'l', 'litro'],
                    default => [$d['packageContent'] ?? null, $d['packageUnit'] ?? null, $d['purchaseUnit'] ?? 'confezione'],
                };
                $purchase = \App\Services\Imports\Applier::purchaseUnitFor($content, $unit) ?? $purchase; // «1 kg» = al kg
                if ($mode === 'conf' && (! $content || ! $unit)) {
                    $fields["line{$n}.packageContent"] = 'Indica quanto contiene la confezione.';

                    continue;
                }
                // NUOVO: per il materiale non alimentare (categoria «Materiale di consumo», «Combustibili»…) il peso non serve
                if ($d['action'] === 'new' && $mode === 'conf' && $unit === 'pz' && empty($d['pieceSize']) && ! \App\Support\NonFood::isCategory($cid, $d['category'] ?? null, $nfMap ??= \App\Support\NonFood::categoryMap($cid))) {
                    $fields["line{$n}.pieceSize"] = 'Indica quanto pesa o contiene un pezzo: senza, nelle ricette si potrà usare solo a pezzi.';

                    continue;
                }
                if ($l['netUnitPrice'] === null || Dec::of($l['netUnitPrice'])->lte(Dec::zero())) {
                    $fields["line{$n}"] = 'Questa riga non ha un prezzo: ignorala.';

                    continue;
                }
                if ($d['action'] === 'existing') {
                    $ing = ! empty($d['ingredientId']) ? DB::table('ingredients')->where('id', $d['ingredientId'])->where('company_id', $cid)->first() : null;
                    if (! $ing) {
                        $fields["line{$n}.ingredientId"] = 'Scegli il prodotto.';

                        continue;
                    }
                    if (Units::dimensionOf($ing->package_unit) !== Units::dimensionOf($unit)) {
                        $fields["line{$n}.mode"] = "«{$ing->name}» è registrato ".self::dimLabel($ing->package_unit).': scegli una modalità compatibile.';

                        continue;
                    }
                    $ingId = $ing->id;
                } else {
                    $name = trim((string) ($d['name'] ?? ''));
                    $category = trim((string) ($d['category'] ?? ''));
                    if ($name === '') {
                        $fields["line{$n}.name"] = 'Il nome è obbligatorio.';
                    }
                    if ($category === '') {
                        $fields["line{$n}.category"] = 'La categoria è obbligatoria.';
                    }
                    if ($name === '' || $category === '') {
                        continue;
                    }
                    $lk = mb_strtolower($name);
                    $ingId = $newByName[$lk] ?? DB::table('ingredients')->where('company_id', $cid)->whereRaw('LOWER(name) = ?', [$lk])->value('id');
                    if ($ingId) {
                        $ex = DB::table('ingredients')->where('id', $ingId)->first(['package_unit', 'name']);
                        if (Units::dimensionOf($ex->package_unit) !== Units::dimensionOf($unit)) {
                            $fields["line{$n}.name"] = "Esiste già «{$ex->name}», registrato ".self::dimLabel($ex->package_unit).': cambia nome o modalità.';

                            continue;
                        }
                    } else {
                        $ingId = (string) Str::uuid();
                        $code = Codes::next('ingredients', $cid, 'ING');
                        DB::table('ingredients')->insert([
                            'id' => $ingId,
                            'company_id' => $cid,
                            'code' => $code,
                            'name' => mb_substr($name, 0, 160),
                            'category' => mb_substr($category, 0, 80),
                            'supplier' => $inv->supplier_name,
                            'notes' => $l['code'] ? 'Codice fornitore: '.$l['code'] : null,
                            'purchase_unit' => $purchase,
                            'package_content' => $content,
                            'package_unit' => $unit,
                            'usage_unit' => match (Units::dimensionOf($unit)) { 'volume' => 'ml', 'count' => 'pz', default => 'g' },
                            'edible_yield' => '1',
                            // NUOVO: peso (o volume, con densità 1) di un pezzo per le confezioni a pezzi
                            'density_kg_per_l' => $unit === 'pz' && ! empty($d['pieceSize']) && ($d['pieceUnit'] ?? 'g') === 'ml' ? '1' : null,
                            'unit_weight_kg' => $unit === 'pz' && ! empty($d['pieceSize']) ? Dec::of($d['pieceSize'])->div(Dec::of('1000'))->toFixed() : null,
                            'created_at' => Clock::now(),
                            'updated_at' => Clock::now(),
                        ]);
                        Audit::log($cid, $ctx->userId(), 'ingredient', $ingId, 'created', ['code' => $code, 'name' => $name, 'from' => 'invoice']);
                        $created++;
                    }
                    $newByName[$lk] = $ingId;
                }
                if (DB::table('ingredient_prices')->where('ingredient_id', $ingId)->where('valid_from', $date)->exists()) {
                    $skipped[] = $l['description'];
                } else {
                    DB::table('ingredient_prices')->insert([
                        'id' => (string) Str::uuid(),
                        'company_id' => $cid,
                        'ingredient_id' => $ingId,
                        'package_price' => Dec::of($l['netUnitPrice'])->toFixed(6),
                        'package_content' => $content,
                        'package_unit' => $unit,
                        'valid_from' => $date,
                        'source' => $source,
                        'supplier' => $inv->supplier_name,
                        'agent_name' => null,
                        'notes' => null,
                        'created_by' => $ctx->userId(),
                        'created_at' => Clock::now(),
                        'supplier_invoice_id' => $inv->id,
                    ]);
                    $prices++;
                    $touched[] = $ingId;
                }
                if ($d['remember']) {
                    self::remember($cid, $inv->supplier_vat, $key, ['action' => 'product', 'ingredient_id' => $ingId, 'mode' => $mode, 'package_content' => $content, 'package_unit' => $unit, 'purchase_unit' => $purchase]);
                }
            }
            if ($fields) {
                throw AppError::badRequest('validation_failed', 'Controlla le righe segnate prima di importare.', ['fields' => $fields]);
            }
            $summary = ['created' => $created, 'prices' => $prices, 'ignored' => $ignored, 'skipped' => count($skipped), 'skippedLines' => array_slice($skipped, 0, 20)];
            DB::table('supplier_invoices')->where('id', $id)->update(['status' => 'applied', 'summary' => json_encode($summary, JSON_UNESCAPED_UNICODE), 'applied_by' => $ctx->userId(), 'applied_at' => Clock::now()]);
            Audit::log($cid, $ctx->userId(), 'supplier_invoice', $id, 'applied', $summary);
            $summary['touched'] = array_values(array_unique($touched));

            return $summary;
        });
        $affected = $summary['touched'] ? Costing::invalidate($cid, 'ingredients', $summary['touched']) : [];
        if ($head) {
            ChangeAlerts::commit($watch, $ctx->userId(), ['source' => 'Fattura '.$head->number.($head->invoice_date ? ' del '.date('d/m/Y', strtotime($head->invoice_date)) : '').' · '.$head->supplier_name]);
        }
        unset($summary['touched']);

        return [...$summary, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    /** Scarta una bozza (le fatture già importate restano nello storico). */
    public function destroy(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, ...self::PERMS);
        $id = $this->uuid($id);
        $inv = $this->find($ctx->companyId(), $id);
        if ($inv->status !== 'draft') {
            throw AppError::conflict('already_applied', 'Una fattura già importata non si può scartare: elimina eventualmente i singoli prezzi dal prodotto.');
        }
        DB::table('supplier_invoices')->where('id', $id)->delete();

        return ['ok' => true];
    }

    /** XML originale, per archivio. */
    public function file(Request $req, string $id): \Illuminate\Http\Response
    {
        $ctx = $this->requireCompany($req, ...self::PERMS);
        $id = $this->uuid($id);
        $inv = $this->find($ctx->companyId(), $id);
        $name = preg_replace('/\.p7m$/i', '', preg_replace('/[^A-Za-z0-9._-]/', '_', $inv->original_name) ?? 'fattura.xml') ?? 'fattura.xml';

        return response($inv->xml, 200, ['Content-Type' => 'application/xml; charset=utf-8', 'Content-Disposition' => 'attachment; filename="'.$name.'"']);
    }

    private function find(string $cid, string $id): object
    {
        $inv = DB::table('supplier_invoices')->where('id', $id)->where('company_id', $cid)->first();
        if (! $inv) {
            throw AppError::notFound('Fattura');
        }

        return $inv;
    }

    /** Chiave di abbinamento: il codice articolo del fornitore se c'è, altrimenti la descrizione normalizzata. */
    private static function key(array $l): string
    {
        if (! empty($l['code'])) {
            return 'c:'.mb_strtolower(trim($l['code']));
        }

        return 'd:'.mb_substr(mb_strtolower(preg_replace('/[^\p{L}\p{N}]+/u', ' ', $l['description']) ?? ''), 0, 180);
    }

    private static function remember(string $cid, string $vat, string $key, array $v): void
    {
        DB::table('invoice_line_maps')->updateOrInsert(
            ['company_id' => $cid, 'supplier_vat' => $vat, 'match_key' => $key],
            ['id' => DB::table('invoice_line_maps')->where('company_id', $cid)->where('supplier_vat', $vat)->where('match_key', $key)->value('id') ?? (string) Str::uuid(),
                'action' => $v['action'], 'ingredient_id' => $v['ingredient_id'] ?? null, 'mode' => $v['mode'] ?? null,
                'package_content' => $v['package_content'] ?? null, 'package_unit' => $v['package_unit'] ?? null, 'purchase_unit' => $v['purchase_unit'] ?? null,
                'updated_at' => Clock::now()],
        );
    }

    /** "MOZZ. FIORDILATTE   KG 1 - LOTTO 123" → "Mozz. Fiordilatte Kg 1" (solo un suggerimento: il nome lo decide il ristoratore). */
    private static function cleanName(string $d): string
    {
        $d = preg_replace('/\b(lotto|lot|scad|scadenza)\b.*$/iu', '', $d) ?? $d;
        $d = trim(preg_replace('/\s+/', ' ', $d) ?? $d, " -.;,");
        $d = mb_substr($d, 0, 80);

        return mb_convert_case(mb_strtolower($d), MB_CASE_TITLE);
    }

    private static function dimLabel(string $unit): string
    {
        return match (Units::dimensionOf($unit)) {
            'volume' => 'a volume (litri)',
            'count' => 'a pezzi',
            default => 'a peso (kg)',
        };
    }
}
