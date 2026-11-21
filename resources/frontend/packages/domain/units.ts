import { Dec, d, ONE } from './decimal'

/** Grandezze fisiche gestite per ingredienti e rese. */
export type Dimension = 'mass' | 'volume' | 'count'

/** Unità di base di ciascuna grandezza: kg, l, pz. */
export const BASE_UNIT: Record<Dimension, MeasureUnit> = { mass: 'kg', volume: 'l', count: 'pz' }

export const MEASURE_UNITS = ['g', 'kg', 'ml', 'cl', 'l', 'pz'] as const
export type MeasureUnit = (typeof MEASURE_UNITS)[number]

const UNIT_INFO: Record<MeasureUnit, { dimension: Dimension; toBase: string; label: string }> = {
  g: { dimension: 'mass', toBase: '0.001', label: 'g' },
  kg: { dimension: 'mass', toBase: '1', label: 'kg' },
  ml: { dimension: 'volume', toBase: '0.001', label: 'ml' },
  cl: { dimension: 'volume', toBase: '0.01', label: 'cl' },
  l: { dimension: 'volume', toBase: '1', label: 'l' },
  pz: { dimension: 'count', toBase: '1', label: 'pz' },
}

export function isMeasureUnit(u: unknown): u is MeasureUnit {
  return typeof u === 'string' && (MEASURE_UNITS as readonly string[]).includes(u)
}

export function dimensionOf(unit: MeasureUnit): Dimension {
  return UNIT_INFO[unit].dimension
}

/** Converte una quantità nella unità di base della sua grandezza (kg, l o pz). */
export function toBase(quantity: Dec, unit: MeasureUnit): Dec {
  return quantity.times(UNIT_INFO[unit].toBase)
}

export function fromBase(quantity: Dec, unit: MeasureUnit): Dec {
  return quantity.div(UNIT_INFO[unit].toBase)
}

/**
 * Dati facoltativi per passare da una grandezza all'altra.
 * Senza di essi la conversione è rifiutata: mai litri in kg senza densità, mai pezzi in grammi senza peso unitario.
 */
export interface ConversionData {
  /** kg per litro */
  densityKgPerL?: Dec | null
  /** kg per pezzo */
  unitWeightKg?: Dec | null
}

export class UnitConversionError extends Error {
  constructor(
    public readonly from: MeasureUnit,
    public readonly to: Dimension,
    public readonly missing: 'density' | 'unit_weight' | 'unit_weight_and_density',
  ) {
    const what =
      missing === 'density'
        ? 'la densità (kg/l)'
        : missing === 'unit_weight'
          ? 'il peso medio unitario (kg/pz)'
          : 'peso medio unitario e densità'
    super(`Impossibile convertire ${from} in ${BASE_UNIT[to]}: serve ${what}.`)
  }
}

/**
 * Converte quantity/unit nella grandezza `target`, espressa nell'unità di base.
 * Lancia UnitConversionError se mancano i dati necessari.
 */
export function convertToDimension(quantity: Dec, unit: MeasureUnit, target: Dimension, data: ConversionData = {}): Dec {
  const source = dimensionOf(unit)
  const base = toBase(quantity, unit)
  if (source === target) return base

  const density = data.densityKgPerL && data.densityKgPerL.gt(0) ? data.densityKgPerL : null
  const unitWeight = data.unitWeightKg && data.unitWeightKg.gt(0) ? data.unitWeightKg : null

  // Porta tutto in massa, poi alla grandezza richiesta.
  let massKg: Dec
  if (source === 'mass') massKg = base
  else if (source === 'volume') {
    if (!density) throw new UnitConversionError(unit, target, 'density')
    massKg = base.times(density)
  } else {
    if (!unitWeight) throw new UnitConversionError(unit, target, target === 'volume' && !density ? 'unit_weight_and_density' : 'unit_weight')
    massKg = base.times(unitWeight)
  }

  if (target === 'mass') return massKg
  if (target === 'volume') {
    if (!density) throw new UnitConversionError(unit, target, source === 'count' ? 'unit_weight_and_density' : 'density')
    return massKg.div(density)
  }
  if (!unitWeight) throw new UnitConversionError(unit, target, 'unit_weight')
  return massKg.div(unitWeight)
}

export const MINUTES_PER_HOUR = d(60)
export { ONE }
