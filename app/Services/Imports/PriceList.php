<?php

declare(strict_types=1);

namespace App\Services\Imports;

use App\Domain\Costing\Dec;
use App\Support\NonFood;
use Illuminate\Support\Facades\DB;

/**
 * NUOVO — listino dei fornitori nel formato «data, nome, prezzo, iva, U.M., sconti, fornitore»
 * (es. l'esportazione «Listino Momy»). Regole:
 * - U.M. KG / K / KG. → al kg; LT / L → al litro (il prezzo è sempre quello dell'unità di misura);
 * - altre U.M. (PZ, N., CT, CF, SCAT, FU…) → confezione, con contenuto letto dal nome (500 ml, KG 10, 62gX8, X 90, 1000PZ);
 * - sconti applicati a cascata, sempre in percentuale («5+5+5», «-10 %, -10 %», «-17,00», «5,5»);
 * - stesso fornitore scritto in modi diversi (NOVAL SRL / NOV.AL S.R.L.) unificato;
 * - abbinamento ai prodotti esistenti per codice articolo MARR, poi nome + fornitore, poi solo nome se unico;
 * - categoria e «non alimentare» proposti dal nome per i prodotti nuovi.
 */
final class PriceList
{
    public const HEADERS = ['data' => ['data_scarico', 'data', 'data prezzo', 'data documento'], 'name' => ['nome', 'descrizione', 'prodotto', 'articolo'],
        'price' => ['price', 'prezzo', 'prezzo unitario'], 'vat' => ['iva', 'aliquota iva', '% iva'], 'um' => ['u.m.', 'um', 'u.m', 'unita di misura', 'unità di misura'],
        'discount' => ['sconti', 'sconto', 'sconti %'], 'supplier' => ['fornitore', 'ragione sociale']];

    private const NON_FOOD = ['tovagl', 'sacch', 'sacchi', 'carta ', 'carta.', 'carta forno', 'pellicola', 'alluminio', ' cif ', 'cif crema', 'candeggina', 'svelto', 'detersiv', 'sgrassa', 'panno', 'piatti', 'bicch', 'cann.', 'cannucc',
        'buste', 'bobina', 'asciug', 'guanti', 'spugn', 'rotol', 'coprimacchia', 'posate', 'forchett', 'cucchiai', 'coltell', 'pavimenti', 'lavastoviglie', 'brillantante', 'sapone', 'igienic',
        'legna', 'pellet', 'carbone', 'accendi', 'box ', 'box generico', 'vaschetta alluminio', 'contenitor', 'coperchi', 'stuzzicadent', 'mater-bi', 'tnt', 'scottex', 'ammorbid', 'anticalcare', 'disinfett', 'sanific', 'shopper', 'etichett', 'scontrin', 'rotolo termico', 'pirottin', 'sottobicch', 'cartone pizza', 'scatola pizza', 'porta pizza'];

    /** @return array<string, int|null> indice delle colonne, null se mancante */
    public static function columns(array $headers): array
    {
        $norm = array_map(fn ($h) => trim(mb_strtolower((string) $h)), $headers);
        $out = [];
        foreach (self::HEADERS as $k => $names) {
            $out[$k] = null;
            foreach ($names as $n) {
                $i = array_search($n, $norm, true);
                if ($i !== false) {
                    $out[$k] = $i;
                    break;
                }
            }
        }

        return $out;
    }

    public static function isPriceList(array $headers): bool
    {
        $c = self::columns($headers);

        return $c['name'] !== null && $c['price'] !== null && $c['um'] !== null && $c['supplier'] !== null && $c['discount'] !== null;
    }

    /* ------------------------------ lettura ------------------------------ */

    /** @return list<array{row:int,date:?string,name:string,price:?string,vat:?string,um:string,discount:string,supplier:string}> */
    public static function read(string $path, string $kind): array
    {
        $delimiter = null;
        $encoding = null;
        if ($kind === 'csv') {
            $sample = (string) file_get_contents($path, false, null, 0, 65536);
            $encoding = Reader::detectEncoding($sample);
            $delimiter = Reader::detectDelimiter($encoding === 'utf8' ? $sample : (mb_convert_encoding($sample, 'UTF-8', 'Windows-1252') ?: $sample));
        }
        $cols = null;
        $rows = [];
        foreach (Reader::rows($path, $kind, ['delimiter' => $delimiter, 'encoding' => $encoding]) as $r) {
            $cells = array_map(fn ($c) => Validator::rawText($c), $r['cells']);
            if ($cols === null) {
                if (! self::isPriceList($cells)) {
                    throw new ImportError('Il file non sembra un listino: servono le colonne nome, price, U.M., sconti e fornitore.');
                }
                $cols = self::columns($cells);

                continue;
            }
            $get = fn (string $k) => $cols[$k] === null ? '' : trim((string) ($cells[$cols[$k]] ?? ''));
            if ($get('name') === '' && $get('price') === '') {
                continue;
            }
            $rows[] = ['row' => $r['rowNumber'], 'date' => self::date($get('data')), 'name' => preg_replace('/\s+/u', ' ', $get('name')), 'price' => self::num($get('price')),
                'vat' => $get('vat'), 'um' => $get('um'), 'discount' => $get('discount'), 'supplier' => preg_replace('/\s+/u', ' ', $get('supplier'))];
            if (count($rows) > 20000) {
                throw new ImportError('Il listino supera le 20.000 righe: dividilo in più file.');
            }
        }
        if ($cols === null) {
            throw new ImportError('Il file è vuoto.');
        }

        return $rows;
    }

    public static function num(string $s): ?string
    {
        $s = trim(str_replace(['€', ' '], '', $s));
        if ($s === '') {
            return null;
        }
        if (str_contains($s, ',')) {
            $s = str_replace(['.', ','], ['', '.'], $s);
        }
        if (! is_numeric($s) || (float) $s <= 0) {
            return null;
        }

        return Dec::of($s)->toFixed(6);
    }

    public static function date(string $s): ?string
    {
        if (preg_match('/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/', $s, $m)) {
            $y = strlen($m[3]) === 2 ? '20'.$m[3] : $m[3];

            return checkdate((int) $m[2], (int) $m[1], (int) $y) ? sprintf('%04d-%02d-%02d', $y, $m[2], $m[1]) : null;
        }
        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})/', $s, $m)) {
            return "{$m[1]}-{$m[2]}-{$m[3]}";
        }

        return null;
    }

    /** Sconti a cascata, tutti in percentuale: «5+5+5», «-10 %, -10 %», «-17,00», «5,5» (= 5+5), «+0%». @return list<string> */
    public static function discounts(string $s): array
    {
        $s = mb_strtolower(trim($s));
        if (str_contains($s, 'iva')) {
            return []; // «9,90+IVA» è una nota sul prezzo, non uno sconto
        }
        // «-17,00» / «-40,70» (Cicogna): un solo sconto con i decimali
        if (preg_match('/^-\s*(\d+),(\d{1,2})\s*%?$/u', $s, $m)) {
            $v = (float) ($m[1].'.'.$m[2]);

            return $v > 0 && $v < 100 ? [rtrim(rtrim(number_format($v, 2, '.', ''), '0'), '.')] : [];
        }
        $s = preg_replace('/\b(iva|sc\.?|sconto)\b/u', ' ', $s);
        $out = [];
        foreach (preg_split('/[+,;\/]|\s{1,}/u', (string) $s) as $p) {
            $p = trim(str_replace(['%', '-'], '', $p));
            if ($p === '' || ! is_numeric($p)) {
                continue;
            }
            $v = (float) $p;
            if ($v > 0 && $v < 100) {
                $out[] = rtrim(rtrim(number_format($v, 2, '.', ''), '0'), '.');
            }
        }

        return $out;
    }

    public static function applyDiscounts(string $price, array $d): string
    {
        $p = Dec::of($price);
        foreach ($d as $x) {
            $p = $p->times(Dec::of('100')->minus(Dec::of($x)))->div(Dec::of('100'));
        }

        return $p->toFixed(6);
    }

    /* ------------------------------ chiavi ------------------------------ */

    private const STOP = ['srl', 'spa', 'sas', 'snc', 'srls', 'sapa', 'di', 'e', 'c', 'co', 'the', 'societa', 'soc', 'coop', 'scarl'];

    public static function supplierKey(string $s): string
    {
        $s = mb_strtolower($s);
        $s = preg_replace('/\b(s\.?\s?r\.?\s?l\.?s?|s\.?\s?p\.?\s?a\.?|s\.?\s?a\.?\s?s\.?|s\.?\s?n\.?\s?c\.?)(?![a-z])/u', ' ', $s);
        $s = str_replace('.', '', (string) $s);
        $tokens = array_values(array_filter(preg_split('/[^a-z0-9àèéìòù]+/u', (string) $s), fn ($t) => $t !== '' && ! in_array($t, self::STOP, true)));

        return implode('', array_slice($tokens, 0, 2));
    }

    public static function sameSupplier(string $a, string $b): bool
    {
        return $a !== '' && $b !== '' && (str_starts_with($a, $b) || str_starts_with($b, $a));
    }

    /** codice articolo in testa al nome (MARR: «642725 OLIO EVO…») */
    public static function articleCode(string $name): ?string
    {
        return preg_match('/^\s*(\d{5,7})\s+\S/u', $name, $m) ? $m[1] : null;
    }

    public static function nameKey(string $name): string
    {
        $s = mb_strtolower($name);
        $s = preg_replace('/^\s*\d{5,7}\s+/u', '', $s);
        $s = preg_replace('/^\s*it\s+/u', '', (string) $s);
        $s = preg_replace('/[^a-z0-9àèéìòù]+/u', ' ', (string) $s);

        return trim((string) $s);
    }

    /* --------------------------- confezione --------------------------- */

    private const U = ['kg' => 'kg', 'k' => 'kg', 'kgm' => 'kg', 'g' => 'g', 'gr' => 'g', 'grammi' => 'g', 'l' => 'l', 'lt' => 'l', 'ltr' => 'l', 'litri' => 'l', 'ml' => 'ml', 'cl' => 'cl'];

    /**
     * Come si paga il prodotto, dalla U.M. e dal nome.
     * @return array{mode:string, content:string, unit:string, purchaseUnit:string, pieceKg:?string, density:?string, check:?string}
     */
    public static function pack(string $um, string $name): array
    {
        $u = rtrim(mb_strtolower(trim($um)), '.');
        if (in_array($u, ['kg', 'k', 'kgm', 'kgs', 'kgr', 'chili', 'kilo'], true)) {
            return ['mode' => 'kg', 'content' => '1', 'unit' => 'kg', 'purchaseUnit' => 'kg', 'pieceKg' => null, 'density' => null, 'check' => null];
        }
        if (in_array($u, ['lt', 'l', 'ltr', 'litri', 'litro'], true)) {
            return ['mode' => 'l', 'content' => '1', 'unit' => 'l', 'purchaseUnit' => 'litro', 'pieceKg' => null, 'density' => null, 'check' => null];
        }
        $label = match (true) {
            str_starts_with($u, 'ct') || str_starts_with($u, 'cart') => 'cartone',
            str_starts_with($u, 'scat') => 'scatola',
            str_starts_with($u, 'fu') => 'fusto',
            str_starts_with($u, 'cf') || str_starts_with($u, 'conf') => 'confezione',
            default => 'confezione',
        };
        $n = mb_strtolower($name);
        $num = '(\d+(?:[.,]\d+)?)';
        $unit = '(kg|k|kgm|grammi|gr|g|litri|ltr|lt|l|ml|cl)(?![a-wyz])';
        $f = fn ($x) => (float) str_replace(',', '.', $x);
        $fmt = fn (float $v) => rtrim(rtrim(number_format($v, 3, '.', ''), '0'), '.');
        $toKg = fn (float $q, string $un) => match (self::U[$un]) { 'kg' => $q, 'g' => $q / 1000, 'l' => $q, 'ml' => $q / 1000, 'cl' => $q / 100 };
        $pieceUm = in_array($u, ['pz', 'n', 'nr', 'num', 'pezzi', 'pezzo'], true);
        // «CF DA 30»: quanti pezzi lo dice l'unità di misura
        if (preg_match('/da\s*(\d+)/u', $u, $um30) && (int) $um30[1] > 1) {
            $size = self::firstSize($n);
            $count = (int) $um30[1];
            if ($size) {
                $base = self::U[$size[1]];

                return ['mode' => 'conf', 'content' => (string) $count, 'unit' => 'pz', 'purchaseUnit' => 'confezione', 'pieceKg' => $fmt($toKg($size[0], $size[1])) ?: null,
                    'density' => in_array($base, ['l', 'ml', 'cl'], true) ? '1' : null, 'check' => null];
            }

            return ['mode' => 'conf', 'content' => (string) $count, 'unit' => 'pz', 'purchaseUnit' => 'confezione', 'pieceKg' => null, 'density' => null, 'check' => null];
        }
        $piece = function (int $count, float $q, string $un) use ($toKg, $fmt, $label, $pieceUm) {
            $base = self::U[$un];
            if ($pieceUm) {
                // venduto a pezzo (PZ, N.): «RISO 5X1kg» a 2,85 € è il prezzo di un pacco da 1 kg
                return ['mode' => 'conf', 'content' => $fmt($q), 'unit' => $base, 'purchaseUnit' => 'pezzo', 'pieceKg' => null, 'density' => null, 'check' => null];
            }
            $vol = in_array($base, ['l', 'ml', 'cl'], true);

            return ['mode' => 'conf', 'content' => (string) $count, 'unit' => 'pz', 'purchaseUnit' => $label, 'pieceKg' => $fmt($toKg($q, $un)) ?: null, 'density' => $vol ? '1' : null, 'check' => null];
        };
        // gelati: «P48G90» = 48 pezzi da 90 g · «G75PZ80» / «GR.90 PZ.20» = pezzi da 75 / 90 g, 80 / 20 pezzi
        if (preg_match('/(?<![a-z])p\s*(\d+)\s*g\s*(\d+)/u', $n, $m) && (int) $m[1] > 1) {
            return $piece((int) $m[1], $f($m[2]), 'g');
        }
        if (preg_match('/(?<![a-z])(?:g|gr)\.?\s*(\d+)\s*pz\.?\s*(\d+)/u', $n, $m) && (int) $m[2] > 1) {
            return $piece((int) $m[2], $f($m[1]), 'g');
        }
        // gelati: «G90 P20», «PZ.20 GR.90», «80GR P56»
        if (! $pieceUm && preg_match('/(?<![a-z])gr?\.?\s*(\d+)(?![\d,.])/u', $n, $gm) && preg_match('/(?<![a-z])p(?:z\.?)?\s*(\d+)(?![\d])/u', $n, $pm) && (int) $pm[1] > 1) {
            return $piece((int) $pm[1], $f($gm[1]), 'g');
        }
        // cartone / confezione: formato del pezzo + quanti pezzi («50cl Petx24», «80GR P56», «248PZ1GR»)
        if (! $pieceUm && preg_match("/{$num}\s*{$unit}/u", $n, $sm)
            && (preg_match('/(?<![\d])x\s*(\d+)(?![\d,.]*\s*(?:kg|g|gr|ml|cl|l|lt)(?![a-z]))/u', $n, $cm)
                || preg_match('/(\d+)\s*(?:pz|pezzi|pcs|bs|bust[ei]ne?|buste|monoporzioni|porz)(?![a-z])/u', $n, $cm)
                || preg_match('/(?<![a-z])p(?:z\.?)?\s*(\d+)(?![\d])/u', $n, $cm))
            && (int) $cm[1] > 1 && $cm[1] !== $sm[1]) {
            return $piece((int) $cm[1], $f($sm[1]), $sm[2]);
        }
        // «bustine 10ml 100bs»: prima il formato del pezzo, poi quanti pezzi
        if (preg_match("/{$num}\s*{$unit}.*?(?<![\d,.])(\d+)\s*(?:pz|pezzi|pcs|bs|bust[ei]ne?|buste|monoporzioni|porz)(?![a-z])/u", $n, $m) && (int) $m[3] > 1) {
            return $piece((int) $m[3], $f($m[1]), $m[2]);
        }
        // 62gX8 · 2kg x 2pz · 5ml x 300pz · 100 gr x 8
        if (preg_match("/{$num}\s*{$unit}\s*x\s*(\d+)/u", $n, $m) && (int) $m[3] > 1) {
            return $piece((int) $m[3], $f($m[1]), $m[2]);
        }
        // 5X1kg · 20X25g · 6x1,5l
        if (preg_match("/(?<![\d,.])(\d+)\s*x\s*{$num}\s*{$unit}/u", $n, $m) && (int) $m[1] > 1) {
            return $piece((int) $m[1], $f($m[2]), $m[3]);
        }
        // olio «pet2x5», «2x5 lt» senza unità → litri
        if (preg_match('/(?<![\d,.])(\d+)\s*x\s*(\d+(?:[.,]\d+)?)(?![\d,.]*\s*[a-z])/u', $n, $m) && preg_match('/olio|pet|tanica|latta|bott/u', $n)) {
            return ['mode' => 'conf', 'content' => $fmt((int) $m[1] * $f($m[2])), 'unit' => 'l', 'purchaseUnit' => $label, 'pieceKg' => null, 'density' => null, 'check' => 'Formato «'.$m[0].'» letto come '.$fmt((int) $m[1] * $f($m[2])).' litri: controlla.'];
        }
        // KG 10 · Kg1,790 (unità prima del numero)
        if (preg_match("/(?<![a-z0-9])(kg|kgm|lt|ltr)\.?\s*{$num}(?![\d,.]*\s*(?:kg|g|ml|cl|l|pz)\b)/u", $n, $m) && $f($m[2]) > 0) {
            return ['mode' => 'conf', 'content' => $fmt($f($m[2])), 'unit' => self::U[$m[1]], 'purchaseUnit' => self::pieceLabel($u, $label), 'pieceKg' => null, 'density' => null, 'check' => self::multiCheck($label, $u)];
        }
        // 500 ml · 1 kg · 30l · 800g · L1,5k
        if (preg_match_all("/(?<![a-z0-9]){$num}\s*{$unit}|(?<=[a-z.]){$num}\s*{$unit}/u", $n, $all, PREG_SET_ORDER)) {
            $m = end($all);
            $q = $m[1] !== '' ? $m[1] : $m[3];
            $un = $m[2] !== '' ? $m[2] : $m[4];
            if ($f($q) > 0) {
                return ['mode' => 'conf', 'content' => $fmt($f($q)), 'unit' => self::U[$un], 'purchaseUnit' => self::pieceLabel($u, $label), 'pieceKg' => null, 'density' => null, 'check' => self::multiCheck($label, $u)];
            }
        }
        // 1000PZ · 100bs · PZ.20 · X 90 · 10 ROTOLI · cart. 90pz
        if (preg_match('/(\d+)\s*(?:pz|pezzi|pcs|bs|bust[ei]ne?|buste|rotoli|fogli|str|strappi|porz|monoporzioni)(?![a-z])/u', $n, $m)
            || preg_match('/(?:pz|pezzi)\.?\s*(\d+)/u', $n, $m)
            || preg_match('/(?<![a-z])p\s*(\d+)(?![\d])/u', $n, $m)
            || preg_match('/(?<![a-z0-9])x\s*(\d+)\s*$/u', trim($n), $m)) {
            if ((int) $m[1] > 1) {
                return ['mode' => 'conf', 'content' => (string) (int) $m[1], 'unit' => 'pz', 'purchaseUnit' => $label, 'pieceKg' => null, 'density' => null, 'check' => null];
            }
        }

        // venduto a pezzo (mazzo di basilico, avocado): 1 pezzo va bene; cartoni e scatole senza formato vanno controllati
        return ['mode' => 'conf', 'content' => '1', 'unit' => 'pz', 'purchaseUnit' => self::pieceLabel($u, $label), 'pieceKg' => null, 'density' => null,
            'check' => $pieceUm ? null : 'Formato non indicato nel nome: preso come 1 pezzo ('.($um !== '' ? 'U.M. '.$um : 'U.M. vuota').').'];
    }

    /** cartone o confezione con il formato di un solo pezzo (es. «Coca Cola latt 33 cl» a CF): probabilmente sono più pezzi */
    private static function multiCheck(string $label, string $u): ?string
    {
        return in_array($label, ['cartone', 'scatola'], true) || str_starts_with($u, 'cf') || str_starts_with($u, 'conf')
            ? 'U.M. '.mb_strtoupper($u).' con il formato di un solo pezzo: quanti pezzi ci sono nella '.($label === 'confezione' ? 'confezione' : $label).'?'
            : null;
    }

    /** @return array{0: float, 1: string}|null primo formato «numero + unità» nel nome */
    private static function firstSize(string $n): ?array
    {
        return preg_match('/(\d+(?:[.,]\d+)?)\s*(kg|k|kgm|grammi|gr|g|litri|ltr|lt|l|ml|cl)(?![a-wyz])/u', $n, $m) ? [(float) str_replace(',', '.', $m[1]), $m[2]] : null;
    }

    private static function pieceLabel(string $u, string $label): string
    {
        return in_array($u, ['pz', 'n', 'nr', 'num', 'pezzi', 'pezzo'], true) ? 'pezzo' : $label;
    }

    public static function nonFoodName(string $name): bool
    {
        $n = ' '.mb_strtolower($name).' ';
        foreach (self::NON_FOOD as $w) {
            if (str_contains($n, $w)) {
                return true;
            }
        }

        return false;
    }

    /** Categoria proposta per un prodotto nuovo. */
    public static function category(string $name, string $supplier, bool $nonFood): string
    {
        $n = ' '.mb_strtolower($name).' ';
        $s = mb_strtolower($supplier);
        if ($nonFood) {
            return preg_match('/detersiv|sgrassa|candeggina|cif|svelto|pavimenti|lavastoviglie|brillantante|sapone|anticalcare|disinfett|sanific|ammorbid|panno|spugn|guanti/u', $n) ? 'Pulizia' : (preg_match('/legna|pellet|carbone|accendi/u', $n) ? 'Combustibili' : 'Materiale di consumo');
        }
        $rules = [
            'Gelati e dolci' => '/gelat|maxibon|coppa del nonno|cornetto|brownie|tiramis|torta|tartufo|semifredd|sorbett|pannacotta|cheesecake|nuii|magnum|biscott|cioc|extreme|ghiacciol|cono |coni |dlf |rdb /u',
            'Bevande' => '/birra|vino|prosecco|coca|aranciata|acqua |acqua$|chinotto|tonica|succo|spumante|aperol|campari|premix|redbull|red bull|the |tè /u',
            'Caffè' => '/caff|ginseng|orzo/u',
            'Pesce' => '/branzin|orata|calamar|spada|gamb|tonno|salmone|polpo|cozze|vongol|seppi|merluzz|baccal|acciugh|alici|tartare|totan|scampi|pesce|mazzancoll|surimi|sgombr/u',
            'Salumi' => '/prosciutt|salame|bresaola|pancetta|guancial|mortadell|speck|coppa|capocollo|lardo|nduja|wurstel|cotto/u',
            'Carne' => '/bov|suin|pollo|tacchin|vitell|manzo|agnell|maiale|hamburger|salsicc|costat|filetto|fesa|macinat|impasto|polpett|straccett|rolatin|spiedin|cotolett|arrosto|porchett|scottona/u',
            'Formaggi e latticini' => '/mozzarell|fior di latte|burrat|biraghi|stracciat|ricotta|grana|parmigian|pecorin|gorgonzol|provola|scamorz|brie|philadelphia|formagg|panna|latte|burro|mascarpone|yogurt|emmental|fontina|asiago|taleggio|edamer|cheddar|alpigiana/u',
            'Uova' => '/uova|uovo/u',
            'Farine e lieviti' => '/farina|semola|lievito|amido|fecola|pangrattato/u',
            'Pasta e riso' => '/pasta|spaghett|penne|rigaton|fusill|lasagn|gnocch|tortell|ravioli|agnolott|tagliatell|orecchiett|paccheri|riso |riso$|carnaroli|basmati|cous/u',
            'Olio e aceto' => '/olio|aceto|glassa/u',
            'Spezie e aromi' => '/pepe|zafferano|origano|rosmarino|salvia|curry|paprika|cannella|noce moscata|sale |sale$|peperoncino|timo|alloro|vaniglia/u',
            'Conserve e salse' => '/polpa|passata|pelati|pomodorini|conserv|paccatell|ketchup|maionese|senape|salsa|sugo|pesto|confettura|marmellat|crema di|capper|olive|carciofini|sottolio|sottaceto|tonno/u',
            'Pane e prodotti da forno' => '/pane|panbrioche|grissin|crackers|focacc|bun |piad|taralli|fette biscott/u',
            'Frutta secca e semi' => '/noci|mandorl|pistacch|nocciol|pinoli|anacard|arachid|semi /u',
            'Zucchero e miele' => '/zucchero|miele|dolcific|sciroppo/u',
            'Frutta e verdura' => '/friariell|mais|ceci|fagiol|lenticch|piselli|spinaci|melanzan|zucchin|peperon|carciof|funghi|patat|cipoll|aglio|insalata|rucola|basilico|limon|aranc|mele |pere |banan|fragol|frutti di bosco|mirtill|pomodor|pomo /u',
            'Surgelati' => '/surgel|frozen|congel/u',
        ];
        if (str_contains($s, 'ortofrutta') || str_contains($s, 'sial')) {
            return 'Frutta e verdura';
        }
        foreach ($rules as $cat => $re) {
            if (preg_match($re, $n)) {
                return $cat;
            }
        }
        if (str_contains($s, 'ortofrutta') || str_contains($s, 'sial')) {
            return 'Frutta e verdura';
        }
        if (str_contains($s, 'cogea')) {
            return 'Gelati e dolci';
        }
        if (str_contains($s, 'pasta')) {
            return 'Pasta e riso';
        }

        return 'Altro';
    }

    /* ----------------------------- anteprima ----------------------------- */

    /** @param list<array> $rows */
    public static function analyze(string $companyId, array $rows): array
    {
        $existing = DB::table('ingredients')->where('company_id', $companyId)->whereNull('archived_at')
            ->get(['id', 'code', 'name', 'category', 'supplier', 'purchase_unit', 'package_content', 'package_unit', 'unit_weight_kg', 'density_kg_per_l', 'non_food']);
        $byCode = [];
        $byNameSup = [];
        $byName = [];
        $supNames = [];
        foreach ($existing as $e) {
            $byCode[mb_strtolower($e->code)] = $e;
            $nk = self::nameKey($e->name);
            $sk = self::supplierKey((string) $e->supplier);
            $byNameSup[$nk][] = ['sk' => $sk, 'e' => $e];
            $byName[$nk][] = $e;
            if ($e->supplier) {
                $supNames[$sk][$e->supplier] = ($supNames[$sk][$e->supplier] ?? 0) + 1;
            }
        }
        // fornitori: varianti raggruppate, nome già usato nel portale se c'è, altrimenti il più frequente nel file
        $variants = [];
        foreach ($rows as $r) {
            if ($r['supplier'] === '') {
                continue;
            }
            $k = self::supplierKey($r['supplier']);
            $found = null;
            foreach (array_keys($variants) as $vk) {
                if (self::sameSupplier($vk, $k)) {
                    $found = $vk;
                    break;
                }
            }
            $found ??= $k;
            $variants[$found][$r['supplier']] = ($variants[$found][$r['supplier']] ?? 0) + 1;
        }
        $canon = [];
        $merges = [];
        foreach ($variants as $vk => $names) {
            arsort($names);
            $pick = array_key_first($names);
            foreach ($supNames as $sk => $used) {
                if (self::sameSupplier($sk, $vk)) {
                    arsort($used);
                    $pick = array_key_first($used);
                    break;
                }
            }
            $canon[$vk] = $pick;
            if (count($names) > 1 || ! isset($names[$pick])) {
                $merges[] = ['name' => $pick, 'variants' => array_keys($names), 'rows' => array_sum($names)];
            }
        }
        $canonOf = function (string $s) use ($canon) {
            $k = self::supplierKey($s);
            foreach ($canon as $vk => $name) {
                if (self::sameSupplier($vk, $k)) {
                    return [$vk, $name];
                }
            }

            return [$k, $s];
        };

        $catMap = NonFood::categoryMap($companyId);
        $products = [];
        $skipped = 0;
        $discounted = 0;
        foreach ($rows as $r) {
            if ($r['price'] === null || $r['name'] === '') {
                $skipped++;

                continue;
            }
            [$sk, $supplier] = $canonOf($r['supplier']);
            $nk = self::nameKey($r['name']);
            $code = self::articleCode($r['name']);
            $key = $sk.'|'.$nk;
            $d = self::discounts($r['discount']);
            if ($d) {
                $discounted++;
            }
            $net = self::applyDiscounts($r['price'], $d);
            if (! isset($products[$key])) {
                $pack = self::pack($r['um'], $r['name']);
                // abbinamento: codice MARR, poi nome + fornitore, poi nome se unico
                $match = null;
                if ($code && isset($byCode['marr-'.$code])) {
                    $match = $byCode['marr-'.$code];
                }
                if (! $match) {
                    foreach ($byNameSup[$nk] ?? [] as $c) {
                        if (self::sameSupplier($c['sk'], $sk)) {
                            $match = $c['e'];
                            break;
                        }
                    }
                }
                if (! $match && count($byName[$nk] ?? []) === 1 && ! ($byName[$nk][0]->supplier ?? null)) {
                    $match = $byName[$nk][0];
                }
                $nameNonFood = self::nonFoodName($r['name']);
                $category = $match && $match->category ? $match->category : self::category($r['name'], $supplier, $nameNonFood);
                $catNonFood = NonFood::isCategory($companyId, $category, $catMap) || (! isset($catMap[mb_strtolower($category)]) && NonFood::guess($category));
                $products[$key] = [
                    'key' => $key, 'existingId' => $match?->id, 'code' => $match?->code ?? ($code ? 'MARR-'.$code : null),
                    'name' => $match?->name ?? self::cleanName($r['name']), 'supplier' => $supplier, 'um' => $r['um'],
                    ...$pack,
                    'category' => $category,
                    'nonFood' => $match && $match->non_food !== null ? (bool) $match->non_food : ($nameNonFood || $catNonFood),
                    'nonFoodOverride' => $nameNonFood && ! $catNonFood,
                    'before' => $match ? ['purchaseUnit' => $match->purchase_unit, 'content' => Dec::of($match->package_content)->toFixed(), 'unit' => $match->package_unit] : null,
                    'prices' => [],
                    'note' => null,
                ];
                if ($match && $pack['pieceKg'] === null && $match->unit_weight_kg !== null) {
                    $products[$key]['pieceKg'] = Dec::of($match->unit_weight_kg)->toFixed();
                }
                // formato incerto dal listino ma il prodotto esiste già: si tiene quello registrato (magari corretto a mano)
                if ($match && $pack['check'] && $pack['mode'] === 'conf') {
                    $content = Dec::of($match->package_content)->toFixed();
                    $isKg = $content === '1' && $match->package_unit === 'kg';
                    $isL = $content === '1' && $match->package_unit === 'l';
                    $products[$key] = [...$products[$key], 'mode' => $isKg ? 'kg' : ($isL ? 'l' : 'conf'), 'content' => $content, 'unit' => $match->package_unit,
                        'purchaseUnit' => $match->purchase_unit, 'density' => $match->density_kg_per_l !== null ? Dec::of($match->density_kg_per_l)->toFixed() : null,
                        'check' => null, 'note' => 'Formato già registrato tenuto: '.$content.' '.$match->package_unit.'.'];
                }
            }
            $date = $r['date'] ?? now('Europe/Rome')->format('Y-m-d');
            $prev = $products[$key]['prices'][$date] ?? null;
            if ($prev && Dec::of($prev['net'])->toFixed(4) !== Dec::of($net)->toFixed(4)) {
                $products[$key]['check'] ??= 'Due prezzi diversi nello stesso giorno: tenuto il più basso.';
                if (Dec::of($net)->gte(Dec::of($prev['net']))) {
                    continue;
                }
            }
            if ($d && Dec::of($net)->lt(Dec::of($r['price'])->times(Dec::of('0.65')))) {
                $products[$key]['check'] ??= 'Sconto alto ('.implode('+', $d).'%): controlla che il prezzo netto sia giusto.';
            }
            $products[$key]['prices'][$date] = ['date' => $date, 'gross' => Dec::of($r['price'])->toFixed(), 'discount' => implode('+', $d), 'net' => Dec::of($net)->toFixed(4), 'row' => $r['row']];
        }
        $list = [];
        foreach ($products as $p) {
            krsort($p['prices']);
            $p['prices'] = array_values($p['prices']);
            if ($p['nonFood']) {
                $p['pieceKg'] = null; // materiale non alimentare: il peso non serve
                $p['density'] = null;
            }
            if ($p['check'] && $p['nonFood'] && str_starts_with($p['check'], 'Formato non indicato')) {
                $p['check'] = null; // materiale non alimentare: 1 pezzo va bene così
            }
            $list[] = $p;
        }
        usort($list, fn ($a, $b) => strcasecmp($a['name'], $b['name']));

        return [
            'summary' => [
                'rows' => count($rows), 'skipped' => $skipped, 'products' => count($list),
                'new' => count(array_filter($list, fn ($p) => ! $p['existingId'])), 'update' => count(array_filter($list, fn ($p) => (bool) $p['existingId'])),
                'check' => count(array_filter($list, fn ($p) => $p['check'])), 'discounted' => $discounted, 'prices' => array_sum(array_map(fn ($p) => count($p['prices']), $list)),
                'byMode' => ['kg' => count(array_filter($list, fn ($p) => $p['mode'] === 'kg')), 'l' => count(array_filter($list, fn ($p) => $p['mode'] === 'l')), 'conf' => count(array_filter($list, fn ($p) => $p['mode'] === 'conf'))],
            ],
            'suppliers' => $merges,
            'products' => $list,
        ];
    }

    public static function cleanName(string $name): string
    {
        $n = preg_replace('/^\s*\d{5,7}\s+/u', '', $name);

        return trim((string) $n);
    }
}
