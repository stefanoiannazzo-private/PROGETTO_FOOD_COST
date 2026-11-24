<?php

declare(strict_types=1);

namespace App\Services\Invoices;

use App\Domain\Costing\Dec;
use App\Support\AppError;
use DOMDocument;
use DOMElement;
use DOMXPath;
use ZipArchive;

/**
 * NUOVO — Lettura delle fatture elettroniche dei fornitori (tracciato FatturaPA/SDI).
 *
 * Accetta .xml, .xml.p7m (firmato CAdES, anche in base64) e .zip (anche annidati, come quelli
 * scaricati dal cassetto fiscale). Un file può contenere più fatture (più FatturaElettronicaBody).
 * Nessuna chiamata esterna: tutto avviene sul server.
 */
final class FatturaPA
{
    private const MAX_FILES = 200;

    private const MAX_XML_BYTES = 8 * 1024 * 1024;

    /**
     * Estrae i documenti XML da un file caricato.
     *
     * @return list<array{name: string, xml?: string, error?: string}>
     */
    public static function extract(string $bytes, string $name, int $depth = 0): array
    {
        $lower = mb_strtolower($name);
        if (str_starts_with($bytes, "PK\x03\x04") || str_ends_with($lower, '.zip')) {
            return self::fromZip($bytes, $name, $depth);
        }
        // file di metadati dello SDI e ricevute: non sono fatture. Dentro uno .zip si saltano in silenzio,
        // caricati da soli si spiega quale file serve (prima venivano scartati senza alcun messaggio).
        $sdi = self::sdiMessage($bytes);
        if ($sdi !== null || preg_match('/_(MT|RC|NS|MC|NE|DT|AT|EC|SE)_\d+\.xml$/i', $name)) {
            if ($depth > 0) {
                return [];
            }
            $file = $sdi['file'] ?? null;

            return [['name' => $name, 'error' => ($sdi['label'] ?? 'Questo è un file di servizio dello SDI')
                .', non la fattura. Carica il file della fattura'.($file ? " «{$file}»" : ' (di solito termina con .xml.p7m o .xml)').'.']];
        }
        $xml = self::toXml($bytes);
        if ($xml === null) {
            return [['name' => $name, 'error' => 'Non è una fattura elettronica leggibile (serve il file .xml o .xml.p7m).']];
        }

        return [['name' => $name, 'xml' => $xml]];
    }

    /** @return list<array{name: string, xml?: string, error?: string}> */
    private static function fromZip(string $bytes, string $name, int $depth): array
    {
        if ($depth > 2) {
            return [];
        }
        if (! class_exists(ZipArchive::class)) {
            return [['name' => $name, 'error' => 'Il server non può aprire i file .zip: carica i singoli .xml.']];
        }
        $tmp = tempnam(sys_get_temp_dir(), 'fpa');
        file_put_contents($tmp, $bytes);
        $zip = new ZipArchive;
        $out = [];
        try {
            if ($zip->open($tmp) !== true) {
                return [['name' => $name, 'error' => 'Archivio .zip non valido.']];
            }
            for ($i = 0; $i < $zip->numFiles && count($out) < self::MAX_FILES; $i++) {
                $st = $zip->statIndex($i);
                $entry = (string) ($st['name'] ?? '');
                if ($entry === '' || str_ends_with($entry, '/') || str_contains($entry, '__MACOSX') || ($st['size'] ?? 0) > self::MAX_XML_BYTES) {
                    continue;
                }
                $base = basename($entry);
                $l = mb_strtolower($base);
                if (! (str_ends_with($l, '.xml') || str_ends_with($l, '.p7m') || str_ends_with($l, '.zip'))) {
                    continue;
                }
                $content = $zip->getFromIndex($i);
                if ($content === false) {
                    continue;
                }
                array_push($out, ...self::extract($content, $base, $depth + 1));
            }
            $zip->close();
        } finally {
            @unlink($tmp);
        }

        return $out === [] ? [['name' => $name, 'error' => 'Nell’archivio non ci sono fatture .xml o .p7m.']] : $out;
    }

    /**
     * Riconosce i messaggi dello SDI (metadati, ricevute, notifiche) dal contenuto.
     *
     * @return array{label: string, file: ?string}|null
     */
    private static function sdiMessage(string $bytes): ?array
    {
        $head = substr(self::stripBom($bytes), 0, 4000);
        if (! str_starts_with(ltrim($head), '<') || ! preg_match('/<(?:[A-Za-z0-9_]+:)?(FileMetadati|RicevutaConsegna|NotificaScarto|NotificaMancataConsegna|NotificaEsito|NotificaDecorrenzaTermini|AttestazioneTrasmissioneFattura|NotificaEsitoCommittente|ScartoEsitoCommittente)\b/', $head, $m)) {
            return null;
        }
        $label = $m[1] === 'FileMetadati' ? 'Questo è il file dei metadati dello SDI' : 'Questa è una ricevuta o notifica dello SDI';
        $file = preg_match('/<NomeFile>\s*([^<\s]+)\s*<\/NomeFile>/', $head, $f) ? $f[1] : null;

        return ['label' => $label, 'file' => $file];
    }

    /** XML in chiaro da .xml, .p7m binario o .p7m in base64. */
    public static function toXml(string $bytes): ?string
    {
        $bytes = self::stripBom($bytes);
        if (self::looksLikeInvoice($bytes) && ! self::isDer($bytes)) {
            return $bytes;
        }
        // .p7m salvato in base64
        $trim = trim($bytes);
        if (! self::isDer($bytes) && preg_match('/^[A-Za-z0-9+\/=\r\n]+$/', $trim)) {
            $dec = base64_decode(preg_replace('/\s+/', '', $trim), true);
            if ($dec !== false) {
                $bytes = $dec;
            }
        }
        if (self::isDer($bytes)) {
            $xml = self::unwrapP7m($bytes);

            return $xml !== null && self::looksLikeInvoice($xml) ? $xml : null;
        }

        return null;
    }

    private static function isDer(string $b): bool
    {
        return $b !== '' && $b[0] === "\x30";
    }

    private static function stripBom(string $b): string
    {
        return str_starts_with($b, "\xEF\xBB\xBF") ? substr($b, 3) : $b;
    }

    private static function looksLikeInvoice(string $b): bool
    {
        return stripos($b, 'FatturaElettronica') !== false && stripos($b, 'FatturaElettronicaBody') !== false;
    }

    /** Contenuto di una busta CAdES (.p7m): prima con OpenSSL, poi leggendo la struttura DER a mano. */
    private static function unwrapP7m(string $der): ?string
    {
        if (function_exists('openssl_cms_verify')) {
            $in = tempnam(sys_get_temp_dir(), 'p7m');
            $out = tempnam(sys_get_temp_dir(), 'xml');
            file_put_contents($in, $der);
            try {
                // NOVERIFY: interessa il contenuto, non la validità della firma
                $ok = @openssl_cms_verify($in, OPENSSL_CMS_NOVERIFY | OPENSSL_CMS_BINARY, null, [], null, $out, null, null, OPENSSL_ENCODING_DER);
                $xml = $ok ? (string) file_get_contents($out) : '';
                if ($xml !== '') {
                    return self::stripBom($xml);
                }
            } finally {
                @unlink($in);
                @unlink($out);
            }
        }

        return self::derContent($der);
    }

    /** Lettura minima DER/BER: concatena gli OCTET STRING (anche spezzati) che contengono l'XML. */
    private static function derContent(string $der): ?string
    {
        $chunks = [];
        $walk = function (int $pos, int $end) use (&$walk, $der, &$chunks): void {
            while ($pos < $end && $pos < strlen($der)) {
                $tag = ord($der[$pos]);
                if ($tag === 0 && isset($der[$pos + 1]) && ord($der[$pos + 1]) === 0) {
                    return; // fine contenuto a lunghezza indefinita
                }
                $pos++;
                $lenByte = ord($der[$pos] ?? "\0");
                $pos++;
                $indef = false;
                if ($lenByte === 0x80) {
                    $indef = true;
                    $len = $end - $pos;
                } elseif ($lenByte & 0x80) {
                    $n = $lenByte & 0x7F;
                    $len = 0;
                    for ($i = 0; $i < $n; $i++) {
                        $len = ($len << 8) | ord($der[$pos + $i] ?? "\0");
                    }
                    $pos += $n;
                } else {
                    $len = $lenByte;
                }
                $constructed = ($tag & 0x20) !== 0;
                if ($constructed) {
                    $walk($pos, $indef ? $end : $pos + $len);
                    if ($indef) {
                        return;
                    }
                } elseif ($tag === 0x04) {
                    $chunks[] = substr($der, $pos, $len);
                }
                $pos += $len;
            }
        };
        $walk(0, strlen($der));
        $all = implode('', $chunks);
        $start = strpos($all, '<');
        if ($start === false) {
            return null;
        }
        $all = substr($all, $start);
        if (preg_match('/<\/(?:[A-Za-z0-9_]+:)?FatturaElettronica>/', $all, $m, PREG_OFFSET_CAPTURE)) {
            $all = substr($all, 0, $m[0][1] + strlen($m[0][0]));
        }

        return $all;
    }

    /**
     * Fatture contenute in un XML (una per ogni FatturaElettronicaBody).
     *
     * @return list<array<string, mixed>>
     */
    public static function parse(string $xml): array
    {
        if (strlen($xml) > self::MAX_XML_BYTES) {
            throw AppError::badRequest('invoice_too_large', 'Fattura troppo grande.');
        }
        if (preg_match('/<!DOCTYPE|<!ENTITY/i', $xml)) {
            throw AppError::badRequest('invoice_invalid', 'Il file contiene costrutti XML non ammessi.');
        }
        $doc = new DOMDocument;
        $prev = libxml_use_internal_errors(true);
        $ok = $doc->loadXML($xml, LIBXML_NONET | LIBXML_COMPACT | LIBXML_PARSEHUGE);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);
        if (! $ok) {
            throw AppError::badRequest('invoice_invalid', 'XML non valido.');
        }
        $xp = new DOMXPath($doc);
        $root = $doc->documentElement;
        if (! $root || $root->localName !== 'FatturaElettronica') {
            throw AppError::badRequest('invoice_invalid', 'Non è una fattura elettronica (manca FatturaElettronica).');
        }
        $q = fn (string $path, ?\DOMNode $ctx = null): ?string => self::text($xp, $path, $ctx ?? $root);

        $seller = self::el($xp, 'FatturaElettronicaHeader/CedentePrestatore', $root);
        $supplierName = $q('DatiAnagrafici/Anagrafica/Denominazione', $seller)
            ?? trim(($q('DatiAnagrafici/Anagrafica/Nome', $seller) ?? '').' '.($q('DatiAnagrafici/Anagrafica/Cognome', $seller) ?? ''));
        $vat = ($q('DatiAnagrafici/IdFiscaleIVA/IdPaese', $seller) ?? '').($q('DatiAnagrafici/IdFiscaleIVA/IdCodice', $seller) ?? '');
        if ($vat === '') {
            $vat = $q('DatiAnagrafici/CodiceFiscale', $seller) ?? '';
        }
        $buyer = self::el($xp, 'FatturaElettronicaHeader/CessionarioCommittente', $root);
        $buyerVat = ($q('DatiAnagrafici/IdFiscaleIVA/IdPaese', $buyer) ?? '').($q('DatiAnagrafici/IdFiscaleIVA/IdCodice', $buyer) ?? '');

        $out = [];
        foreach (self::els($xp, 'FatturaElettronicaBody', $root) as $body) {
            $g = self::el($xp, 'DatiGenerali/DatiGeneraliDocumento', $body);
            $lines = [];
            foreach (self::els($xp, 'DatiBeniServizi/DettaglioLinee', $body) as $l) {
                $lines[] = self::line($xp, $l);
            }
            $out[] = [
                'supplierName' => mb_substr(trim((string) $supplierName) ?: 'Fornitore senza nome', 0, 120),
                'supplierVat' => mb_substr(strtoupper(preg_replace('/\s+/', '', $vat) ?? ''), 0, 30),
                'buyerVat' => strtoupper($buyerVat),
                'docType' => $q('TipoDocumento', $g),
                'number' => mb_substr($q('Numero', $g) ?? '', 0, 40),
                'date' => self::date($q('Data', $g)),
                'currency' => $q('Divisa', $g) ?? 'EUR',
                'total' => self::dec($q('ImportoTotaleDocumento', $g)),
                'lines' => $lines,
            ];
        }
        if ($out === []) {
            throw AppError::badRequest('invoice_invalid', 'La fattura non contiene righe.');
        }

        return $out;
    }

    /** @return array<string, mixed> */
    private static function line(DOMXPath $xp, DOMElement $l): array
    {
        $q = fn (string $p) => self::text($xp, $p, $l);
        $qty = self::dec($q('Quantita'));
        $unitPrice = self::dec($q('PrezzoUnitario'));
        $total = self::dec($q('PrezzoTotale'));
        $um = $q('UnitaMisura');
        $desc = preg_replace('/\s+/', ' ', trim($q('Descrizione') ?? '')) ?? '';
        $code = null;
        foreach (self::els($xp, 'CodiceArticolo', $l) as $c) {
            $v = self::text($xp, 'CodiceValore', $c);
            if ($v !== null && $v !== '') {
                $code = mb_substr($v, 0, 60);
                break;
            }
        }
        $kind = $q('TipoCessionePrestazione'); // SC sconto, PR premio, AB abbuono, AC spesa accessoria
        // prezzo netto della singola unità: il totale riga comprende sconti e maggiorazioni
        $net = null;
        if ($total !== null && $qty !== null && Dec::of($qty)->gt(Dec::of('0'))) {
            $net = Dec::of($total)->div(Dec::of($qty))->toFixed(6);
        } elseif ($unitPrice !== null) {
            $net = $unitPrice;
        }
        $guess = self::guess($um, $desc);
        $skip = $kind !== null || $net === null || Dec::of($net)->lte(Dec::of('0')) || $desc === '';

        return [
            'n' => (int) ($q('NumeroLinea') ?? 0),
            'code' => $code,
            'description' => mb_substr($desc, 0, 1000),
            'quantity' => $qty,
            'um' => $um !== null ? mb_substr($um, 0, 20) : null,
            'unitPrice' => $unitPrice,
            'netUnitPrice' => $net,
            'total' => $total,
            'vat' => self::dec($q('AliquotaIVA')),
            'kind' => $kind,
            'skip' => $skip,
            ...$guess,
        ];
    }

    /**
     * Modalità di acquisto dedotta da unità di misura e descrizione:
     * KG → al kg, LT → al litro, N/NR/PZ/CF/CT… → a confezione (con il contenuto, se scritto nella descrizione).
     *
     * @return array{mode: string, packageContent: ?string, packageUnit: ?string}
     */
    public static function guess(?string $um, string $desc): array
    {
        $u = strtoupper(preg_replace('/[^A-Za-z]/', '', (string) $um) ?? '');
        $mode = match (true) {
            in_array($u, ['KG', 'KGM', 'KGS', 'KGR', 'CHILOGRAMMI', 'CHILI', 'KILO', 'KILOGRAMMI', 'K'], true) => 'kg',
            in_array($u, ['LT', 'L', 'LTR', 'LITRI', 'LITRO', 'LI'], true) => 'l',
            default => 'conf',
        };
        $content = null;
        $unit = null;
        if ($mode === 'conf' && preg_match('/(\d+(?:[.,]\d+)?)\s*(KG|KGM|GR|G|ML|CL|LT|L)\b/i', $desc, $m)) {
            $content = str_replace(',', '.', $m[1]);
            $unit = match (strtoupper($m[2])) {
                'KG', 'KGM' => 'kg',
                'GR', 'G' => 'g',
                'ML' => 'ml',
                'CL' => 'cl',
                default => 'l',
            };
            // "6X1L", "12 x 500 ML": confezione multipla
            if (preg_match('/(\d+)\s*[xX]\s*'.preg_quote($m[0], '/').'/', $desc, $mm) && (int) $mm[1] > 1) {
                $content = Dec::of($content)->times(Dec::of($mm[1]))->toFixed();
            }
            if (! (float) $content) {
                $content = null;
                $unit = null;
            }
        }

        return ['mode' => $mode, 'packageContent' => $content, 'packageUnit' => $unit];
    }

    private static function el(DOMXPath $xp, string $path, \DOMNode $ctx): ?DOMElement
    {
        $n = self::els($xp, $path, $ctx);

        return $n[0] ?? null;
    }

    /** @return list<DOMElement> */
    private static function els(DOMXPath $xp, string $path, ?\DOMNode $ctx): array
    {
        if ($ctx === null) {
            return [];
        }
        $expr = implode('/', array_map(fn ($s) => "*[local-name()='{$s}']", explode('/', $path)));
        $res = $xp->query($expr, $ctx);
        $out = [];
        if ($res) {
            foreach ($res as $n) {
                if ($n instanceof DOMElement) {
                    $out[] = $n;
                }
            }
        }

        return $out;
    }

    private static function text(DOMXPath $xp, string $path, ?\DOMNode $ctx): ?string
    {
        $e = $ctx ? self::el($xp, $path, $ctx) : null;
        if (! $e) {
            return null;
        }
        $t = trim($e->textContent);

        return $t === '' ? null : $t;
    }

    private static function dec(?string $v): ?string
    {
        if ($v === null || ! preg_match('/^-?\d+(\.\d+)?$/', $v)) {
            return null;
        }

        return Dec::of($v)->toFixed();
    }

    private static function date(?string $v): ?string
    {
        return $v !== null && preg_match('/^(\d{4}-\d{2}-\d{2})/', $v, $m) ? $m[1] : null;
    }
}
