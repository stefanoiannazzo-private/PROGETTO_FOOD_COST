import { describe, expect, it } from 'vitest'
import { d, round } from '../src/decimal'
import {
  convertGasToTariffUnit,
  DomainError,
  electricConsumptionKwh,
  employeeRates,
  energyForUse,
  gasConsumption,
  ingredientUsageCost,
  laborCost,
} from '../src/calculators'
import { valueRecipe } from '../src/engine'
import type { EquipmentInput, TariffInput } from '../src/types'
import { ctx, fixedCostRecipe, ingredient, recipe } from './fixtures'

/** Verifiche numeriche obbligatorie del capitolato (§14). */

describe('A. Conversione ingrediente', () => {
  it('confezione 5 kg a 30 € → 150 g costano 0,90 €', () => {
    const ing = ingredient({ id: 'farina', packagePrice: '30', packageContent: '5', packageUnit: 'kg' })
    const u = ingredientUsageCost(ing, d(150), 'g')
    expect(u.unitPrice!.toFixed()).toBe('6')
    expect(u.cost!.toFixed()).toBe('0.9')
  })
})

describe('B. Costo del dipendente', () => {
  it('2.400 € lordi, nessun onere, 160 ore → 15 €/h, 0,25 €/min, 12 min = 3 € (solo lordo)', () => {
    const rates = employeeRates({ grossMonthly: d(2400), contributionsMode: 'none', contributionsValue: null, otherMonthlyCosts: null, productiveHours: d(160) })
    expect(rates.grossHourly.toFixed()).toBe('15')
    expect(rates.companyHourly.toFixed()).toBe('15')
    expect(rates.costPerMinute.toFixed()).toBe('0.25')
    expect(rates.basis).toBe('gross_only')
    expect(laborCost(d(12), rates.costPerMinute).toFixed()).toBe('3')
  })

  it('la ricetta segnala che il costo comprende il solo lordo', () => {
    const r = recipe({ id: 'r', laborAssignments: [{ id: 'l', employeeId: 'e', activeMinutes: d(12), share: d(1) }] })
    const res = valueRecipe(
      ctx({
        recipes: [r],
        employees: [{ employeeId: 'e', code: 'E1', name: 'Mario Rossi', grossMonthly: d(2400), contributionsMode: 'none', contributionsValue: null, otherMonthlyCosts: null, productiveHours: d(160) }],
      }),
      'r',
    )
    expect(res.labor.toFixed()).toBe('3')
    expect(res.laborLines[0]!.basis).toBe('gross_only')
    expect(res.issues.some((i) => i.code === 'gross_only' && i.severity === 'warning')).toBe(true)
  })
})

describe('C. Consumo elettrico', () => {
  it('3 kW, 40 minuti, coefficiente 0,8, 0,30 €/kWh → 1,6 kWh e 0,48 €', () => {
    const kwh = electricConsumptionKwh(d(3), d(40), d('0.8'))
    expect(kwh.toFixed()).toBe('1.6')
    expect(kwh.times('0.30').toFixed()).toBe('0.48')

    const tariff: TariffInput = { id: 't', name: 'Luce', kind: 'electricity', unit: 'kwh', pricePerUnit: d('0.30') }
    const eq: EquipmentInput = { id: 'forno', code: 'F1', name: 'Forno', powerType: 'electric', electric: { powerKw: d(3), usageCoefficient: d('0.8'), tariffId: 't' } }
    const e = energyForUse({ equipment: eq, segment: 'work', minutes: d(40), tariffs: new Map([['t', tariff]]) })
    expect(e.issues).toEqual([])
    expect(e.sources[0]!.consumption!.toFixed()).toBe('1.6')
    expect(e.sources[0]!.cost!.toFixed()).toBe('0.48')
  })
})

describe('D. Consumo gas', () => {
  const eq: EquipmentInput = { id: 'piastra', code: 'P1', name: 'Piastra', powerType: 'gas', gas: { mode: 'flow', flowPerHour: d(2), flowUnit: 'm3', tariffId: 'g' } }

  it('2 m³/h, 15 minuti, 1,20 €/m³ → 0,5 m³ e 0,60 €', () => {
    expect(gasConsumption(d(2), d(15)).toFixed()).toBe('0.5')
    const tariff: TariffInput = { id: 'g', name: 'Gas', kind: 'gas', unit: 'm3', pricePerUnit: d('1.20') }
    const e = energyForUse({ equipment: eq, segment: 'work', minutes: d(15), tariffs: new Map([['g', tariff]]) })
    expect(e.issues).toEqual([])
    expect(e.sources[0]!.consumption!.toFixed()).toBe('0.5')
    expect(e.sources[0]!.cost!.toFixed()).toBe('0.6')
  })

  it('rifiuta una tariffa €/Smc senza conversione configurata', () => {
    const tariff: TariffInput = { id: 'g', name: 'Gas Smc', kind: 'gas', unit: 'smc', pricePerUnit: d('1.20') }
    expect(() => convertGasToTariffUnit(d('0.5'), 'm3', tariff)).toThrow(DomainError)
    const e = energyForUse({ equipment: eq, segment: 'work', minutes: d(15), tariffs: new Map([['g', tariff]]) })
    expect(e.sources[0]!.cost).toBeNull()
    expect(e.issues[0]!.code).toBe('gas_unit_mismatch')
  })

  it('accetta €/Smc solo con coefficiente m³→Smc esplicito', () => {
    const tariff: TariffInput = { id: 'g', name: 'Gas Smc', kind: 'gas', unit: 'smc', pricePerUnit: d('1.20'), m3ToSmc: d('0.95') }
    const e = energyForUse({ equipment: eq, segment: 'work', minutes: d(15), tariffs: new Map([['g', tariff]]) })
    expect(e.sources[0]!.billedConsumption!.toFixed()).toBe('0.475')
    expect(e.sources[0]!.cost!.toFixed()).toBe('0.57')
  })
})

describe('E. Ricetta annidata ragù → lasagna', () => {
  const ragu = fixedCostRecipe('ragu', { ingredients: '20', energy: '2', labor: '12', finalWeightKg: '5' })
  const lasagna = fixedCostRecipe('lasagna', {
    ingredients: '8',
    energy: '1',
    labor: '6',
    finalWeightKg: '2.4',
    portions: '8',
  })
  lasagna.recipe.components.push({ id: 'lasagna-ragu', kind: 'recipe', recipeId: 'ragu', quantity: d(600), unit: 'g' })

  const all = [ragu, lasagna]
  const context = ctx({
    recipes: all.map((x) => x.recipe),
    ingredients: all.map((x) => x.ingredient),
    tariffs: all.map((x) => x.tariff),
    equipment: all.map((x) => x.equipment),
    employees: all.map((x) => x.employee),
  })

  it('ragù: totale 34 €, 6,80 €/kg', () => {
    const r = valueRecipe(context, 'ragu')
    expect(r.complete).toBe(true)
    expect(r.directIngredients.toFixed()).toBe('20')
    expect(r.energy.toFixed()).toBe('2')
    expect(r.labor.toFixed()).toBe('12')
    expect(r.total.toFixed()).toBe('34')
    expect(r.costPerKg!.toFixed()).toBe('6.8')
  })

  it('lasagna: 600 g di ragù = 4,08 €, totale 19,08 €, 7,95 €/kg, 2,385 €/porzione (2,39 €)', () => {
    const l = valueRecipe(context, 'lasagna')
    expect(l.complete).toBe(true)
    expect(l.subrecipeLines[0]!.cost!.toFixed()).toBe('4.08')
    expect(l.subrecipeLines[0]!.basis).toBe('weight')
    expect(l.directIngredients.toFixed()).toBe('8')
    expect(l.energy.toFixed()).toBe('1')
    expect(l.labor.toFixed()).toBe('6')
    expect(l.total.toFixed()).toBe('19.08')
    expect(l.costPerKg!.toFixed()).toBe('7.95')
    expect(l.costPerPortion!.toFixed()).toBe('2.385')
    expect(round(l.costPerPortion!).toFixed(2)).toBe('2.39')
  })

  it('i costi di produzione del ragù non sono aggiunti una seconda volta', () => {
    const l = valueRecipe(context, 'lasagna')
    // il totale contiene il ragù solo come subtotale di riga
    expect(l.directIngredients.plus(l.subrecipes).plus(l.energy).plus(l.labor).toFixed()).toBe('19.08')
    // il riepilogo espanso redistribuisce i 4,08 € nelle categorie, senza aggiungerli
    const exp = l.expanded
    expect(exp.ingredients.toFixed()).toBe('10.4') // 8 + 20 × 0,12
    expect(exp.energy.toFixed()).toBe('1.24') // 1 + 2 × 0,12
    expect(exp.labor.toFixed()).toBe('7.44') // 6 + 12 × 0,12
    expect(exp.ingredients.plus(exp.energy).plus(exp.labor).toFixed()).toBe('19.08')
  })
})
