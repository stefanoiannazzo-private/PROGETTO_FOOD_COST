<?php

namespace Tests\Support;

/** PDF minimale con testo reale (una riga per elemento), per provare la lettura locale delle bollette. */
final class PdfFixture
{
    /** @param list<string> $lines */
    public static function make(array $lines): string
    {
        $stream = "BT\n/F1 10 Tf\n14 TL\n50 800 Td\n";
        foreach ($lines as $l) {
            $enc = mb_convert_encoding($l, 'Windows-1252', 'UTF-8');
            $stream .= '('.addcslashes($enc, '()\\').") Tj T*\n";
        }
        $stream .= "ET\n";
        $objs = [
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
            "<< /Length ".strlen($stream)." >>\nstream\n{$stream}endstream",
            '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        ];
        $pdf = "%PDF-1.4\n";
        $offsets = [];
        foreach ($objs as $i => $o) {
            $offsets[] = strlen($pdf);
            $pdf .= ($i + 1)." 0 obj\n{$o}\nendobj\n";
        }
        $xref = strlen($pdf);
        $pdf .= "xref\n0 ".(count($objs) + 1)."\n0000000000 65535 f \n";
        foreach ($offsets as $off) {
            $pdf .= sprintf("%010d 00000 n \n", $off);
        }

        return $pdf."trailer\n<< /Size ".(count($objs) + 1)." /Root 1 0 R >>\nstartxref\n{$xref}\n%%EOF\n";
    }

    public const LUCE = [
        'Enel Energia S.p.A. - Mercato libero',
        'Bolletta n. 004512345678 del 05/10/2026',
        'Cliente: Trattoria Demo - POD IT001E12345678',
        'Periodo di fatturazione: dal 01/08/2026 al 30/09/2026',
        'Consumo fatturato 2.000 kWh',
        'Quadro sintetico',
        'Spesa per la materia energia € 400,00',
        'Spesa per il trasporto e la gestione del contatore € 90,00',
        'Spesa per oneri di sistema € 70,00',
        'Imposte € 45,00',
        'Canone di abbonamento alla televisione € 18,00',
        'Totale imponibile € 623,00',
        'IVA 10% € 62,30',
        'Totale da pagare € 685,30',
    ];

    public const GAS = [
        'A2A Energia S.p.A.',
        'Fattura n. 2026/123456 emessa il 12/10/2026',
        'Fornitura di gas naturale - PDR 01234567890123',
        'Periodo: agosto - settembre 2026',
        'Totale consumi fatturati 500 Smc',
        'Coefficiente C 1,020000',
        'PCS 0,038520 GJ/Smc',
        'Spesa per la vendita di gas naturale 300,00 €',
        'Spesa per la rete e gli oneri generali di sistema 120,00 €',
        'Imposte 60,00 €',
        'IVA 10% 48,00 €',
        'Totale bolletta 528,00 €',
    ];

    /** Impaginazione Iren "scontrino dell'energia" (quote con sottovoci "di cui"), dati personali omessi. */
    public const IREN = [
        'Cliente Esempio',
        'Fattura n. 38500000000001 *',
        'Emessa in data: 05 novembre 2026',
        '** Periodo di riferimento:',
        '01 OTTOBRE 2026 - 31 OTTOBRE 2026',
        'Consumo',
        'Annuo (kWh)',
        'TOTALE',
        '1.053',
        'kWh',
        'ENERGIA ELETTRICA',
        'Totale da pagare 48,88 €',
        'Consumo totale fatturato nel periodo **',
        '63 kWh',
        'Scontrino dell\'energia',
        'QUANTITA\' PREZZO MEDIO IMPORTO',
        'Quota per consumi',
        'ENERGIA ATTIVA 63 kWh x 0,232540 €/kWh 14,65 €',
        'di cui spesa per la vendita di energia elettrica 0,184762 €/kWh 11,64 €',
        'di cui spesa per la rete e gli oneri generali di sistema 0,047778 €/kWh 3,01 €',
        'Quota fissa e Quota potenza',
        'Quota fissa 1 mese x 15,670000 €/mese 15,67 €',
        'di cui spesa per la vendita di energia elettrica 13,750000 €/mese 13,75 €',
        'Quota potenza 3,0 kW per 1 mese x 1,976667 €/kW/mese 5,93 €',
        'di cui spesa per la rete e gli oneri generali di sistema 1,976667 €/kW/mese 5,93 €',
        'Accise e IVA 3,63 €',
        'Totale bolletta',
        '39,88 €',
        'Canone di abbonamento alla televisione per uso privato di 10/26 9,00 €',
        'Totale da pagare',
        '48,88 €',
        'Iren Luce Gas e Servizi S.p.A.',
        'Totale consumi dal 01/10/2026 al 31/10/2026',
        'Iva 10% 39,88 € 36,25 € 3,63 €',
    ];

    public const ACQUA = [
        'Publiacqua S.p.A. - Servizio idrico integrato',
        'Bolletta n. 77881122 del 15/10/2026',
        'Consumi fatturati dal 01/07/2026 al 30/09/2026',
        'Consumo fatturato 85 mc',
        'Quota fissa 12,50',
        'Servizio acquedotto 95,20',
        'Servizio fognatura 30,10',
        'Servizio depurazione 60,40',
        'IVA 10% 19,82',
        'Totale da pagare 218,02',
    ];
}
