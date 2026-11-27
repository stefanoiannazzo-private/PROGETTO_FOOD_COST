<?php

declare(strict_types=1);

namespace App\Services\Imports;

use App\Support\PackSize;

use App\Domain\Costing\Dec;
use App\Services\Recipes;
use Illuminate\Support\Facades\DB;

/**
 * Validazione completa prima di qualsiasi scrittura (port di services/imports/validate.ts): legge il file
 * a blocchi, normalizza ogni riga in tabella di staging e calcola il riepilogo. Nessun dato anagrafico cambia.
 */
final class Validator
{
    public const DEFAULT_OPTIONS = ['headerRow' => 1, 'numberFormat' => 'it', 'onExisting' => 'update', 'onNew' => 'create', 'generateCodes' => true];

    private const BATCH = 500;

    private static function t(mixed $v): bool
    {
        return Recipes::t($v);
    }

    /** @param callable(int): void|null $onProgress */
    public static function run(string $importId, int $maxRows, ?callable $onProgress = null): array
    {
        $imp = DB::table('imports')->where('id', $importId)->first();
        $opts = [...self::DEFAULT_OPTIONS, ...(json_decode($imp->options, true) ?: [])];
        $mapping = json_decode($imp->mapping ?? '{}', true) ?: [];
        $type = $imp->type;
        $companyId = $imp->company_id;
        DB::table('import_rows')->where('import_id', $importId)->delete();
        // NUOVO: categorie non alimentari (niente avviso sul peso del pezzo)
        $opts['_nonFood'] = \App\Support\NonFood::categoryMap($companyId);

        // anagrafica esistente indicizzata per codice (chiave di abbinamento); mai per nome
        $existing = [];
        $existingNames = [];
        if ($type === 'ingredients') {
            foreach (DB::table('ingredients')->where('company_id', $companyId)->get(['id', 'code', 'package_unit', 'name']) as $r) {
                $existing[mb_strtolower($r->code)] = ['id' => $r->id, 'unit' => $r->package_unit, 'name' => $r->name];
                $existingNames[mb_strtolower($r->name)] = true;
            }
        } else {
            foreach (DB::table('employees')->where('company_id', $companyId)->get(['id', 'code', 'first_name', 'last_name']) as $r) {
                $existing[mb_strtolower($r->code)] = ['id' => $r->id, 'unit' => null, 'name' => "{$r->first_name} {$r->last_name}"];
                $existingNames[mb_strtolower("{$r->first_name} {$r->last_name}")] = true;
            }
        }

        $headers = null;
        $colIndex = [];
        $codesInFile = [];
        $count = 0;
        $batch = [];
        $warnings = 0;

        $flush = function () use (&$batch, &$warnings, $type, $importId, $companyId, &$count, $onProgress) {
            if (! $batch) {
                return;
            }
            $toCheck = [];
            foreach ($batch as $i => $b) {
                if ($b['action'] !== 'error' && $b['target_id'] && $b['normalized']) {
                    $toCheck[] = $i;
                }
            }
            self::checkHistoryConflicts($type, $batch, $toCheck);
            $insert = [];
            foreach ($batch as $b) {
                // una riga ignorata per politica non viene scritta: i suoi problemi non bloccano l'importazione
                if ($b['action'] === 'skip') {
                    $b['errors'] = [];
                }
                if ($b['errors']) {
                    $b['action'] = 'error';
                }
                $warnings += count($b['warnings']);
                $insert[] = [
                    'import_id' => $importId,
                    'company_id' => $companyId,
                    'row_number' => $b['row_number'],
                    'raw' => json_encode((object) $b['raw'], JSON_UNESCAPED_UNICODE),
                    'normalized' => $b['normalized'] ? json_encode($b['normalized'], JSON_UNESCAPED_UNICODE) : null,
                    'action' => $b['action'],
                    'target_id' => $b['target_id'],
                    'errors' => $b['errors'] ? json_encode($b['errors'], JSON_UNESCAPED_UNICODE) : null,
                    'warnings' => $b['warnings'] ? json_encode($b['warnings'], JSON_UNESCAPED_UNICODE) : null,
                ];
            }
            DB::table('import_rows')->insert($insert);
            $batch = [];
            if ($onProgress) {
                $onProgress($count);
            }
        };

        $fields = Fields::for($type);
        $missing = array_filter($fields, fn ($f) => $f['required'] && $f['key'] !== 'code' && empty($mapping[$f['key']]));
        if ($missing) {
            throw new ImportError('Colonne obbligatorie non abbinate: '.implode(', ', array_column($missing, 'label')).'.');
        }
        if (empty($mapping['code']) && ! $opts['generateCodes']) {
            throw new ImportError('Abbina la colonna del codice oppure abilita la generazione dei codici per le righe nuove.');
        }

        $path = storage_path('app/'.$imp->storage_path);
        foreach (Reader::rows($path, $imp->file_kind, ['sheet' => $opts['sheet'] ?? null, 'delimiter' => $opts['delimiter'] ?? null, 'encoding' => $opts['encoding'] ?? null]) as $row) {
            if ($row['rowNumber'] < $opts['headerRow']) {
                continue;
            }
            if ($row['rowNumber'] === $opts['headerRow']) {
                $headers = [];
                foreach ($row['cells'] as $i => $c) {
                    $headers[] = $c === null ? 'Colonna '.($i + 1) : trim(self::rawHeader($c));
                }
                $colIndex = [];
                foreach ($mapping as $k => $h) {
                    if (! $h) {
                        continue;
                    }
                    $idx = array_search($h, $headers, true);
                    if ($idx === false) {
                        throw new ImportError("La colonna “{$h}” non è presente nel file.");
                    }
                    $colIndex[$k] = $idx;
                }

                continue;
            }
            if ($headers === null) {
                continue;
            }
            $allEmpty = true;
            foreach ($row['cells'] as $c) {
                if ($c !== null && trim(self::rawText($c)) !== '') {
                    $allEmpty = false;
                    break;
                }
            }
            if ($allEmpty) {
                continue;
            }
            $count++;
            if ($count > $maxRows) {
                throw new ImportError('Il file supera il limite di '.number_format($maxRows, 0, ',', '.').' righe: dividilo in più file.');
            }
            $cells = $row['cells'];
            $get = fn (string $k) => isset($colIndex[$k]) ? ($cells[$colIndex[$k]] ?? null) : null;
            $raw = [];
            foreach ($headers as $i => $h) {
                $raw[$h] = self::rawText($cells[$i] ?? null);
            }
            $staged = ['row_number' => $row['rowNumber'], 'raw' => $raw, 'normalized' => null, 'action' => 'error', 'target_id' => null, 'errors' => [], 'warnings' => []];
            if ($type === 'ingredients') {
                self::normalizeIngredient($staged, $get, $opts, $existing, $existingNames);
            } else {
                self::normalizeEmployee($staged, $get, $opts, $existing, $existingNames);
            }
            $code = isset($staged['normalized']['code']) && $staged['normalized']['code'] !== null ? mb_strtolower($staged['normalized']['code']) : null;
            if ($code !== null && $code !== '') {
                $codesInFile[$code][] = $row['rowNumber'];
            }
            $batch[] = $staged;
            if (count($batch) >= self::BATCH) {
                $flush();
            }
        }
        $flush();
        if ($headers === null) {
            throw new ImportError('Il file non contiene la riga di intestazione indicata.');
        }

        // duplicati interni al file: tutte le occorrenze sono in errore (nessuna scelta arbitraria)
        $dups = array_filter($codesInFile, fn ($rows) => count($rows) > 1);
        foreach ($dups as $code => $rows) {
            $msg = 'Codice “'.mb_strtoupper((string) $code).'” duplicato nel file (righe '.implode(', ', $rows).').';
            foreach (DB::table('import_rows')->where('import_id', $importId)->whereIn('row_number', $rows)->get(['id', 'errors']) as $r) {
                $errs = $r->errors ? json_decode($r->errors, true) : [];
                $errs[] = $msg;
                DB::table('import_rows')->where('id', $r->id)->update(['action' => 'error', 'errors' => json_encode($errs, JSON_UNESCAPED_UNICODE)]);
            }
        }
        $by = DB::table('import_rows')->where('import_id', $importId)->groupBy('action')->selectRaw('action, count(*) as n')->pluck('n', 'action')->all();

        return [
            'headers' => $headers,
            'totalRows' => $count,
            'create' => (int) ($by['create'] ?? 0),
            'update' => (int) ($by['update'] ?? 0),
            'skip' => (int) ($by['skip'] ?? 0),
            'error' => (int) ($by['error'] ?? 0),
            'warnings' => $warnings,
            'duplicates' => count($dups),
        ];
    }

    /** Intestazione come String(cella).trim() dell'originale. */
    private static function rawHeader(mixed $c): string
    {
        if ($c instanceof \DateTimeImmutable) {
            return $c->format('D M d Y');
        }

        return Reader::cellText($c);
    }

    public static function rawText(mixed $c): string
    {
        if ($c === null) {
            return '';
        }
        if ($c instanceof \DateTimeImmutable) {
            return $c->format('Y-m-d');
        }
        if ($c instanceof Formula) {
            return '='.$c->formula;
        }

        return Reader::scalar($c);
    }

    private static function field(array &$s, string $label, callable $fn): mixed
    {
        try {
            return $fn();
        } catch (CellError $e) {
            $s['errors'][] = "{$label}: {$e->getMessage()}.";

            return null;
        }
    }

    private static function decideAction(array &$s, ?string $code, array $o, array $existing, bool $generated): void
    {
        $hit = $code ? ($existing[mb_strtolower($code)] ?? null) : null;
        if ($hit) {
            $s['target_id'] = $hit['id'];
            $s['action'] = $o['onExisting'] === 'update' ? 'update' : 'skip';
            if ($s['action'] === 'skip') {
                $s['warnings'][] = 'Codice già esistente: riga ignorata secondo la politica scelta.';
            }
        } else {
            $s['action'] = $o['onNew'] === 'create' ? 'create' : 'skip';
            if ($s['action'] === 'skip') {
                $s['warnings'][] = 'Nuovo codice: riga ignorata secondo la politica scelta.';
            }
            if ($generated && $s['action'] === 'create') {
                $s['warnings'][] = 'Codice mancante: verrà generato automaticamente.';
            }
        }
    }

    private static function normalizeIngredient(array &$s, callable $get, array $o, array $existing, array $names): void
    {
        $nf = $o['numberFormat'];
        $code = self::field($s, 'Codice', fn () => Normalize::text($get('code')));
        $name = self::field($s, 'Nome', fn () => Normalize::text($get('name')));
        $packagePrice = self::field($s, 'Prezzo confezione', fn () => Normalize::number($get('packagePrice'), $nf));
        $packageContent = self::field($s, 'Contenuto confezione', fn () => Normalize::number($get('packageContent'), $nf));
        $packageUnit = self::field($s, 'Unità contenuto', fn () => Normalize::unit($get('packageUnit')));
        $priceDate = self::field($s, 'Data prezzo', fn () => Normalize::date($get('priceDate')));
        $usageUnit = self::field($s, 'Unità in ricetta', fn () => Normalize::unit($get('usageUnit')));
        $yieldPct = self::field($s, 'Resa edibile', fn () => Normalize::number($get('edibleYieldPercent'), $nf));
        $density = self::field($s, 'Densità', fn () => Normalize::number($get('densityKgPerL'), $nf));
        $unitWeightG = self::field($s, 'Peso unitario', fn () => Normalize::number($get('unitWeightG'), $nf));

        $generated = ! self::t($code) && $o['generateCodes'];
        if (! self::t($code) && ! $o['generateCodes']) {
            $s['errors'][] = 'Codice mancante: senza codice non è possibile abbinare la riga.';
        }
        self::decideAction($s, $code, $o, $existing, $generated);
        $hit = $code ? ($existing[mb_strtolower($code)] ?? null) : null;

        if ($s['action'] === 'create') {
            if (! self::t($name)) {
                $s['errors'][] = 'Nome obbligatorio per un nuovo ingrediente.';
            }
            if (! self::t($packageContent)) {
                $s['errors'][] = 'Contenuto della confezione obbligatorio.';
            }
            if (! self::t($packageUnit)) {
                $s['errors'][] = 'Unità del contenuto obbligatoria.';
            }
            if (self::t($name) && isset($names[mb_strtolower($name)])) {
                $s['warnings'][] = 'Esiste già un ingrediente con lo stesso nome ma codice diverso: verrà creato un nuovo articolo (il nome non è usato per abbinare).';
            }
        }
        if (self::t($packageContent) && ! Dec::of($packageContent)->gt(0)) {
            $s['errors'][] = 'Il contenuto della confezione deve essere maggiore di zero.';
        }
        if (self::t($packagePrice) && Dec::of($packagePrice)->lt(0)) {
            $s['errors'][] = 'Il prezzo non può essere negativo.';
        }
        if (self::t($packagePrice) && ! self::t($priceDate)) {
            $s['errors'][] = 'Data del prezzo obbligatoria: lo storico richiede una validità esplicita.';
        }
        if ($packagePrice !== null && Dec::of($packagePrice)->isZero()) {
            $s['warnings'][] = 'Prezzo pari a zero: sarà registrato come prezzo esplicito.';
        }
        if (self::t($yieldPct) && (! Dec::of($yieldPct)->gt(0) || Dec::of($yieldPct)->gt(100))) {
            $s['errors'][] = 'La resa edibile deve essere maggiore di 0 e al massimo 100.';
        }
        if (self::t($density) && ! Dec::of($density)->gt(0)) {
            $s['errors'][] = 'La densità deve essere maggiore di zero.';
        }
        if (self::t($unitWeightG) && ! Dec::of($unitWeightG)->gt(0)) {
            $s['errors'][] = 'Il peso unitario deve essere maggiore di zero.';
        }
        if ($hit && self::t($packageUnit) && $hit['unit'] && ! Normalize::sameDimension($packageUnit, $hit['unit'])) {
            $s['errors'][] = "L’unità {$packageUnit} non è compatibile con la confezione esistente ({$hit['unit']}).";
        }
        if ($s['action'] === 'update' && self::t($packagePrice) && ! self::t($packageContent) && ! $hit) {
            $s['errors'][] = 'Contenuto della confezione mancante.';
        }
        $effUnit = $packageUnit ?? ($hit['unit'] ?? null);
        $effUsage = $usageUnit ?? ($effUnit ? Normalize::defaultUsageUnit($effUnit) : null);
        if ($effUnit && $effUsage && ! Normalize::sameDimension($effUnit, $effUsage)) {
            $dims = [$effUnit, $effUsage];
            if (array_intersect($dims, ['ml', 'cl', 'l']) && array_intersect($dims, ['g', 'kg']) && ! self::t($density)) {
                $s['errors'][] = 'Unità in ricetta e confezione di grandezze diverse: serve la densità.';
            }
            if (in_array('pz', $dims, true) && ! self::t($unitWeightG)) {
                $s['errors'][] = 'Unità in ricetta e confezione di grandezze diverse: serve il peso unitario.';
            }
        }
        // NUOVO: contenuto «in pezzi» senza peso → nelle ricette il prodotto si potrà dosare solo a pezzi
        $category = Normalize::text($get('category'));
        $nonFoodCat = self::t($category) && (isset($o['_nonFood'][mb_strtolower(trim($category))]) ? $o['_nonFood'][mb_strtolower(trim($category))]['nonFood'] : \App\Support\NonFood::guess($category));
        if ($effUnit === 'pz' && ! self::t($unitWeightG) && ! $nonFoodCat && $s['action'] !== 'skip' && $s['action'] !== 'error') {
            $size = PackSize::fromName($name ?? ($hit['name'] ?? null));
            $s['warnings'][] = 'Contenuto in pezzi senza peso: nelle ricette si potrà usare solo a pezzi, non a grammi o ml. '
                .($size ? "Dal nome sembra {$size['qty']} {$size['unit']}: scrivi «Contenuto confezione» {$size['qty']} e «Unità contenuto» {$size['unit']}, " : 'Scrivi il contenuto in g, kg, ml o l, ')
                .'oppure indica il «Peso unitario g» (es. bustina 12 g). Potrai completarlo anche dopo, dalla scheda del prodotto.';
        }
        $s['normalized'] = [
            'code' => $code,
            'name' => $name,
            'category' => self::field($s, 'Categoria', fn () => Normalize::text($get('category'))),
            'supplier' => self::field($s, 'Fornitore', fn () => Normalize::text($get('supplier'))),
            'agentName' => self::field($s, 'Agente', fn () => Normalize::text($get('agentName'))),
            'packagePrice' => $packagePrice,
            'packageContent' => $packageContent,
            'packageUnit' => $packageUnit,
            'priceDate' => $priceDate,
            'usageUnit' => $effUsage,
            'edibleYieldPercent' => $yieldPct,
            'densityKgPerL' => $density,
            'unitWeightKg' => self::t($unitWeightG) ? Dec::of($unitWeightG)->div(1000)->toFixed() : null,
            'priceSource' => self::field($s, 'Fonte', fn () => Normalize::text($get('priceSource'))),
        ];
    }

    private static function normalizeEmployee(array &$s, callable $get, array $o, array $existing, array $names): void
    {
        $nf = $o['numberFormat'];
        $code = self::field($s, 'Codice', fn () => Normalize::text($get('code')));
        $firstName = self::field($s, 'Nome', fn () => Normalize::text($get('firstName')));
        $lastName = self::field($s, 'Cognome', fn () => Normalize::text($get('lastName')));
        $gross = self::field($s, 'Lordo mensile', fn () => Normalize::number($get('grossMonthly'), $nf));
        $extra = self::field($s, 'Voce extra', fn () => Normalize::number($get('extraMonthly'), $nf));
        $hours = self::field($s, 'Ore produttive', fn () => Normalize::number($get('productiveHours'), $nf));
        $validFrom = self::field($s, 'Decorrenza', fn () => Normalize::date($get('validFrom')));
        $mode = self::field($s, 'Modalità oneri', fn () => Normalize::contributionsMode($get('contributionsMode')));
        $cValue = self::field($s, 'Oneri', fn () => Normalize::number($get('contributionsValue'), $nf));
        $other = self::field($s, 'Altri costi', fn () => Normalize::number($get('otherMonthlyCosts'), $nf));
        $statusText = self::field($s, 'Stato', function () use ($get) {
            $t = Normalize::text($get('status'));

            return $t === null ? null : mb_strtolower($t);
        });

        $generated = ! self::t($code) && $o['generateCodes'];
        if (! self::t($code) && ! $o['generateCodes']) {
            $s['errors'][] = 'Codice dipendente mancante: senza codice non è possibile abbinare la riga.';
        }
        self::decideAction($s, $code, $o, $existing, $generated);
        if ($s['action'] === 'create') {
            if (! self::t($firstName) || ! self::t($lastName)) {
                $s['errors'][] = 'Nome e cognome obbligatori per un nuovo dipendente.';
            }
            if (self::t($firstName) && self::t($lastName) && isset($names[mb_strtolower("{$firstName} {$lastName}")])) {
                $s['warnings'][] = 'Esiste già un dipendente con lo stesso nome ma codice diverso: verrà creato un nuovo dipendente.';
            }
        }
        if ($gross === null) {
            $s['errors'][] = 'Lordo mensile obbligatorio.';
        } elseif (Dec::of($gross)->lt(0)) {
            $s['errors'][] = 'Il lordo mensile non può essere negativo.';
        }
        if (self::t($extra) && Dec::of($extra)->lt(0)) {
            $s['errors'][] = 'La voce extra non può essere negativa.';
        }
        if ($hours === null) {
            $s['errors'][] = 'Ore produttive mensili obbligatorie.';
        } elseif (! Dec::of($hours)->gt(0) || Dec::of($hours)->gt(744)) {
            $s['errors'][] = 'Le ore produttive devono essere maggiori di zero e plausibili (massimo 744).';
        }
        if (! self::t($validFrom)) {
            $s['errors'][] = 'Decorrenza obbligatoria.';
        }
        if ($mode === null) {
            $mode = self::t($cValue) ? null : 'none';
        }
        if ($mode === null) {
            $s['errors'][] = 'Indica la modalità degli oneri (importo o percentuale): non viene dedotta.';
        }
        if ($mode === 'none' && self::t($cValue) && ! Dec::of($cValue)->isZero()) {
            $s['errors'][] = 'Modalità “nessuno” con un valore di oneri: dati contraddittori.';
        }
        if (($mode === 'amount' || $mode === 'percent') && $cValue === null) {
            $s['errors'][] = 'Valore degli oneri mancante.';
        }
        if (self::t($cValue) && Dec::of($cValue)->lt(0)) {
            $s['errors'][] = 'Gli oneri non possono essere negativi.';
        }
        if ($mode === 'percent' && self::t($cValue) && Dec::of($cValue)->gt(200)) {
            $s['errors'][] = 'Percentuale oneri non plausibile (oltre 200%).';
        }
        if (self::t($other) && Dec::of($other)->lt(0)) {
            $s['errors'][] = 'Gli altri costi non possono essere negativi.';
        }
        $status = null;
        if (self::t($statusText)) {
            if (in_array($statusText, ['attivo', 'attiva', 'active', 'si', 'sì'], true)) {
                $status = 'active';
            } elseif (in_array($statusText, ['non attivo', 'inattivo', 'inactive', 'no', 'cessato'], true)) {
                $status = 'inactive';
            } else {
                $s['errors'][] = "Stato “{$statusText}” non riconosciuto (attivo / non attivo).";
            }
        }
        $s['normalized'] = [
            'code' => $code,
            'firstName' => $firstName,
            'lastName' => $lastName,
            'jobTitle' => self::field($s, 'Mansione', fn () => Normalize::text($get('jobTitle'))),
            'status' => $status,
            'grossMonthly' => $gross,
            'extraMonthly' => $extra,
            'productiveHours' => $hours,
            'validFrom' => $validFrom,
            'contributionsMode' => $mode,
            'contributionsValue' => $mode === 'none' ? null : $cValue,
            'otherMonthlyCosts' => $other,
        ];
    }

    /** Prezzo/configurazione già presente alla stessa data: identico → ignorato; diverso → errore. */
    private static function checkHistoryConflicts(string $type, array &$batch, array $idx): void
    {
        if (! $idx) {
            return;
        }
        if ($type === 'ingredients') {
            $withPrice = array_values(array_filter($idx, fn ($i) => $batch[$i]['normalized']['packagePrice'] !== null && self::t($batch[$i]['normalized']['priceDate'])));
            if (! $withPrice) {
                return;
            }
            $found = DB::table('ingredient_prices')->whereIn('ingredient_id', array_map(fn ($i) => $batch[$i]['target_id'], $withPrice))
                ->get(['ingredient_id', 'valid_from', 'package_price', 'package_content', 'package_unit']);
            foreach ($withPrice as $i) {
                $n = &$batch[$i]['normalized'];
                $same = $found->first(fn ($f) => $f->ingredient_id === $batch[$i]['target_id'] && $f->valid_from === $n['priceDate']);
                if ($same) {
                    $identical = Dec::of($same->package_price)->eq($n['packagePrice'])
                        && (! self::t($n['packageContent']) || Dec::of($same->package_content)->eq($n['packageContent']))
                        && (! self::t($n['packageUnit']) || $same->package_unit === $n['packageUnit']);
                    if ($identical) {
                        $n['priceDuplicate'] = true;
                        $batch[$i]['warnings'][] = 'Prezzo identico già presente con la stessa data: non verrà duplicato.';
                    } else {
                        $batch[$i]['errors'][] = "Esiste già un prezzo diverso con data {$n['priceDate']}: modifica la data o elimina il prezzo esistente.";
                    }
                }
                unset($n);
            }
        } else {
            $found = DB::table('employee_cost_configs')->whereIn('employee_id', array_map(fn ($i) => $batch[$i]['target_id'], $idx))
                ->get(['employee_id', 'valid_from', 'gross_monthly', 'extra_monthly', 'contributions_mode', 'contributions_value', 'other_monthly_costs', 'productive_hours']);
            $eq = function (?string $a, mixed $b): bool {
                if ($a === null || $b === null) {
                    return ($a ?? '0') === (string) ($b ?? '0') || Dec::of($a ?? '0')->eq((string) ($b ?? '0'));
                }

                return Dec::of($a)->eq((string) $b);
            };
            foreach ($idx as $i) {
                $n = &$batch[$i]['normalized'];
                $same = $found->first(fn ($f) => $f->employee_id === $batch[$i]['target_id'] && $f->valid_from === $n['validFrom']);
                if ($same) {
                    $identical = $eq($same->gross_monthly, $n['grossMonthly'])
                        && $eq($same->extra_monthly, $n['extraMonthly'])
                        && $eq($same->productive_hours, $n['productiveHours'])
                        && $same->contributions_mode === $n['contributionsMode']
                        && $eq($same->contributions_value, $n['contributionsValue'])
                        && $eq($same->other_monthly_costs, $n['otherMonthlyCosts'] ?? '0');
                    if ($identical) {
                        $n['configDuplicate'] = true;
                        $batch[$i]['warnings'][] = 'Configurazione di costo identica già presente con la stessa decorrenza: non verrà duplicata.';
                    } else {
                        $batch[$i]['errors'][] = "Esiste già una configurazione diversa con decorrenza {$n['validFrom']}.";
                    }
                }
                unset($n);
            }
        }
    }
}
