<?php

declare(strict_types=1);

namespace App\Services\Imports;

use DateTimeImmutable;
use DateTimeZone;
use Generator;
use OpenSpout\Common\Entity\Cell;
use OpenSpout\Reader\XLSX\Options;
use OpenSpout\Reader\XLSX\Reader as XlsxReader;

/**
 * Lettura dei file di importazione a flusso, senza caricarli in memoria (port di services/imports/reader.ts).
 * Valori di cella: string, int|float, DateTimeImmutable, Formula oppure null. Le macro non vengono mai eseguite.
 */
final class Reader
{
    /** Rileva il separatore CSV dalla prima riga non vuota. */
    public static function detectDelimiter(string $sample): string
    {
        $line = '';
        foreach (preg_split('/\r?\n/', $sample) as $l) {
            if (trim($l) !== '') {
                $line = $l;
                break;
            }
        }
        $counts = [';' => substr_count($line, ';'), ',' => substr_count($line, ','), "\t" => substr_count($line, "\t")];
        $best = ';';
        foreach ($counts as $d => $n) {
            if ($n > $counts[$best]) {
                $best = $d;
            }
        }

        return $best;
    }

    /** UTF-8 valido o Windows-1252 (tipico degli export Excel italiani). */
    public static function detectEncoding(string $buf): string
    {
        $buf = substr($buf, 0, 64 * 1024);
        // l'ultimo carattere può essere tagliato a metà: si toglie un'eventuale sequenza incompleta finale
        if (! mb_check_encoding($buf, 'UTF-8')) {
            $trimmed = preg_replace('/[\xC0-\xFF][\x80-\xBF]*$/', '', $buf);
            if (strlen($buf) === 64 * 1024 && $trimmed !== null && mb_check_encoding($trimmed, 'UTF-8')) {
                return 'utf8';
            }

            return 'latin1';
        }

        return 'utf8';
    }

    public static function listSheets(string $path): array
    {
        $reader = new XlsxReader;
        $reader->open($path);
        $names = [];
        foreach ($reader->getSheetIterator() as $sheet) {
            $names[] = $sheet->getName();
        }
        $reader->close();

        return $names;
    }

    /**
     * Righe del file: ['rowNumber' => int, 'cells' => list<mixed>].
     *
     * @param  array{sheet?: ?string, delimiter?: ?string, encoding?: ?string}  $opts
     */
    public static function rows(string $path, string $kind, array $opts): Generator
    {
        if ($kind === 'csv') {
            yield from self::csvRows($path, $opts['delimiter'] ?? ';', $opts['encoding'] ?? 'utf8');

            return;
        }
        $options = new Options;
        $options->SHOULD_PRESERVE_EMPTY_ROWS = true;
        $reader = new XlsxReader($options);
        $reader->open($path);
        try {
            $index = 0;
            foreach ($reader->getSheetIterator() as $sheet) {
                $index++;
                $wanted = ! empty($opts['sheet']) ? $sheet->getName() === $opts['sheet'] : $index === 1;
                if (! $wanted) {
                    continue;
                }
                $n = 0;
                foreach ($sheet->getRowIterator() as $row) {
                    $n++;
                    $cells = array_map([self::class, 'toCell'], $row->getCells());
                    // righe completamente assenti dal foglio: l'originale (ExcelJS) non le emette
                    if ($cells === []) {
                        continue;
                    }
                    yield ['rowNumber' => $n, 'cells' => $cells];
                }

                return;
            }
        } finally {
            $reader->close();
        }
    }

    private static function csvRows(string $path, string $delimiter, string $encoding): Generator
    {
        $fh = fopen($path, 'rb');
        if (! $fh) {
            throw new \RuntimeException('File non leggibile.');
        }
        try {
            $n = 0;
            $first = true;
            foreach (self::csvRecords($fh, $delimiter, $encoding) as $rec) {
                if ($first) {
                    $first = false;
                    if (isset($rec[0]) && str_starts_with($rec[0], "\u{FEFF}")) {
                        $rec[0] = substr($rec[0], 3);
                    }
                }
                $n++;
                yield ['rowNumber' => $n, 'cells' => array_map(fn ($v) => $v === '' ? null : $v, $rec)];
            }
        } finally {
            fclose($fh);
        }
    }

    /**
     * Parser CSV tollerante (come csv-parse con relax_quotes e relax_column_count): campi tra virgolette con
     * "" per le virgolette interne, a capo ammessi tra virgolette, virgolette isolate dentro un campo lasciate com'erano.
     */
    private static function csvRecords($fh, string $delimiter, string $encoding): Generator
    {
        $field = '';
        $record = [];
        $inQuotes = false;
        $fieldStarted = false;
        $wasQuoted = false;
        $pendingCr = false;
        while (! feof($fh)) {
            $chunk = fread($fh, 65536);
            if ($chunk === false || $chunk === '') {
                break;
            }
            if ($encoding === 'latin1') {
                $chunk = mb_convert_encoding($chunk, 'UTF-8', 'Windows-1252');
            }
            $len = strlen($chunk);
            for ($i = 0; $i < $len; $i++) {
                $ch = $chunk[$i];
                if ($inQuotes) {
                    if ($ch === '"') {
                        $next = $i + 1 < $len ? $chunk[$i + 1] : null;
                        if ($next === null && ! feof($fh)) {
                            // virgolette a fine blocco: si legge il carattere successivo
                            $peek = fread($fh, 1);
                            if ($encoding === 'latin1' && $peek !== false) {
                                $peek = mb_convert_encoding($peek, 'UTF-8', 'Windows-1252');
                            }
                            $chunk .= (string) $peek;
                            $len = strlen($chunk);
                            $next = $i + 1 < $len ? $chunk[$i + 1] : null;
                        }
                        if ($next === '"') {
                            $field .= '"';
                            $i++;
                        } else {
                            $inQuotes = false;
                        }
                    } else {
                        $field .= $ch;
                    }

                    continue;
                }
                if ($pendingCr) {
                    $pendingCr = false;
                    if ($ch === "\n") {
                        continue;
                    }
                }
                if ($ch === '"' && ! $fieldStarted) {
                    $inQuotes = true;
                    $fieldStarted = true;
                    $wasQuoted = true;

                    continue;
                }
                if ($ch === $delimiter) {
                    $record[] = $field;
                    $field = '';
                    $fieldStarted = false;
                    $wasQuoted = false;

                    continue;
                }
                if ($ch === "\n" || $ch === "\r") {
                    $record[] = $field;
                    yield $record;
                    $record = [];
                    $field = '';
                    $fieldStarted = false;
                    $wasQuoted = false;
                    $pendingCr = $ch === "\r";

                    continue;
                }
                $field .= $ch;
                $fieldStarted = true;
            }
        }
        if ($field !== '' || $record !== [] || $wasQuoted) {
            $record[] = $field;
            yield $record;
        }
    }

    public static function toCell(Cell $c): mixed
    {
        return match (true) {
            $c instanceof Cell\EmptyCell => null,
            $c instanceof Cell\FormulaCell => new Formula(ltrim($c->getValue(), '=')),
            $c instanceof Cell\DateTimeCell => $c->getValue(),
            $c instanceof Cell\BooleanCell => $c->getValue() ? 'VERO' : 'FALSO',
            $c instanceof Cell\NumericCell => $c->getValue(),
            $c instanceof Cell\ErrorCell => (string) $c->getRawValue(),
            default => ($v = $c->getValue()) === '' || $v === null ? null : (is_string($v) ? $v : (string) $v),
        };
    }

    /** Testo della cella per anteprime e intestazioni. */
    public static function cellText(mixed $c): string
    {
        if ($c === null) {
            return '';
        }
        if ($c instanceof DateTimeImmutable) {
            return $c->format('Y-m-d');
        }
        if ($c instanceof Formula) {
            return '='.$c->formula;
        }

        return trim(self::scalar($c));
    }

    /** Conversione di un numero come String(n) in JavaScript. */
    public static function scalar(mixed $c): string
    {
        if (is_float($c)) {
            if (floor($c) === $c && abs($c) < 1e15) {
                return (string) (int) $c;
            }
            $s = var_export($c, true);

            return str_contains($s, 'E') ? sprintf('%.17g', $c) : $s;
        }

        return (string) $c;
    }
}
