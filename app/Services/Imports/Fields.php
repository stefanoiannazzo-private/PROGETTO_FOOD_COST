<?php

declare(strict_types=1);

namespace App\Services\Imports;

/**
 * Campi importabili, con descrizione per il modello e alias per il riconoscimento delle colonne
 * (port di services/imports/fields.ts). NUOVO: "Agente" per gli ingredienti, "Voce extra retribuzione" per i dipendenti.
 */
final class Fields
{
    public static function for(string $type): array
    {
        return self::ALL[$type];
    }

    public const ALL = [
        'ingredients' => [
            ['key' => 'code', 'label' => 'Codice', 'required' => true, 'help' => 'Codice articolo univoco nell’azienda: è la chiave per aggiornare. Se manca, per le righe nuove può essere generato.', 'example' => 'FAR-00', 'aliases' => ['codice', 'codice articolo', 'sku', 'cod', 'code']],
            ['key' => 'name', 'label' => 'Nome', 'required' => true, 'help' => 'Nome dell’ingrediente. Non viene mai usato per abbinare righe esistenti.', 'example' => 'Farina 00', 'aliases' => ['nome', 'descrizione', 'articolo', 'name']],
            ['key' => 'category', 'label' => 'Categoria', 'required' => false, 'help' => 'Categoria libera.', 'example' => 'Farine', 'aliases' => ['categoria', 'category', 'famiglia']],
            ['key' => 'supplier', 'label' => 'Fornitore', 'required' => false, 'help' => 'Fornitore abituale.', 'example' => 'Molino Rossi', 'aliases' => ['fornitore', 'supplier']],
            ['key' => 'agentName', 'label' => 'Agente', 'required' => false, 'help' => 'Facoltativo: agente commerciale del fornitore che ha applicato il prezzo.', 'example' => 'Luca Bianchi', 'aliases' => ['agente', 'agente commerciale', 'rappresentante', 'agent']],
            ['key' => 'packagePrice', 'label' => 'Prezzo confezione', 'required' => false, 'help' => 'Prezzo della confezione al netto IVA, in euro (es. 19,50).', 'example' => '19,50', 'aliases' => ['prezzo', 'prezzo confezione', 'prezzo netto', 'price']],
            ['key' => 'packageContent', 'label' => 'Contenuto confezione', 'required' => true, 'help' => 'Quantità contenuta nella confezione (es. 25).', 'example' => '25', 'aliases' => ['contenuto', 'contenuto confezione', 'quantita confezione', 'formato']],
            ['key' => 'packageUnit', 'label' => 'Unità contenuto', 'required' => true, 'help' => 'Unità del contenuto: g, kg, ml, cl, l, pz.', 'example' => 'kg', 'aliases' => ['unita', 'unita contenuto', 'um', 'unit']],
            ['key' => 'priceDate', 'label' => 'Data prezzo', 'required' => false, 'help' => 'Data da cui vale il prezzo (gg/mm/aaaa). Obbligatoria se è indicato un prezzo.', 'example' => '01/01/2027', 'aliases' => ['data prezzo', 'valido dal', 'data', 'decorrenza']],
            ['key' => 'usageUnit', 'label' => 'Unità in ricetta', 'required' => false, 'help' => 'Facoltativa: unità proposta nelle ricette (default uguale alla confezione, kg→g, l→ml).', 'example' => 'g', 'aliases' => ['unita ricetta', 'unita utilizzo']],
            ['key' => 'edibleYieldPercent', 'label' => 'Resa edibile %', 'required' => false, 'help' => 'Facoltativa: percentuale utilizzabile dopo la mondatura (default 100).', 'example' => '85', 'aliases' => ['resa', 'resa edibile', 'resa %']],
            ['key' => 'densityKgPerL', 'label' => 'Densità kg/l', 'required' => false, 'help' => 'Facoltativa: serve solo per convertire volume e peso.', 'example' => '0,92', 'aliases' => ['densita', 'densita kg/l']],
            ['key' => 'unitWeightG', 'label' => 'Peso unitario g', 'required' => false, 'help' => 'Facoltativo: peso medio di un pezzo in grammi, per convertire pezzi e peso.', 'example' => '60', 'aliases' => ['peso unitario', 'peso medio', 'peso pezzo']],
            ['key' => 'priceSource', 'label' => 'Fonte prezzo', 'required' => false, 'help' => 'Facoltativa: fattura, listino…', 'example' => 'Listino 2027', 'aliases' => ['fonte', 'fonte prezzo']],
        ],
        'employees' => [
            ['key' => 'code', 'label' => 'Codice', 'required' => true, 'help' => 'Codice dipendente univoco nell’azienda: è la chiave per aggiornare.', 'example' => 'DIP-010', 'aliases' => ['codice', 'matricola', 'codice dipendente', 'code']],
            ['key' => 'firstName', 'label' => 'Nome', 'required' => true, 'help' => 'Nome.', 'example' => 'Mario', 'aliases' => ['nome', 'first name']],
            ['key' => 'lastName', 'label' => 'Cognome', 'required' => true, 'help' => 'Cognome.', 'example' => 'Rossi', 'aliases' => ['cognome', 'last name']],
            ['key' => 'jobTitle', 'label' => 'Mansione', 'required' => false, 'help' => 'Mansione.', 'example' => 'Cuoco', 'aliases' => ['mansione', 'ruolo', 'qualifica']],
            ['key' => 'grossMonthly', 'label' => 'Lordo mensile', 'required' => true, 'help' => 'Retribuzione lorda mensile in euro.', 'example' => '2.400,00', 'aliases' => ['lordo', 'lordo mensile', 'retribuzione lorda'], 'salary' => true],
            ['key' => 'extraMonthly', 'label' => 'Voce extra retribuzione', 'required' => false, 'help' => 'Facoltativa: importo mensile aggiuntivo che si somma al lordo (es. superminimo, indennità).', 'example' => '150,00', 'aliases' => ['voce extra', 'extra', 'extra retribuzione', 'superminimo'], 'salary' => true],
            ['key' => 'productiveHours', 'label' => 'Ore produttive mensili', 'required' => true, 'help' => 'Ore mensili effettivamente produttive, usate come divisore.', 'example' => '160', 'aliases' => ['ore', 'ore produttive', 'ore mensili'], 'salary' => true],
            ['key' => 'validFrom', 'label' => 'Decorrenza', 'required' => true, 'help' => 'Data da cui valgono i costi (gg/mm/aaaa).', 'example' => '01/01/2027', 'aliases' => ['decorrenza', 'valido dal', 'data']],
            ['key' => 'contributionsMode', 'label' => 'Modalità oneri', 'required' => false, 'help' => 'Facoltativa: “nessuno”, “importo” (euro al mese) o “percentuale” (sul lordo). Una sola modalità.', 'example' => 'percentuale', 'aliases' => ['modalita oneri', 'tipo oneri'], 'salary' => true],
            ['key' => 'contributionsValue', 'label' => 'Oneri', 'required' => false, 'help' => 'Importo mensile o percentuale secondo la modalità.', 'example' => '30', 'aliases' => ['oneri', 'contributi', 'valore oneri'], 'salary' => true],
            ['key' => 'otherMonthlyCosts', 'label' => 'Altri costi mensili', 'required' => false, 'help' => 'Facoltativi: altri costi mensili imputabili in euro.', 'example' => '100', 'aliases' => ['altri costi'], 'salary' => true],
            ['key' => 'status', 'label' => 'Stato', 'required' => false, 'help' => 'Facoltativo: attivo / non attivo.', 'example' => 'attivo', 'aliases' => ['stato', 'status']],
        ],
    ];

    public static function norm(string $s): string
    {
        $s = mb_strtolower($s);
        if (class_exists(\Normalizer::class)) {
            $s = \Normalizer::normalize($s, \Normalizer::FORM_D) ?: $s;
            $s = preg_replace('/[\x{0300}-\x{036f}]/u', '', $s);
        } else {
            // hosting senza estensione intl: accenti più comuni
            $s = strtr($s, ['à' => 'a', 'á' => 'a', 'â' => 'a', 'ä' => 'a', 'è' => 'e', 'é' => 'e', 'ê' => 'e', 'ë' => 'e', 'ì' => 'i', 'í' => 'i', 'î' => 'i', 'ï' => 'i',
                'ò' => 'o', 'ó' => 'o', 'ô' => 'o', 'ö' => 'o', 'ù' => 'u', 'ú' => 'u', 'û' => 'u', 'ü' => 'u', 'ç' => 'c', 'ñ' => 'n']);
        }
        $s = preg_replace('/[^a-z0-9%\/ ]/u', ' ', $s);

        return trim(preg_replace('/\s+/', ' ', $s));
    }

    /** Proposta di abbinamento colonna → campo in base all'intestazione. */
    public static function suggestMapping(string $type, array $headers): array
    {
        $out = [];
        $used = [];
        foreach (self::ALL[$type] as $f) {
            $candidates = array_map([self::class, 'norm'], [$f['label'], ...$f['aliases']]);
            $hit = null;
            foreach ($headers as $h) {
                if (! isset($used[$h]) && in_array(self::norm((string) $h), $candidates, true)) {
                    $hit = $h;
                    break;
                }
            }
            $out[$f['key']] = $hit;
            if ($hit !== null) {
                $used[$hit] = true;
            }
        }

        return $out;
    }
}
