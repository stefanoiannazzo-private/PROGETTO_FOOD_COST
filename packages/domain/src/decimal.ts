import DecimalJs from 'decimal.js'

/**
 * Decimale ad alta precisione usato in tutto il dominio.
 * Nessun arrotondamento nei calcoli intermedi: si arrotonda solo in visualizzazione.
 */
export const Dec = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP })
export type Dec = InstanceType<typeof Dec>

export type DecInput = Dec | string | number

export function d(value: DecInput): Dec {
  return value instanceof Dec ? value : new Dec(value)
}

export const ZERO = new Dec(0)
export const ONE = new Dec(1)
export const SIXTY = new Dec(60)

export function sum(values: Dec[]): Dec {
  return values.reduce((acc, v) => acc.plus(v), ZERO)
}

/** Serializzazione per API e snapshot: stringa decimale con il punto, senza notazione esponenziale. */
export function str(value: Dec | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value.toFixed()
}

/** Arrotondamento di visualizzazione (mai usato nei calcoli). */
export function round(value: Dec, places = 2): Dec {
  return value.toDecimalPlaces(places, Dec.ROUND_HALF_UP)
}

/** Interpreta un decimale arrivato dall'esterno; restituisce null se non valido. */
export function parseDec(value: unknown): Dec | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  try {
    const v = new Dec(value as string | number)
    return v.isFinite() ? v : null
  } catch {
    return null
  }
}
