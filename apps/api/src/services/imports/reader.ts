import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parse as csvParse } from 'csv-parse'
import ExcelJS from 'exceljs'

export interface ReadOptions {
  sheet?: string | null
  delimiter?: ';' | ',' | '\t' | null
  encoding?: 'utf8' | 'latin1'
  /** riga (1-based) che contiene le intestazioni */
  headerRow?: number
}

/** Valore di cella letto dal file: testo, numero, data oppure formula (rifiutata per i campi obbligatori). */
export type Cell = string | number | Date | { formula: string } | null

export interface Row {
  rowNumber: number
  cells: Cell[]
}

/** Rileva il separatore CSV dalla prima riga non vuota (CSV italiani: tipicamente punto e virgola). */
export function detectDelimiter(sample: string): ';' | ',' | '\t' {
  const line = sample.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const counts = { ';': (line.match(/;/g) ?? []).length, ',': (line.match(/,/g) ?? []).length, '\t': (line.match(/\t/g) ?? []).length }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0] as ';' | ',' | '\t') ?? ';'
}

/** UTF-8 valido o Windows-1252 (tipico degli export Excel italiani). */
export function detectEncoding(buf: Buffer): 'utf8' | 'latin1' {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, 64 * 1024))
    return 'utf8'
  } catch {
    return 'latin1'
  }
}

export async function listSheets(path: string): Promise<string[]> {
  const names: string[] = []
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit', entries: 'ignore' })
  for await (const ws of reader) {
    names.push((ws as unknown as { name: string }).name)
    // basta l'elenco: i fogli non vengono letti per intero
    for await (const _row of ws) break
  }
  return names
}

/**
 * Legge le righe del file a blocchi, senza caricare tutto in memoria (CSV in streaming, XLSX con lettore a flusso).
 * Le macro non vengono mai eseguite; le formule sono riportate come tali.
 */
export async function* readRows(path: string, kind: 'csv' | 'xlsx', opts: ReadOptions): AsyncGenerator<Row> {
  if (kind === 'csv') {
    const encoding = opts.encoding ?? 'utf8'
    const decoder = new TextDecoder(encoding === 'latin1' ? 'windows-1252' : 'utf-8')
    const parser = csvParse({ delimiter: opts.delimiter ?? ';', bom: true, relax_column_count: true, skip_empty_lines: false, relax_quotes: true })
    const stream = createReadStream(path)
    ;(async () => {
      try {
        for await (const chunk of stream) parser.write(decoder.decode(chunk as Buffer, { stream: true }))
        parser.end(decoder.decode())
      } catch (e) {
        parser.destroy(e as Error)
      }
    })()
    let n = 0
    for await (const rec of parser as AsyncIterable<string[]>) {
      n++
      yield { rowNumber: n, cells: rec.map((v) => (v === '' ? null : v)) }
    }
    return
  }
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'cache', worksheets: 'emit', entries: 'ignore' })
  let index = 0
  for await (const ws of reader) {
    const name = (ws as unknown as { name: string }).name
    index++
    const wanted = opts.sheet ? name === opts.sheet : index === 1
    for await (const row of ws) {
      if (!wanted) continue
      const r = row as ExcelJS.Row
      const cells: Cell[] = []
      const values = r.values as unknown[]
      for (let i = 1; i < values.length; i++) cells.push(toCell(values[i]))
      yield { rowNumber: r.number, cells }
    }
    if (wanted) return
  }
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'string' || typeof v === 'number') return v
  if (v instanceof Date) return v
  if (typeof v === 'boolean') return v ? 'VERO' : 'FALSO'
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('formula' in o || 'sharedFormula' in o) return { formula: String(o.formula ?? o.sharedFormula) }
    if ('richText' in o) return (o.richText as Array<{ text: string }>).map((t) => t.text).join('')
    if ('text' in o) return String(o.text)
    if ('error' in o) return String(o.error)
  }
  return String(v)
}

export async function sampleText(path: string): Promise<Buffer> {
  const buf = await readFile(path)
  return buf.subarray(0, 64 * 1024)
}

export function cellText(c: Cell | undefined): string {
  if (c === null || c === undefined) return ''
  if (c instanceof Date) return c.toISOString().slice(0, 10)
  if (typeof c === 'object') return `=${c.formula}`
  return String(c).trim()
}
