<?php

declare(strict_types=1);

namespace App\Services;

use Smalot\PdfParser\Config;
use Smalot\PdfParser\Parser;

/**
 * NUOVO — Lettura "locale" di una bolletta: estrae il testo dal PDF sul server (nessun servizio esterno)
 * e cerca i dati con regole sulle diciture standard delle bollette italiane (ARERA: "Bolletta 2.0" e
 * "bolletta trasparente" dal 2024). Funziona solo con PDF digitali, non con foto o scansioni.
 *
 * Restituisce lo stesso formato di BillReader::read(), così la normalizzazione e l'interfaccia sono comuni.
 */
final class LocalBillReader
{
    /** @throws \RuntimeException con un messaggio per l'utente */
    public static function text(string $pdf): string
    {
        try {
            $cfg = new Config;
            $cfg->setRetainImageContent(false);
            $cfg->setDecodeMemoryLimit(64 * 1024 * 1024);
            $text = (new Parser([], $cfg))->parseContent($pdf)->getText();
        } catch (\Throwable $e) {
            throw new \RuntimeException('Il PDF non può essere letto (protetto da password o danneggiato): compila i dati a mano.');
        }
        $text = self::clean($text);
        if (mb_strlen(preg_replace('/\s+/u', '', $text) ?? '') < 80) {
            throw new \RuntimeException('Il PDF non contiene testo (è una scansione o una foto): compila i dati a mano.');
        }

        return $text;
    }

    /** @return array<string,mixed> */
    public static function read(string $pdf): array
    {
        return self::parse(self::text($pdf));
    }

    /** @return array<string,mixed> */
    public static function parse(string $text): array
    {
        $t = self::clean($text);
        $low = mb_strtolower($t);
        $kind = self::utility($low);
        [$from, $to] = self::period($t);
        [$consumption, $unit, $estimated] = self::consumption($t, $kind);
        $components = self::components($t, $kind);

        return [
            'e_una_bolletta' => $kind !== null || $components !== [] || $consumption !== null,
            'tipo_utenza' => $kind,
            'fornitore' => self::supplier($low),
            'numero_fattura' => self::match($t, '/(?:fattura|bolletta|documento)\s*(?:n\.?|nr\.?|numero|num\.?)\s*[:°º]?\s*([A-Z0-9][A-Z0-9\/\-.]{3,30})/iu'),
            'data_emissione' => self::date(self::match($t, '/(?:emess[ao]\s+il|data\s+(?:di\s+)?emissione|del)\s*[:]?\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{1,2}\s+[a-zà]+\s+\d{4})/iu')),
            'periodo_dal' => $from,
            'periodo_al' => $to,
            'consumo' => $consumption,
            'unita_consumo' => $unit,
            'consumo_stimato' => $estimated,
            'coefficiente_c' => $kind === 'gas' ? self::number(self::match($t, '/coefficiente\s*(?:di\s+conversione\s*)?(?:\(?\s*c\s*\)?)\s*[:=]?\s*(\d+[,.]\d{3,6})/iu')) : null,
            'pcs_gj_smc' => $kind === 'gas' ? self::number(self::match($t, '/(?:pcs|potere\s+calorifico\s+superiore)[^0-9]{0,40}(0[,.]0\d{3,6})/iu')) : null,
            'voci' => $components,
            'imponibile_totale' => self::amountAfter($t, ['totale imponibile', 'imponibile totale', 'totale imponibile iva', 'imponibile']),
            'aliquota_iva' => self::number(self::match($t, '/iva\s*(?:al\s*)?(10|22|5)\s*%/iu')),
            'totale_da_pagare' => self::amountAfter($t, ['totale da pagare', 'importo da pagare', 'totale bolletta', 'totale fattura', 'totale documento', 'totale dovuto']),
            'note' => null,
        ];
    }

    /* ----------------------------------------------------------------------------------------- */

    private const MONTHS = ['gennaio' => 1, 'febbraio' => 2, 'marzo' => 3, 'aprile' => 4, 'maggio' => 5, 'giugno' => 6, 'luglio' => 7, 'agosto' => 8, 'settembre' => 9, 'ottobre' => 10, 'novembre' => 11, 'dicembre' => 12,
        'gen' => 1, 'feb' => 2, 'mar' => 3, 'apr' => 4, 'mag' => 5, 'giu' => 6, 'lug' => 7, 'ago' => 8, 'set' => 9, 'ott' => 10, 'nov' => 11, 'dic' => 12];

    private const SUPPLIERS = [
        'enel energia' => 'Enel Energia', 'servizio elettrico nazionale' => 'Servizio Elettrico Nazionale', 'a2a energia' => 'A2A Energia', 'hera comm' => 'Hera Comm',
        'edison energia' => 'Edison Energia', 'plenitude' => 'Plenitude (Eni)', 'eni gas e luce' => 'Eni gas e luce', 'iren mercato' => 'Iren', 'acea energia' => 'Acea Energia',
        'sorgenia' => 'Sorgenia', 'engie' => 'Engie', 'e.on' => 'E.ON', 'illumia' => 'Illumia', 'axpo' => 'Axpo', 'duferco' => 'Duferco Energia', 'iberdrola' => 'Iberdrola',
        'estra' => 'Estra', 'agsm aim' => 'AGSM AIM', 'dolomiti energia' => 'Dolomiti Energia', 'alperia' => 'Alperia', 'optima italia' => 'Optima Italia', 'wekiwi' => 'Wekiwi',
        'enegan' => 'Enegan', 'nen ' => 'NeN', 'pulsee' => 'Pulsee', 'octopus energy' => 'Octopus Energy', 'green network' => 'Green Network', 'bluenergy' => 'Bluenergy',
        'acquedotto pugliese' => 'Acquedotto Pugliese', 'publiacqua' => 'Publiacqua', 'smat' => 'SMAT', 'abbanoa' => 'Abbanoa', 'gori' => 'GORI', 'acqualatina' => 'Acqualatina',
        'mm spa' => 'MM', 'acea ato' => 'Acea ATO', 'veritas' => 'Veritas', 'acque veronesi' => 'Acque Veronesi', 'gaia spa' => 'GAIA', 'acque spa' => 'Acque',
        'a2a' => 'A2A', 'hera' => 'Hera', 'iren' => 'Iren', 'enel' => 'Enel', 'edison' => 'Edison', 'acea' => 'Acea', 'eni' => 'Eni',
    ];

    /** Voci del riepilogo: [espressioni, descrizione, tipo, includi]. Le prime trovate vincono. */
    private const COMPONENTS = [
        [['spesa per la materia energia', 'spesa per la materia gas naturale', 'spesa per la materia gas', 'spesa per la vendita di energia elettrica', 'spesa per la vendita di gas naturale', 'spesa per la vendita'], 'Spesa per la materia / vendita', 'variable', true],
        [['spesa per la rete e gli oneri generali di sistema', 'spesa per la rete e oneri generali di sistema', 'spesa per la rete'], 'Rete e oneri generali di sistema', 'variable', true],
        [['spesa per il trasporto e la gestione del contatore', 'spesa per il trasporto e gestione del contatore', 'trasporto e gestione del contatore'], 'Trasporto e gestione del contatore', 'variable', true],
        [['spesa per oneri di sistema', 'oneri di sistema'], 'Oneri di sistema', 'variable', true],
        [['imposte', 'accise e addizionali', 'accisa', 'imposta erariale'], 'Imposte (accise)', 'variable', true],
        // acqua
        [['servizio acquedotto', 'quota acquedotto', 'acquedotto'], 'Acquedotto', 'variable', true],
        [['servizio fognatura', 'quota fognatura', 'fognatura'], 'Fognatura', 'variable', true],
        [['servizio depurazione', 'quota depurazione', 'depurazione'], 'Depurazione', 'variable', true],
        [['quota fissa'], 'Quota fissa', 'fixed', false],
        [['oneri di perequazione', 'componenti perequative', 'perequazione'], 'Oneri di perequazione', 'variable', true],
        // voci estranee al costo del periodo
        [['canone di abbonamento alla televisione', 'canone tv', 'canone rai'], 'Canone TV', 'fixed', false],
        [['ricalcoli', 'ricalcolo'], 'Ricalcoli di periodi precedenti', 'variable', false],
        [['altre partite'], 'Altre partite', 'variable', false],
        [['bonus sociale'], 'Bonus sociale', 'variable', false],
    ];

    private static function clean(string $t): string
    {
        $t = str_replace(["\u{00A0}", "\u{2007}", "\u{202F}", "\t", "\r"], [' ', ' ', ' ', ' ', "\n"], $t);
        $t = preg_replace('/[ ]{2,}/u', ' ', $t) ?? $t;

        return preg_replace('/\n{3,}/u', "\n\n", $t) ?? $t;
    }

    private static function utility(string $low): ?string
    {
        $score = [
            'electricity' => substr_count($low, 'kwh') + 3 * substr_count($low, 'energia elettrica') + 2 * substr_count($low, 'pod'),
            'gas' => 3 * substr_count($low, 'smc') + 3 * substr_count($low, 'gas naturale') + 2 * substr_count($low, 'pdr'),
            'water' => 3 * substr_count($low, 'servizio idrico') + 2 * substr_count($low, 'acquedotto') + substr_count($low, 'depurazione') + substr_count($low, 'fognatura'),
        ];
        arsort($score);
        $best = array_key_first($score);

        return $score[$best] > 0 ? $best : null;
    }

    private static function supplier(string $low): ?string
    {
        $found = [];
        foreach (self::SUPPLIERS as $needle => $name) {
            if (preg_match('/(?<![a-z])'.preg_quote(trim($needle), '/').'(?![a-z])/u', $low, $m, PREG_OFFSET_CAPTURE)) {
                $found[] = [$name, $m[0][1], mb_strlen($needle)];
            }
        }
        if (! $found) {
            return null;
        }
        // il nome nell'intestazione (prime righe) vince; poi il più specifico (più lungo), poi il primo
        usort($found, fn ($a, $b) => [$a[1] >= 2500, -$a[2], $a[1]] <=> [$b[1] >= 2500, -$b[2], $b[1]]);

        return $found[0][0];
    }

    /** @return array{0:?string,1:?string} */
    private static function period(string $t): array
    {
        $d = '(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|\d{1,2}\s+[a-zà]{3,9}\.?\s+\d{4})';
        $patterns = [
            '/periodo\s+(?:di\s+)?(?:fatturazione|riferimento|dei\s+consumi|fatturato)?[^0-9]{0,40}?(?:dal\s+)?'.$d.'\s*(?:al|a|-|–|—)\s*'.$d.'/iu',
            '/consumi\s+(?:fatturati\s+)?(?:dal|da)\s+'.$d.'\s*(?:al|a|-|–)\s*'.$d.'/iu',
            '/dal\s+'.$d.'\s+al\s+'.$d.'/iu',
        ];
        foreach ($patterns as $p) {
            if (preg_match($p, $t, $m)) {
                $a = self::date($m[1]);
                $b = self::date($m[2]);
                if ($a && $b && $a <= $b) {
                    return [$a, $b];
                }
            }
        }
        // "Periodo: agosto 2026 - settembre 2026" / "Bolletta di agosto-settembre 2026"
        if (preg_match('/(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s*(\d{4})?\s*(?:-|–|\/|e)\s*(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})/iu', $t, $m)) {
            $y2 = (int) $m[4];
            $m1 = self::MONTHS[mb_strtolower($m[1])];
            $m2 = self::MONTHS[mb_strtolower($m[3])];
            $y1 = $m[2] !== '' ? (int) $m[2] : ($m1 > $m2 ? $y2 - 1 : $y2);

            return [sprintf('%04d-%02d-01', $y1, $m1), date('Y-m-t', (int) strtotime(sprintf('%04d-%02d-01', $y2, $m2)))];
        }

        return [null, null];
    }

    /** @return array{0:?string,1:?string,2:bool} */
    private static function consumption(string $t, ?string $kind): array
    {
        $unitRe = '(kwh|smc|mc|m3|m³|metri\s+cubi)';
        $num = '(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)';
        $label = '(?:consumo\s+(?:totale\s+)?fatturato|consumi\s+fatturati|totale\s+consumi(?:\s+fatturati)?|consumo\s+(?:del\s+)?periodo|consumo\s+totale|energia\s+(?:attiva\s+)?consumata|quantità\s+fatturata|consumo\s+effettivo|consumo\s+stimato|consumo\s+rilevato)';
        $candidates = [];
        if (preg_match_all('/'.$label.'[^0-9\n]{0,60}\n?[^0-9\n]{0,30}'.$num.'\s*'.$unitRe.'/iu', $t, $mm, PREG_SET_ORDER)) {
            foreach ($mm as $m) {
                $candidates[] = [$m[1], $m[2], 2];
            }
        }
        if (preg_match_all('/'.$label.'\s*\(?\s*'.$unitRe.'\s*\)?[^0-9\n]{0,40}'.$num.'/iu', $t, $mm, PREG_SET_ORDER)) {
            foreach ($mm as $m) {
                $candidates[] = [$m[2], $m[1], 2];
            }
        }
        if (! $candidates && preg_match_all('/'.$num.'\s*'.$unitRe.'(?![a-z\/])/iu', $t, $mm, PREG_SET_ORDER)) {
            // nessuna dicitura: il valore più grande con l'unità giusta (di solito il totale del periodo)
            foreach ($mm as $m) {
                $candidates[] = [$m[1], $m[2], 1];
            }
            usort($candidates, fn ($a, $b) => (float) self::number($b[0]) <=> (float) self::number($a[0]));
        }
        foreach ($candidates as [$n, $u]) {
            $unit = match (mb_strtolower(preg_replace('/\s+/u', ' ', $u) ?? '')) {
                'kwh' => 'kwh', 'smc' => 'smc', default => 'm3',
            };
            if ($kind === 'electricity' && $unit !== 'kwh') {
                continue;
            }
            if ($kind !== 'electricity' && $kind !== null && $unit === 'kwh') {
                continue;
            }
            $v = self::number($n);
            if ($v !== null && (float) $v > 0) {
                return [$v, $unit, (bool) preg_match('/consum[io]\s+stimat|lettura\s+stimata|autolettura\s+non|stima/iu', $t)];
            }
        }

        return [null, null, false];
    }

    /** @return list<array<string,mixed>> */
    private static function components(string $t, ?string $kind): array
    {
        $out = [];
        $taken = [];
        foreach (self::COMPONENTS as [$needles, $label, $type, $include]) {
            if ($kind !== 'water' && in_array($label, ['Acquedotto', 'Fognatura', 'Depurazione', 'Oneri di perequazione'], true)) {
                continue;
            }
            if ($kind === 'water' && in_array($label, ['Spesa per la materia / vendita', 'Trasporto e gestione del contatore', 'Oneri di sistema', 'Rete e oneri generali di sistema', 'Imposte (accise)'], true)) {
                continue;
            }
            foreach ($needles as $n) {
                $found = self::amountAfter($t, [$n], $taken);
                if ($found !== null) {
                    $out[] = ['descrizione' => $label, 'importo_netto_iva' => $found, 'tipo' => $type, 'includi' => $include];
                    break;
                }
            }
        }
        return $out;
    }

    /**
     * Primo importo in euro dopo una delle diciture (stessa riga o riga seguente).
     *
     * @param  list<string>  $labels
     * @param  array<int,bool>  $taken  posizioni già usate, per non assegnare lo stesso importo a due voci
     */
    private static function amountAfter(string $t, array $labels, array &$taken = []): ?string
    {
        $money = '(-?\s?(?:€\s*)?-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\s?(?:€\s*)?-?\d+,\d{2})';
        foreach ($labels as $label) {
            $re = '/'.str_replace('\ ', '\s+', preg_quote($label, '/')).'(?![a-z])[^\n€\d]{0,80}?(?:\n[^\n€\d]{0,40})?\s*(?:€\s*)?'.$money.'(?!\s*(?:%|kwh|smc|mc|€\/))/iu';
            if (preg_match_all($re, $t, $mm, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
                foreach ($mm as $m) {
                    $pos = $m[1][1];
                    if (isset($taken[$pos])) {
                        continue;
                    }
                    $v = self::number(str_replace(['€', ' '], '', $m[1][0]));
                    if ($v !== null) {
                        $taken[$pos] = true;

                        return $v;
                    }
                }
            }
        }

        return null;
    }

    private static function match(string $t, string $re): ?string
    {
        return preg_match($re, $t, $m) ? trim($m[1]) : null;
    }

    private static function number(?string $v): ?string
    {
        if ($v === null) {
            return null;
        }
        $v = trim($v);
        if (preg_match('/^-?\d{1,3}(\.\d{3})+(,\d+)?$/', $v) || preg_match('/^-?\d+,\d+$/', $v)) {
            $v = str_replace(['.', ','], ['', '.'], $v);
        } elseif (preg_match('/^-?\d{1,3}(\.\d{3})+$/', $v)) {
            $v = str_replace('.', '', $v);
        }

        return preg_match('/^-?\d+(\.\d+)?$/', $v) ? $v : null;
    }

    private static function date(?string $v): ?string
    {
        if ($v === null) {
            return null;
        }
        $v = mb_strtolower(trim($v));
        if (preg_match('/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/', $v, $m)) {
            [$d, $mo, $y] = [(int) $m[1], (int) $m[2], (int) $m[3]];
        } elseif (preg_match('/^(\d{1,2})\s+([a-zà]+)\.?\s+(\d{4})$/u', $v, $m) && isset(self::MONTHS[$m[2]])) {
            [$d, $mo, $y] = [(int) $m[1], self::MONTHS[$m[2]], (int) $m[3]];
        } else {
            return null;
        }
        if ($y < 100) {
            $y += 2000;
        }

        return checkdate($mo, $d, $y) ? sprintf('%04d-%02d-%02d', $y, $mo, $d) : null;
    }
}
