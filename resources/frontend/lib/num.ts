import { formatEuro, formatNumber, parseItalianNumber } from '@foodcost/domain'

/**
 * Numeri nell'interfaccia: si digitano e si leggono all'italiana (virgola decimale, punto per le migliaia),
 * verso l'API viaggiano normalizzati ("1234.56").
 */

/** Testo digitato → stringa normalizzata; '' se vuoto; null se non valido. */
export function toApiNumber(input: string): string | null {
  if (input.trim() === '') return ''
  const v = parseItalianNumber(input, 'it')
  return v ? v.toFixed() : null
}

/** Valore normalizzato → testo all'italiana per l'input (senza separatore delle migliaia per facilitare la modifica). */
export function toInputText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const s = String(value)
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s
  const [int, frac] = s.split('.')
  const trimmed = frac ? frac.replace(/0+$/, '') : ''
  return trimmed ? `${int},${trimmed}` : int!
}

export const euro = (v: string | number | null | undefined, decimals = 2) => formatEuro(v ?? null, decimals)
export const num = (v: string | number | null | undefined, max = 3, min = 0) => formatNumber(v ?? null, max, min)

/** Prezzo unitario: almeno 2 decimali, fino a `decimals` solo se significativi (7,80 €/kg; 0,2925 €/kWh). */
export function euroPer(v: string | null | undefined, unit: string | null | undefined, decimals = 2) {
  if (v === null || v === undefined) return '—'
  return `${formatNumber(v, decimals, 2)} €/${unitLabel(unit)}`
}

export function unitLabel(u: string | null | undefined): string {
  switch (u) {
    case 'kwh':
      return 'kWh'
    case 'm3':
      return 'm³'
    case 'smc':
      return 'Smc'
    default:
      return u ?? ''
  }
}

export function percent(v: string | number | null | undefined, max = 1) {
  if (v === null || v === undefined || v === '') return '—'
  return `${formatNumber(v, max)}%`
}

export function minutes(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (n < 60) return `${formatNumber(n, 1)} min`
  const h = Math.floor(n / 60)
  const m = Math.round(n - h * 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

export function date(v: string | Date | null | undefined) {
  if (!v) return '—'
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v)
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function dateTime(v: string | Date | null | undefined) {
  if (!v) return '—'
  return new Date(v).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
