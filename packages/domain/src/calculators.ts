import { Dec, d, ONE, SIXTY, ZERO } from './decimal'
import { BASE_UNIT, convertToDimension, dimensionOf, type MeasureUnit, UnitConversionError } from './units'
import type { EmployeeCostInput, EquipmentInput, EnergySourceDetail, IngredientInput, Segment, TariffInput, TariffUnit } from './types'

/* ============================ Ingredienti ============================ */

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Prezzo normalizzato per unità di base (€/kg, €/l o €/pz) a partire dalla confezione. */
export function normalizedPrice(ing: Pick<IngredientInput, 'packagePrice' | 'packageContent' | 'packageUnit'>): Dec | null {
  if (ing.packagePrice === null) return null
  const contentBase = convertToDimension(ing.packageContent, ing.packageUnit, dimensionOf(ing.packageUnit))
  if (contentBase.lte(0)) throw new DomainError('invalid_package_content', 'Il contenuto della confezione deve essere maggiore di zero.')
  return ing.packagePrice.div(contentBase)
}

export interface IngredientUsage {
  netBaseQuantity: Dec
  grossBaseQuantity: Dec
  baseUnit: MeasureUnit
  unitPrice: Dec | null
  cost: Dec | null
}

/**
 * Costo dell'utilizzo di un ingrediente.
 * La quantità di ricetta è netta: quantità acquistata equivalente = netta / resa edibile.
 * La resa si applica una sola volta e lo scarto non viene riaddebitato altrove.
 */
export function ingredientUsageCost(ing: IngredientInput, quantity: Dec, unit: MeasureUnit): IngredientUsage {
  if (ing.edibleYield.lte(0) || ing.edibleYield.gt(1)) {
    throw new DomainError('invalid_yield', `Resa edibile non valida per ${ing.name}: deve essere maggiore di 0 e al massimo 100%.`)
  }
  const dimension = dimensionOf(ing.packageUnit)
  const netBaseQuantity = convertToDimension(quantity, unit, dimension, {
    densityKgPerL: ing.densityKgPerL ?? null,
    unitWeightKg: ing.unitWeightKg ?? null,
  })
  const grossBaseQuantity = netBaseQuantity.div(ing.edibleYield)
  const unitPrice = normalizedPrice(ing)
  return {
    netBaseQuantity,
    grossBaseQuantity,
    baseUnit: BASE_UNIT[dimension],
    unitPrice,
    cost: unitPrice === null ? null : grossBaseQuantity.times(unitPrice),
  }
}

/* ============================ Manodopera ============================ */

export interface EmployeeCostRates {
  grossHourly: Dec
  companyMonthly: Dec
  companyHourly: Dec
  costPerMinute: Dec
  contributions: Dec
  basis: 'company_cost' | 'gross_only'
}

export function employeeRates(e: Pick<EmployeeCostInput, 'grossMonthly' | 'contributionsMode' | 'contributionsValue' | 'otherMonthlyCosts' | 'productiveHours'>): EmployeeCostRates {
  if (e.productiveHours.lte(0)) throw new DomainError('invalid_hours', 'Le ore mensili produttive devono essere maggiori di zero.')
  if (e.grossMonthly.lt(0)) throw new DomainError('invalid_gross', 'Il lordo mensile non può essere negativo.')
  let contributions = ZERO
  if (e.contributionsMode === 'amount') contributions = e.contributionsValue ?? ZERO
  else if (e.contributionsMode === 'percent') contributions = e.grossMonthly.times(e.contributionsValue ?? ZERO).div(100)
  const other = e.otherMonthlyCosts ?? ZERO
  const companyMonthly = e.grossMonthly.plus(contributions).plus(other)
  const companyHourly = companyMonthly.div(e.productiveHours)
  const onlyGross = e.contributionsMode === 'none' && other.isZero()
  return {
    grossHourly: e.grossMonthly.div(e.productiveHours),
    companyMonthly,
    companyHourly,
    costPerMinute: companyHourly.div(SIXTY),
    contributions,
    basis: onlyGross ? 'gross_only' : 'company_cost',
  }
}

/** Costo = minuti attivi × costo al minuto × quota. */
export function laborCost(activeMinutes: Dec, costPerMinute: Dec, share: Dec = ONE): Dec {
  return activeMinutes.times(costPerMinute).times(share)
}

/* ============================== Energia ============================== */

/** Consumo elettrico stimato: kWh = kW × minuti / 60 × coefficiente di utilizzo. */
export function electricConsumptionKwh(powerKw: Dec, minutes: Dec, coefficient: Dec): Dec {
  return powerKw.times(minutes).div(SIXTY).times(coefficient)
}

/** Consumo gas da portata: consumo = portata oraria × minuti / 60 [× fattore di carico]. */
export function gasConsumption(flowPerHour: Dec, minutes: Dec, loadFactor: Dec | null = null): Dec {
  const base = flowPerHour.times(minutes).div(SIXTY)
  return loadFactor ? base.times(loadFactor) : base
}

/**
 * Porta un consumo nell'unità della tariffa usando solo coefficienti esplicitamente configurati.
 * m³ e Smc non sono equivalenti; gas → kWh richiede il potere calorifico (kWh/Smc).
 */
export function convertGasToTariffUnit(quantity: Dec, from: TariffUnit, tariff: Pick<TariffInput, 'unit' | 'm3ToSmc' | 'smcToKwh' | 'name'>): Dec {
  if (from === tariff.unit) return quantity
  const m3ToSmc = tariff.m3ToSmc && tariff.m3ToSmc.gt(0) ? tariff.m3ToSmc : null
  const smcToKwh = tariff.smcToKwh && tariff.smcToKwh.gt(0) ? tariff.smcToKwh : null
  if (from === 'm3' && tariff.unit === 'smc' && m3ToSmc) return quantity.times(m3ToSmc)
  if (from === 'smc' && tariff.unit === 'm3' && m3ToSmc) return quantity.div(m3ToSmc)
  if (from === 'smc' && tariff.unit === 'kwh' && smcToKwh) return quantity.times(smcToKwh)
  if (from === 'm3' && tariff.unit === 'kwh' && m3ToSmc && smcToKwh) return quantity.times(m3ToSmc).times(smcToKwh)
  if (from === 'kwh' && tariff.unit === 'smc' && smcToKwh) return quantity.div(smcToKwh)
  if (from === 'kwh' && tariff.unit === 'm3' && m3ToSmc && smcToKwh) return quantity.div(smcToKwh).div(m3ToSmc)
  throw new DomainError(
    'gas_unit_mismatch',
    `La tariffa "${tariff.name}" è in €/${unitLabel(tariff.unit)} ma il consumo è in ${unitLabel(from)}: configura il coefficiente di conversione sulla tariffa.`,
  )
}

export function unitLabel(u: TariffUnit): string {
  return u === 'kwh' ? 'kWh' : u === 'm3' ? 'm³' : 'Smc'
}

function coefficientFor(segment: Segment, el: NonNullable<EquipmentInput['electric']>): Dec | null {
  if (segment === 'preheat' && el.preheatCoefficient) return el.preheatCoefficient
  if (segment === 'hold' && el.holdCoefficient) return el.holdCoefficient
  return el.usageCoefficient
}

export interface EnergyIssue {
  code: string
  message: string
}

export interface EnergyUseRequest {
  equipment: EquipmentInput
  segment: Segment
  minutes: Dec
  sources?: Array<'electric' | 'gas'> | null
  measuredElectricKwh?: Dec | null
  measuredGasQuantity?: Dec | null
  measuredGasUnit?: TariffUnit | null
  tariffs: Map<string, TariffInput>
}

/** Calcola le fonti energetiche di un uso strumento. Non applica la quota di imputazione. */
export function energyForUse(req: EnergyUseRequest): { sources: EnergySourceDetail[]; issues: EnergyIssue[]; manual: boolean } {
  const eq = req.equipment
  const issues: EnergyIssue[] = []
  if (eq.powerType === 'manual') return { sources: [], issues, manual: true }

  const wanted: Array<'electric' | 'gas'> =
    eq.powerType === 'electric' ? ['electric'] : eq.powerType === 'gas' ? ['gas'] : req.sources && req.sources.length > 0 ? req.sources : ['electric', 'gas']

  const sources: EnergySourceDetail[] = []

  for (const source of wanted) {
    const detail: EnergySourceDetail = {
      source,
      estimated: true,
      consumption: null,
      consumptionUnit: null,
      billedConsumption: null,
      tariffId: null,
      tariffUnit: null,
      tariffPrice: null,
      coefficient: null,
      cost: null,
    }
    sources.push(detail)

    if (source === 'electric') {
      const el = eq.electric
      if (!el) {
        issues.push({ code: 'missing_electric_params', message: `${eq.name}: parametri elettrici non configurati.` })
        continue
      }
      detail.consumptionUnit = 'kwh'
      if (req.measuredElectricKwh != null) {
        detail.consumption = req.measuredElectricKwh
        detail.estimated = false
      } else {
        const coeff = coefficientFor(req.segment, el)
        detail.coefficient = coeff
        if (!el.powerKw || el.powerKw.lte(0)) {
          issues.push({ code: 'missing_power', message: `${eq.name}: potenza nominale (kW) mancante.` })
          continue
        }
        if (!coeff || coeff.lte(0) || coeff.gt(1)) {
          issues.push({ code: 'missing_coefficient', message: `${eq.name}: coefficiente di utilizzo mancante o fuori intervallo (0–1].` })
          continue
        }
        detail.consumption = electricConsumptionKwh(el.powerKw, req.minutes, coeff)
      }
      const tariff = el.tariffId ? req.tariffs.get(el.tariffId) : undefined
      if (!tariff) {
        issues.push({ code: 'missing_tariff', message: `${eq.name}: tariffa elettrica non configurata o non valida alla data.` })
        continue
      }
      detail.tariffId = tariff.id
      detail.tariffUnit = tariff.unit
      detail.tariffPrice = tariff.pricePerUnit
      if (tariff.kind !== 'electricity' || tariff.unit !== 'kwh') {
        issues.push({ code: 'tariff_unit_mismatch', message: `${eq.name}: la tariffa elettrica deve essere in €/kWh.` })
        continue
      }
      detail.billedConsumption = detail.consumption
      detail.cost = detail.consumption.times(tariff.pricePerUnit)
    } else {
      const gas = eq.gas
      if (!gas) {
        issues.push({ code: 'missing_gas_params', message: `${eq.name}: parametri gas non configurati.` })
        continue
      }
      if (req.measuredGasQuantity != null) {
        if (!req.measuredGasUnit) {
          issues.push({ code: 'missing_measured_unit', message: `${eq.name}: unità del consumo gas misurato mancante.` })
          continue
        }
        detail.consumption = req.measuredGasQuantity
        detail.consumptionUnit = req.measuredGasUnit
        detail.estimated = false
      } else if (gas.mode === 'flow') {
        if (!gas.flowPerHour || gas.flowPerHour.lte(0) || !gas.flowUnit) {
          issues.push({ code: 'missing_gas_flow', message: `${eq.name}: portata gas oraria o relativa unità mancante.` })
          continue
        }
        detail.coefficient = gas.loadFactor ?? null
        detail.consumption = gasConsumption(gas.flowPerHour, req.minutes, gas.loadFactor ?? null)
        detail.consumptionUnit = gas.flowUnit
      } else {
        if (!gas.powerKw || gas.powerKw.lte(0)) {
          issues.push({ code: 'missing_power', message: `${eq.name}: potenza gas (kW) mancante.` })
          continue
        }
        detail.coefficient = gas.loadFactor ?? null
        detail.consumption = electricConsumptionKwh(gas.powerKw, req.minutes, gas.loadFactor ?? ONE)
        detail.consumptionUnit = 'kwh'
      }
      const tariff = gas.tariffId ? req.tariffs.get(gas.tariffId) : undefined
      if (!tariff) {
        issues.push({ code: 'missing_tariff', message: `${eq.name}: tariffa gas non configurata o non valida alla data.` })
        continue
      }
      detail.tariffId = tariff.id
      detail.tariffUnit = tariff.unit
      detail.tariffPrice = tariff.pricePerUnit
      if (tariff.kind !== 'gas') {
        issues.push({ code: 'tariff_unit_mismatch', message: `${eq.name}: la tariffa associata al gas non è una tariffa gas.` })
        continue
      }
      try {
        detail.billedConsumption = convertGasToTariffUnit(detail.consumption, detail.consumptionUnit!, tariff)
        detail.cost = detail.billedConsumption.times(tariff.pricePerUnit)
      } catch (e) {
        if (e instanceof DomainError) issues.push({ code: e.code, message: `${eq.name}: ${e.message}` })
        else throw e
      }
    }
  }
  return { sources, issues, manual: false }
}

export { UnitConversionError, d }
