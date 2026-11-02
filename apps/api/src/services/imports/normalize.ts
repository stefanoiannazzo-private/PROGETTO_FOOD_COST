import { d, dimensionOf, isMeasureUnit, parseItalianNumber, type NumberFormatMode } from '@foodcost/domain'
import type { Cell } from './reader'

export interface NormalizeOptions {
  numberFormat: NumberFormatMode
}

export class CellError extends Error {}

export function isFormula(c: Cell | undefined): c is { formula: string } {
  return !!c && typeof c === 'object' && !(c instanceof Date) && 'formula' in c
}

export function text(c: Cell | undefined): string | null {
  if (c === null || c === undefined) return null
  if (isFormula(c)) throw new CellError('contiene una formula: inserisci un valore statico')
  if (c instanceof Date) return c.toISOString().slice(0, 10)
  const s = String(c).trim()
  return s === '' ? null : s
}

export function number(c: Cell | undefined, o: NormalizeOptions): string | null {
  if (c === null || c === undefined) return null
  if (isFormula(c)) throw new CellError('contiene una formula: inserisci un valore statico')
  if (typeof c === 'number') {
    if (!Number.isFinite(c)) throw new CellError('numero non valido')
    // i numeri Excel arrivano in virgola mobile: si normalizza a una precisione ragionevole
    return d(c.toPrecision(15)).toFixed()
  }
  if (c instanceof Date) throw new CellError('è una data, era atteso un numero')
  const s = String(c).trim()
  if (s === '') return null
  const v = parseItalianNumber(s, o.numberFormat)
  if (!v) throw new CellError(`“${s}” non è un numero valido`)
  return v.toFixed()
}

/** Date: celle data Excel, gg/mm/aaaa (anche gg-mm-aa), aaaa-mm-gg, numero seriale Excel. */
export function date(c: Cell | undefined): string | null {
  if (c === null || c === undefined) return null
  if (isFormula(c)) throw new CellError('contiene una formula: inserisci un valore statico')
  if (c instanceof Date) {
    if (Number.isNaN(c.getTime())) throw new CellError('data non valida')
    return `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}`
  }
  if (typeof c === 'number') {
    if (c > 20000 && c < 80000) {
      const ms = Math.round((c - 25569) * 86400_000)
      return date(new Date(ms))
    }
    throw new CellError('data non valida')
  }
  const s = String(c).trim()
  if (s === '') return null
  let y: number, m: number, dd: number
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (mt) [y, m, dd] = [Number(mt[1]), Number(mt[2]), Number(mt[3])]
  else if ((mt = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    ;[dd, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])]
    if (y < 100) y += 2000
  } else throw new CellError(`“${s}” non è una data valida (usa gg/mm/aaaa)`)
  const dt = new Date(Date.UTC(y, m - 1, dd))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== dd) throw new CellError(`“${s}” non è una data esistente`)
  if (y < 2000 || y > 2100) throw new CellError(`anno ${y} fuori intervallo`)
  return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

export function unit(c: Cell | undefined): string | null {
  const s = text(c)?.toLowerCase().replace(/\.$/, '')
  if (!s) return null
  const alias: Record<string, string> = { gr: 'g', grammi: 'g', kg: 'kg', chili: 'kg', lt: 'l', litri: 'l', litro: 'l', pezzi: 'pz', pz: 'pz', pezzo: 'pz', n: 'pz', nr: 'pz' }
  const u = alias[s] ?? s
  if (!isMeasureUnit(u)) throw new CellError(`unità “${s}” non riconosciuta (g, kg, ml, cl, l, pz)`)
  return u
}

export function defaultUsageUnit(packageUnit: string): string {
  return packageUnit === 'kg' ? 'g' : packageUnit === 'l' ? 'ml' : packageUnit
}

export function sameDimension(a: string, b: string): boolean {
  return isMeasureUnit(a) && isMeasureUnit(b) && dimensionOf(a) === dimensionOf(b)
}

export function contributionsMode(c: Cell | undefined): 'none' | 'amount' | 'percent' | null {
  const s = text(c)?.toLowerCase()
  if (!s) return null
  if (['nessuno', 'nessuna', 'no', 'none', '-'].includes(s)) return 'none'
  if (['importo', 'euro', '€', 'amount'].includes(s)) return 'amount'
  if (['percentuale', '%', 'perc', 'percent'].includes(s)) return 'percent'
  throw new CellError(`modalità oneri “${s}” non riconosciuta (nessuno, importo, percentuale)`)
}
