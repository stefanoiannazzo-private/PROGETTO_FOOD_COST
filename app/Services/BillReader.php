<?php

declare(strict_types=1);

namespace App\Services;

use App\Domain\Costing\Dec;
use Illuminate\Support\Facades\Http;

/**
 * NUOVO — Lettura automatica di una bolletta (PDF o foto) con il modello Claude di Anthropic.
 *
 * Il modello restituisce i dati tramite uno strumento con schema fisso (nessun testo libero da interpretare);
 * normalize() li controlla e li converte nel formato del modulo "Calcola da una bolletta".
 * Nulla viene salvato come tariffa: il ristoratore verifica e conferma.
 */
final class BillReader
{
    public static function configured(): bool
    {
        return (string) config('foodcost.bill_ai.key') !== '';
    }

    /**
     * @return array<string,mixed> dati grezzi restituiti dal modello
     *
     * @throws \RuntimeException con un messaggio comprensibile per l'utente
     */
    public static function read(string $bytes, string $mime): array
    {
        $source = ['type' => 'base64', 'media_type' => $mime, 'data' => base64_encode($bytes)];
        $file = $mime === 'application/pdf' ? ['type' => 'document', 'source' => $source] : ['type' => 'image', 'source' => $source];

        $res = Http::withHeaders([
            'x-api-key' => (string) config('foodcost.bill_ai.key'),
            'anthropic-version' => '2023-06-01',
        ])->timeout((int) config('foodcost.bill_ai.timeout'))->connectTimeout(10)->acceptJson()
            ->post((string) config('foodcost.bill_ai.url'), [
                'model' => (string) config('foodcost.bill_ai.model'),
                'max_tokens' => 3000,
                'system' => self::PROMPT,
                'tools' => [self::tool()],
                'tool_choice' => ['type' => 'tool', 'name' => 'registra_bolletta'],
                'messages' => [['role' => 'user', 'content' => [$file, ['type' => 'text', 'text' => 'Leggi questa bolletta e registra i dati.']]]],
            ]);

        if (! $res->successful()) {
            $type = (string) ($res->json('error.type') ?? '');
            throw new \RuntimeException(match (true) {
                $res->status() === 401 => 'Chiave del servizio di lettura non valida.',
                $res->status() === 429 || $type === 'rate_limit_error' => 'Servizio di lettura momentaneamente occupato: riprova tra un minuto.',
                str_contains((string) $res->json('error.message'), 'credit') => 'Credito del servizio di lettura esaurito.',
                $res->status() === 413 || $res->status() === 400 => 'Il file non può essere letto dal servizio (troppo grande o non valido).',
                default => 'Servizio di lettura non disponibile (errore '.$res->status().').',
            });
        }
        foreach ((array) $res->json('content') as $block) {
            if (($block['type'] ?? '') === 'tool_use' && ($block['name'] ?? '') === 'registra_bolletta') {
                return (array) $block['input'];
            }
        }
        throw new \RuntimeException('Il servizio di lettura non ha restituito dati.');
    }

    /**
     * Converte i dati letti nel modulo della tariffa (kind/unit della tariffa di destinazione) e segnala le incoerenze.
     *
     * @param  array<string,mixed>  $raw
     * @return array{form: array<string,mixed>|null, info: array<string,mixed>, warnings: list<string>}
     */
    public static function normalize(array $raw, string $tariffKind, string $tariffUnit): array
    {
        $w = [];
        $isBill = ($raw['e_una_bolletta'] ?? true) !== false;
        $info = [
            'supplier' => self::text($raw['fornitore'] ?? null, 120),
            'billNumber' => self::text($raw['numero_fattura'] ?? null, 60),
            'issueDate' => self::date($raw['data_emissione'] ?? null),
            'utility' => in_array($raw['tipo_utenza'] ?? null, ['electricity', 'gas', 'water'], true) ? $raw['tipo_utenza'] : null,
            'totalAmount' => self::dec($raw['totale_da_pagare'] ?? null),
            'taxableAmount' => self::dec($raw['imponibile_totale'] ?? null),
            'vatPercent' => self::dec($raw['aliquota_iva'] ?? null),
        ];
        if (! $isBill) {
            return ['form' => null, 'info' => $info, 'warnings' => ['Il documento non sembra una bolletta di luce, gas o acqua: compila i dati a mano.']];
        }
        $labels = ['electricity' => 'luce', 'gas' => 'gas', 'water' => 'acqua'];
        if ($info['utility'] && $info['utility'] !== $tariffKind) {
            $w[] = "La bolletta sembra di {$labels[$info['utility']]}, ma questa utenza è di {$labels[$tariffKind]}: controlla di averla caricata nell’utenza giusta.";
        }

        $from = self::date($raw['periodo_dal'] ?? null);
        $to = self::date($raw['periodo_al'] ?? null);
        if ($from && $to && $to < $from) {
            [$from, $to] = [$to, $from];
        }
        if (! $from || ! $to) {
            $w[] = 'Periodo di fatturazione non trovato: inseriscilo a mano.';
        }

        $consumption = self::dec($raw['consumo'] ?? null);
        $unit = match (mb_strtolower((string) ($raw['unita_consumo'] ?? ''))) {
            'kwh' => 'kwh', 'smc' => 'smc', 'm3', 'mc', 'm³' => 'm3', default => null,
        };
        $m3ToSmc = self::dec($raw['coefficiente_c'] ?? null);
        $smcToKwh = null;
        $pcs = self::dec($raw['pcs_gj_smc'] ?? null);
        if ($pcs && Dec::of($pcs)->gt(0)) {
            // potere calorifico superiore: GJ/Smc → kWh/Smc (1 GJ = 277,7778 kWh)
            $smcToKwh = Dec::of($pcs)->times('277.77777778')->toDecimalPlaces(4)->toFixed();
        }
        if ($consumption && $unit && $unit !== $tariffUnit) {
            if ($unit === 'm3' && $tariffUnit === 'smc' && $m3ToSmc) {
                $consumption = Dec::of($consumption)->times($m3ToSmc)->toDecimalPlaces(3)->toFixed();
                $w[] = 'Il consumo era in m³: convertito in Smc con il coefficiente C della bolletta.';
            } else {
                $w[] = 'Il consumo in bolletta è espresso in '.$unit.' ma l’utenza usa '.$tariffUnit.': correggi il consumo prima di salvare.';
                $consumption = null;
            }
        }
        if (! $consumption || ! Dec::of($consumption)->gt(0)) {
            $consumption = null;
            $w[] = 'Consumo del periodo non trovato: inseriscilo a mano.';
        }
        if (! empty($raw['consumo_stimato'])) {
            $w[] = 'Il fornitore indica consumi stimati (non letture reali): il prezzo medio può cambiare con il conguaglio.';
        }

        $components = [];
        foreach ((array) ($raw['voci'] ?? []) as $c) {
            $amount = self::dec($c['importo_netto_iva'] ?? null);
            $label = self::text($c['descrizione'] ?? null, 120);
            if ($amount === null || $label === null) {
                continue;
            }
            $negative = Dec::of($amount)->lt(0);
            $components[] = [
                'label' => $label,
                'amount' => $negative ? Dec::of($amount)->abs()->toFixed() : $amount,
                'kind' => ($c['tipo'] ?? '') === 'fixed' ? 'fixed' : 'variable',
                // voci negative (bonus, ricalcoli a credito) ed estranee al costo dell'energia restano escluse
                'include' => ! $negative && ($c['includi'] ?? true) !== false && ($c['tipo'] ?? '') !== 'fixed',
            ];
            if ($negative) {
                $w[] = "La voce «{$label}» è un accredito: è stata esclusa dal calcolo.";
            }
        }
        if (! $components) {
            $w[] = 'Voci di costo non trovate: inseriscile a mano.';
        } elseif ($info['taxableAmount']) {
            $sum = Dec::sum(array_map(fn ($c) => Dec::of($c['amount']), $components));
            $tax = Dec::of($info['taxableAmount']);
            if ($tax->gt(0) && $sum->minus($tax)->abs()->div($tax)->gt('0.02')) {
                $w[] = 'La somma delle voci lette ('.$sum->toDecimalPlaces(2)->toFixed().' €) non coincide con l’imponibile della bolletta ('.$tax->toDecimalPlaces(2)->toFixed().' €): controlla gli importi.';
            }
        }
        if (! empty($raw['note'])) {
            $w[] = self::text($raw['note'], 300);
        }

        return [
            'form' => [
                'validFrom' => $from,
                'periodFrom' => $from,
                'periodTo' => $to,
                'consumption' => $consumption,
                'consumptionUnit' => $tariffUnit,
                'components' => $components,
                'm3ToSmc' => $tariffKind === 'gas' ? $m3ToSmc : null,
                'smcToKwh' => $tariffKind === 'gas' ? $smcToKwh : null,
            ],
            'info' => $info,
            'warnings' => array_values(array_filter($w)),
        ];
    }

    private static function dec(mixed $v): ?string
    {
        if (is_int($v) || is_float($v)) {
            $v = (string) $v;
        }
        if (! is_string($v)) {
            return null;
        }
        $v = trim(str_replace(['€', ' '], '', $v));
        // il modello usa il punto decimale; per prudenza accetta anche "1.234,56"
        if (preg_match('/^-?\d{1,3}(\.\d{3})+(,\d+)?$/', $v) || preg_match('/^-?\d+,\d+$/', $v)) {
            $v = str_replace(['.', ','], ['', '.'], $v);
        }
        if (! preg_match('/^-?\d+(\.\d+)?$/', $v)) {
            return null;
        }

        return Dec::of($v)->toFixed();
    }

    private static function date(mixed $v): ?string
    {
        if (! is_string($v) || ! preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m) || ! checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            return null;
        }

        return $v;
    }

    private static function text(mixed $v, int $max): ?string
    {
        if (! is_string($v)) {
            return null;
        }
        $v = trim(preg_replace('/\s+/u', ' ', $v) ?? '');

        return $v === '' ? null : mb_substr($v, 0, $max);
    }

    private static function tool(): array
    {
        $num = ['type' => ['string', 'null'], 'description' => 'Numero con il punto decimale, senza simbolo €, es. "123.45". null se non presente.'];
        $date = ['type' => ['string', 'null'], 'description' => 'Data AAAA-MM-GG, null se non presente.'];

        return [
            'name' => 'registra_bolletta',
            'description' => 'Registra i dati letti dalla bolletta.',
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'e_una_bolletta' => ['type' => 'boolean', 'description' => 'false se il documento non è una bolletta di luce, gas o acqua.'],
                    'tipo_utenza' => ['type' => ['string', 'null'], 'enum' => ['electricity', 'gas', 'water', null]],
                    'fornitore' => ['type' => ['string', 'null']],
                    'numero_fattura' => ['type' => ['string', 'null']],
                    'data_emissione' => $date,
                    'periodo_dal' => $date + ['description' => 'Inizio del periodo dei consumi fatturati, AAAA-MM-GG.'],
                    'periodo_al' => $date + ['description' => 'Fine del periodo dei consumi fatturati, AAAA-MM-GG.'],
                    'consumo' => $num + ['description' => 'Consumo totale fatturato nel periodo (letture reali + stimate), punto decimale.'],
                    'unita_consumo' => ['type' => ['string', 'null'], 'enum' => ['kwh', 'smc', 'm3', null]],
                    'consumo_stimato' => ['type' => 'boolean', 'description' => 'true se il consumo fatturato è in tutto o in parte stimato.'],
                    'coefficiente_c' => $num + ['description' => 'Solo gas: coefficiente C di conversione m³→Smc, se indicato.'],
                    'pcs_gj_smc' => $num + ['description' => 'Solo gas: potere calorifico superiore in GJ/Smc, se indicato.'],
                    'voci' => [
                        'type' => 'array',
                        'description' => 'Voci di spesa del periodo, importi NETTI IVA.',
                        'items' => [
                            'type' => 'object',
                            'properties' => [
                                'descrizione' => ['type' => 'string'],
                                'importo_netto_iva' => $num,
                                'tipo' => ['type' => 'string', 'enum' => ['variable', 'fixed']],
                                'includi' => ['type' => 'boolean'],
                            ],
                            'required' => ['descrizione', 'importo_netto_iva', 'tipo', 'includi'],
                        ],
                    ],
                    'imponibile_totale' => $num + ['description' => 'Totale imponibile IVA della bolletta.'],
                    'aliquota_iva' => $num + ['description' => 'Aliquota IVA prevalente in percentuale, es. "10" o "22".'],
                    'totale_da_pagare' => $num + ['description' => 'Totale della bolletta IVA inclusa.'],
                    'note' => ['type' => ['string', 'null'], 'description' => 'Breve avviso in italiano per il ristoratore se qualcosa è dubbio (max 1 frase), altrimenti null.'],
                ],
                'required' => ['e_una_bolletta', 'tipo_utenza', 'periodo_dal', 'periodo_al', 'consumo', 'unita_consumo', 'voci', 'imponibile_totale', 'totale_da_pagare'],
            ],
        ];
    }

    private const PROMPT = <<<'TXT'
Sei un esperto di bollette italiane di energia elettrica, gas e acqua per attività commerciali (ristoranti).
Leggi il documento e registra i dati con lo strumento registra_bolletta. Regole:
- Numeri sempre con il punto decimale e senza separatore delle migliaia ("1234.56"). Date in formato AAAA-MM-GG.
- Il periodo è quello dei consumi fatturati (non la data di scadenza). Il consumo è il totale fatturato nel periodo (kWh per la luce, Smc o m³ per il gas, m³ per l'acqua).
- Voci: usa le voci del riepilogo ("Spesa per la materia energia/gas naturale", "Spesa per il trasporto e la gestione del contatore", "Spesa per oneri di sistema", "Imposte"/accise, per l'acqua "Acquedotto", "Fognatura", "Depurazione", "Quota fissa"). Se il riepilogo separa quota fissa, quota potenza e quota energia, registrale come voci separate.
- Importi NETTI IVA (senza IVA). Non includere mai l'IVA come voce.
- tipo "fixed" = quote fisse e quote potenza (non dipendono dal consumo); tipo "variable" = tutto ciò che dipende dai consumi, accise comprese.
- includi=false per: canone TV/RAI, interessi di mora, solleciti, depositi cauzionali, bonus, sconti una tantum, ricalcoli o conguagli di periodi precedenti, altre partite non legate ai consumi del periodo. Gli accrediti hanno importo negativo.
- Se un dato non è leggibile usa null: non inventare valori.
TXT;
}
