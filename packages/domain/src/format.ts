import { Dec, parseDec } from './decimal'

/**
 * Formati italiani: virgola decimale, punto per le migliaia.
 * Le API scambiano sempre stringhe decimali normalizzate col punto; questi helper servono a UI e importazioni.
 */

export type NumberFormatMode = 'auto' | 'it' | 'en'

/**
 * Interpreta un numero scritto all'italiana ("1.234,56", "0,9", "12") o già normalizzato ("1234.56").
 * mode 'it': il punto è sempre separatore delle migliaia; 'en': la virgola è sempre separatore delle migliaia.
 */
export function parseItalianNumber(input: string | number | null | undefined, mode: NumberFormatMode = 'auto'): Dec | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') return parseDec(input)
  let s = input.trim().replace(/\s|€| /g, '')
  if (s === '') return null
  if (mode === 'it') {
    if (!/^[-+]?\d{1,3}(\.\d{3})*(,\d+)?$/.test(s) && !/^[-+]?\d+(,\d+)?$/.test(s)) return null
    return parseDec(s.replace(/\./g, '').replace(',', '.'))
  }
  if (mode === 'en') {
    if (!/^[-+]?\d{1,3}(,\d{3})*(\.\d+)?$/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) return null
    return parseDec(s.replace(/,/g, ''))
  }
  const hasComma = s.includes(',')
  const hasDot = s.includes('.')
  if (hasComma && hasDot) {
    // il separatore che compare per ultimo è quello decimale
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.')
    else s = s.replace(/,/g, '')
  } else if (hasComma) {
    if ((s.match(/,/g) ?? []).length > 1) return null
    s = s.replace(',', '.')
  } else if (hasDot) {
    // "1.234" con più punti o gruppo di 3 cifre dopo l'unico punto e senza altre cifre decimali è ambiguo:
    // all'italiana i punti sono migliaia. Accettiamo "1.234.567" come migliaia, "12.5" come decimale.
    const parts = s.split('.')
    if (parts.length > 2) {
      if (!parts.slice(1).every((p) => p.length === 3)) return null
      s = parts.join('')
    }
  }
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null
  return parseDec(s)
}

const nf = (min: number, max: number) => new Intl.NumberFormat('it-IT', { minimumFractionDigits: min, maximumFractionDigits: max })

export function formatNumber(value: Dec | string | number | null | undefined, maxDecimals = 3, minDecimals = 0): string {
  if (value === null || value === undefined || value === '') return '—'
  const dec = value instanceof Dec ? value : parseDec(value)
  if (!dec) return '—'
  return nf(minDecimals, maxDecimals).format(Number(dec.toDecimalPlaces(maxDecimals).toString()))
}

export function formatEuro(value: Dec | string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—'
  return `${formatNumber(value, decimals, decimals)} €`
}
