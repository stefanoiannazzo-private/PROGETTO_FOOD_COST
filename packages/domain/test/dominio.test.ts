import { describe, expect, it } from 'vitest'
import { d } from '../src/decimal'
import { DomainError, employeeRates, energyForUse, ingredientUsageCost } from '../src/calculators'
import { valueRecipe } from '../src/engine'
import { dependentsOf, findCycle } from '../src/graph'
import { parseItalianNumber } from '../src/format'
import { convertToDimension, UnitConversionError } from '../src/units'
import { serialize } from '../src/serialize'
import type { EquipmentInput, TariffInput } from '../src/types'
import { ctx, fixedCostRecipe, ingredient, recipe } from './fixtures'

describe('Resa edibile', () => {
  it('la quantità di ricetta è netta: acquistata = netta / resa, senza doppio addebito', () => {
    const carciofi = ingredient({ id: 'carciofi', packagePrice: '10', packageContent: '1', packageUnit: 'kg', edibleYield: d('0.4') })
    const u = ingredientUsageCost(carciofi, d(200), 'g')
    expect(u.netBaseQuantity.toFixed()).toBe('0.2')
    expect(u.grossBaseQuantity.toFixed()).toBe('0.5')
    expect(u.cost!.toFixed()).toBe('5')
  })
  it('rifiuta resa nulla o superiore al 100%', () => {
    expect(() => ingredientUsageCost(ingredient({ id: 'x', packagePrice: '1', packageContent: '1', packageUnit: 'kg', edibleYield: d(0) }), d(1), 'kg')).toThrow(DomainError)
    expect(() => ingredientUsageCost(ingredient({ id: 'x', packagePrice: '1', packageContent: '1', packageUnit: 'kg', edibleYield: d('1.1') }), d(1), 'kg')).toThrow(DomainError)
  })
})

describe('Conversioni di unità', () => {
  it('l/ml e kg/g', () => {
    expect(convertToDimension(d(750), 'ml', 'volume').toFixed()).toBe('0.75')
    expect(convertToDimension(d(150), 'g', 'mass').toFixed()).toBe('0.15')
  })
  it('non converte litri in kg senza densità né pezzi in grammi senza peso unitario', () => {
    expect(() => convertToDimension(d(1), 'l', 'mass')).toThrow(UnitConversionError)
    expect(() => convertToDimension(d(100), 'g', 'count')).toThrow(UnitConversionError)
  })
  it('converte con i dati espliciti', () => {
    expect(convertToDimension(d(1), 'l', 'mass', { densityKgPerL: d('0.92') }).toFixed()).toBe('0.92')
    expect(convertToDimension(d(120), 'g', 'count', { unitWeightKg: d('0.06') }).toFixed()).toBe('2')
  })
  it('ingrediente a pezzi dosato in grammi richiede il peso unitario', () => {
    const uova = ingredient({ id: 'uova', packagePrice: '3.6', packageContent: '12', packageUnit: 'pz' })
    const r = recipe({ id: 'r', components: [{ id: 'c', kind: 'ingredient', ingredientId: 'uova', quantity: d(120), unit: 'g' }] })
    const res = valueRecipe(ctx({ recipes: [r], ingredients: [uova] }), 'r')
    expect(res.complete).toBe(false)
    expect(res.issues.find((i) => i.code === 'unit_conversion')).toBeTruthy()
    const conPeso = { ...uova, unitWeightKg: d('0.06') }
    const ok = valueRecipe(ctx({ recipes: [r], ingredients: [conPeso] }), 'r')
    expect(ok.directIngredients.toFixed()).toBe('0.6') // 2 uova × 0,30 €
  })
})

describe('Dati mancanti, zero e divisori nulli', () => {
  it('prezzo mancante: costo incompleto, subtotale non spacciato per totale', () => {
    const a = ingredient({ id: 'a', packagePrice: null, packageContent: '1', packageUnit: 'kg' })
    const b = ingredient({ id: 'b', packagePrice: '4', packageContent: '1', packageUnit: 'kg' })
    const r = recipe({
      id: 'r',
      components: [
        { id: 'c1', kind: 'ingredient', ingredientId: 'a', quantity: d(1), unit: 'kg' },
        { id: 'c2', kind: 'ingredient', ingredientId: 'b', quantity: d(1), unit: 'kg' },
      ],
    })
    const res = valueRecipe(ctx({ recipes: [r], ingredients: [a, b] }), 'r')
    expect(res.complete).toBe(false)
    expect(res.total.toFixed()).toBe('4')
    expect(res.ingredientLines[0]!.cost).toBeNull()
    expect(res.issues.some((i) => i.code === 'missing_price' && i.severity === 'error')).toBe(true)
  })
  it('prezzo esplicitamente zero è valido ma segnalato', () => {
    const a = ingredient({ id: 'a', packagePrice: '0', packageContent: '1', packageUnit: 'kg' })
    const r = recipe({ id: 'r', components: [{ id: 'c', kind: 'ingredient', ingredientId: 'a', quantity: d(1), unit: 'kg' }] })
    const res = valueRecipe(ctx({ recipes: [r], ingredients: [a] }), 'r')
    expect(res.complete).toBe(true)
    expect(res.ingredientLines[0]!.zeroPrice).toBe(true)
    expect(res.issues.some((i) => i.code === 'zero_price' && i.severity === 'info')).toBe(true)
  })
  it('quantità zero non diventa un costo valido', () => {
    const a = ingredient({ id: 'a', packagePrice: '5', packageContent: '1', packageUnit: 'kg' })
    const r = recipe({ id: 'r', components: [{ id: 'c', kind: 'ingredient', ingredientId: 'a', quantity: d(0), unit: 'kg' }] })
    const res = valueRecipe(ctx({ recipes: [r], ingredients: [a] }), 'r')
    expect(res.complete).toBe(false)
    expect(res.ingredientLines[0]!.cost).toBeNull()
  })
  it('senza peso finale o porzioni non calcola costo/kg e costo/porzione', () => {
    const res = valueRecipe(ctx({ recipes: [recipe({ id: 'r' })] }), 'r')
    expect(res.costPerKg).toBeNull()
    expect(res.costPerPortion).toBeNull()
    expect(res.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['missing_final_weight', 'missing_portions']))
  })
  it('ore produttive zero sono rifiutate', () => {
    expect(() => employeeRates({ grossMonthly: d(1000), contributionsMode: 'none', contributionsValue: null, otherMonthlyCosts: null, productiveHours: d(0) })).toThrow(DomainError)
  })
  it('componente con entrambi o nessun riferimento è invalido', () => {
    const r = recipe({ id: 'r', components: [{ id: 'c', kind: 'ingredient', ingredientId: 'a', recipeId: 'b', quantity: d(1), unit: 'kg' }] })
    const res = valueRecipe(ctx({ recipes: [r] }), 'r')
    expect(res.issues[0]!.code).toBe('invalid_component')
  })
})

describe('Costo del lavoro', () => {
  it('oneri in percentuale sul lordo e altri costi', () => {
    const r = employeeRates({ grossMonthly: d(2000), contributionsMode: 'percent', contributionsValue: d(30), otherMonthlyCosts: d(200), productiveHours: d(160) })
    expect(r.companyMonthly.toFixed()).toBe('2800')
    expect(r.companyHourly.toFixed()).toBe('17.5')
    expect(r.basis).toBe('company_cost')
  })
  it('più dipendenti nella stessa fase e quota di imputazione', () => {
    const emp = (id: string) => ({ employeeId: id, code: id, name: id, grossMonthly: d(2400), contributionsMode: 'amount' as const, contributionsValue: d(0), otherMonthlyCosts: d(0), productiveHours: d(160) })
    const r = recipe({
      id: 'r',
      laborAssignments: [
        { id: 'l1', employeeId: 'a', phaseId: 'f1', activeMinutes: d(10), share: d(1) },
        { id: 'l2', employeeId: 'b', phaseId: 'f1', activeMinutes: d(20), share: d('0.5') },
      ],
    })
    const res = valueRecipe(ctx({ recipes: [r], employees: [emp('a'), emp('b')] }), 'r')
    expect(res.labor.toFixed()).toBe('5') // 10×0,25 + 20×0,25×0,5
    expect(res.personMinutes.toFixed()).toBe('30')
  })
})

describe('Energia', () => {
  const t: TariffInput = { id: 't', name: 'Luce', kind: 'electricity', unit: 'kwh', pricePerUnit: d('0.30') }
  const g: TariffInput = { id: 'g', name: 'Gas', kind: 'gas', unit: 'm3', pricePerUnit: d('1.20') }
  const tariffs = new Map([['t', t], ['g', g]])

  it('il consumo misurato sostituisce la stima senza sommarsi', () => {
    const eq: EquipmentInput = { id: 'f', code: 'F', name: 'Forno', powerType: 'electric', electric: { powerKw: d(3), usageCoefficient: d('0.8'), tariffId: 't' } }
    const e = energyForUse({ equipment: eq, segment: 'work', minutes: d(40), measuredElectricKwh: d(2), tariffs })
    expect(e.sources[0]!.estimated).toBe(false)
    expect(e.sources[0]!.cost!.toFixed()).toBe('0.6')
  })
  it('alimentazione mista: calcola distintamente le fonti usate', () => {
    const eq: EquipmentInput = {
      id: 'm',
      code: 'M',
      name: 'Forno misto',
      powerType: 'mixed',
      electric: { powerKw: d(3), usageCoefficient: d('0.8'), tariffId: 't' },
      gas: { mode: 'flow', flowPerHour: d(2), flowUnit: 'm3', tariffId: 'g' },
    }
    const both = energyForUse({ equipment: eq, segment: 'work', minutes: d(40), tariffs })
    expect(both.sources.map((s) => [s.source, s.cost!.toFixed()])).toEqual([
      ['electric', '0.48'],
      ['gas', '1.6'],
    ])
    const onlyGas = energyForUse({ equipment: eq, segment: 'work', minutes: d(40), sources: ['gas'], tariffs })
    expect(onlyGas.sources).toHaveLength(1)
  })
  it('strumento manuale ha costo energetico esplicitamente nullo', () => {
    const r = recipe({ id: 'r', equipmentUses: [{ id: 'u', equipmentId: 'mano', segment: 'work', minutes: d(10), share: d(1) }] })
    const res = valueRecipe(ctx({ recipes: [r], equipment: [{ id: 'mano', code: 'M', name: 'Mattarello', powerType: 'manual' }] }), 'r')
    expect(res.complete).toBe(true)
    expect(res.equipmentLines[0]!.cost!.toFixed()).toBe('0')
  })
  it('parametri mancanti producono costo incompleto, mai consumi inventati', () => {
    const eq: EquipmentInput = { id: 'f', code: 'F', name: 'Forno', powerType: 'electric', electric: { powerKw: null, usageCoefficient: d('0.8'), tariffId: 't' } }
    const r = recipe({ id: 'r', equipmentUses: [{ id: 'u', equipmentId: 'f', segment: 'work', minutes: d(10), share: d(1) }] })
    const res = valueRecipe(ctx({ recipes: [r], equipment: [eq], tariffs: [t] }), 'r')
    expect(res.complete).toBe(false)
    expect(res.issues.some((i) => i.code === 'missing_power')).toBe(true)
  })
  it('forno condiviso: costo uso × quota dichiarata; preriscaldamento come segmento separato', () => {
    const eq: EquipmentInput = { id: 'f', code: 'F', name: 'Forno', powerType: 'electric', electric: { powerKw: d(6), usageCoefficient: d('0.5'), preheatCoefficient: d(1), tariffId: 't' } }
    const r = recipe({
      id: 'r',
      equipmentUses: [
        { id: 'pre', equipmentId: 'f', segment: 'preheat', minutes: d(10), share: d('0.5') },
        { id: 'cott', equipmentId: 'f', segment: 'work', minutes: d(60), share: d('0.5') },
      ],
    })
    const res = valueRecipe(ctx({ recipes: [r], equipment: [eq], tariffs: [t] }), 'r')
    // preriscaldamento: 6 × 10/60 × 1 = 1 kWh; cottura: 6 × 1 × 0,5 = 3 kWh; totale 4 kWh × 0,30 × 50%
    expect(res.equipmentLines.map((l) => l.fullCost!.toFixed())).toEqual(['0.3', '0.9'])
    expect(res.energy.toFixed()).toBe('0.6')
    expect(res.machineMinutes.toFixed()).toBe('70')
  })
})

describe('Ricette annidate', () => {
  it('cicli su più livelli sono rilevati con il percorso', () => {
    const edges = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ])
    expect(findCycle(edges, 'c', ['a'])).toEqual(['c', 'a', 'b', 'c'])
    expect(findCycle(edges, 'c', [])).toBeNull()
    expect(findCycle(edges, 'a', ['a'])).toEqual(['a', 'a'])
  })

  it('il motore segnala i cicli invece di andare in ricorsione infinita', () => {
    const a = recipe({ id: 'A', components: [{ id: 'c1', kind: 'recipe', recipeId: 'B', quantity: d(1), unit: 'kg' }] })
    const b = recipe({ id: 'B', finalWeightKg: d(1), components: [{ id: 'c2', kind: 'recipe', recipeId: 'A', quantity: d(1), unit: 'kg' }] })
    const res = valueRecipe(ctx({ recipes: [a, b] }), 'A')
    const cycle = res.issues.find((i) => i.code === 'cycle')!
    expect(cycle.path).toEqual(['A', 'B', 'A'])
  })

  it('sottoricetta condivisa in un grafo senza cicli: i fabbisogni si sommano', () => {
    const base = fixedCostRecipe('besciamella', { ingredients: '10', energy: '0', labor: '0', finalWeightKg: '2' })
    const r = recipe({
      id: 'piatto',
      components: [
        { id: 'x1', kind: 'recipe', recipeId: 'besciamella', quantity: d(500), unit: 'g' },
        { id: 'x2', kind: 'recipe', recipeId: 'besciamella', quantity: d(1), unit: 'kg' },
      ],
    })
    const res = valueRecipe(ctx({ recipes: [base.recipe, r], ingredients: [base.ingredient], tariffs: [base.tariff], equipment: [base.equipment], employees: [base.employee] }), 'piatto')
    expect(res.subrecipeLines.map((l) => l.cost!.toFixed())).toEqual(['2.5', '5'])
    expect(res.total.toFixed()).toBe('7.5')
  })

  it('tre livelli: il costo risale proporzionato alla quantità prelevata', () => {
    const brodo = fixedCostRecipe('brodo', { ingredients: '4', energy: '0', labor: '0', finalWeightKg: '4' }) // 1 €/kg
    const ragu = recipe({ id: 'ragu', finalWeightKg: d(2), components: [{ id: 'r1', kind: 'recipe', recipeId: 'brodo', quantity: d(2), unit: 'kg' }] }) // 2 € / 2 kg
    const lasagna = recipe({ id: 'lasagna', finalWeightKg: d(1), components: [{ id: 'l1', kind: 'recipe', recipeId: 'ragu', quantity: d(500), unit: 'g' }] })
    const c = ctx({ recipes: [brodo.recipe, ragu, lasagna], ingredients: [brodo.ingredient], tariffs: [brodo.tariff], equipment: [brodo.equipment], employees: [brodo.employee] })
    const res = valueRecipe(c, 'lasagna')
    expect(res.total.toFixed()).toBe('0.5')
    expect(res.expanded.ingredients.toFixed()).toBe('0.5')
  })

  it('dosaggio in unità incompatibili con la resa richiede dati espliciti', () => {
    const salsa = recipe({ id: 'salsa', finalQuantity: d(2), finalUnit: 'l' })
    const r = recipe({ id: 'r', components: [{ id: 'c', kind: 'recipe', recipeId: 'salsa', quantity: d(100), unit: 'g' }] })
    const res = valueRecipe(ctx({ recipes: [salsa, r] }), 'r')
    expect(res.issues.some((i) => i.code === 'incompatible_subrecipe_unit')).toBe(true)
    const r2 = recipe({ id: 'r2', components: [{ id: 'c', kind: 'recipe', recipeId: 'salsa', quantity: d(500), unit: 'ml' }] })
    const ok = valueRecipe(ctx({ recipes: [salsa, r2] }), 'r2')
    expect(ok.subrecipeLines[0]!.basis).toBe('yield')
    expect(ok.subrecipeLines[0]!.fraction!.toFixed()).toBe('0.25')
  })

  it('le ricette dipendenti da un ingrediente cambiato sono trovate anche indirettamente', () => {
    const edges = new Map<string, string[]>([
      ['lasagna', ['ragu']],
      ['ragu', ['brodo']],
      ['torta', []],
    ])
    expect([...dependentsOf(edges, ['brodo'])].sort()).toEqual(['lasagna', 'ragu'])
  })
})

describe('Formati italiani', () => {
  it('interpreta virgola decimale e separatori delle migliaia', () => {
    expect(parseItalianNumber('1.234,56')!.toFixed()).toBe('1234.56')
    expect(parseItalianNumber('0,9')!.toFixed()).toBe('0.9')
    expect(parseItalianNumber('2.400', 'it')!.toFixed()).toBe('2400')
    expect(parseItalianNumber('12.5')!.toFixed()).toBe('12.5')
    expect(parseItalianNumber('1,234.56', 'en')!.toFixed()).toBe('1234.56')
    expect(parseItalianNumber('€ 30,00')!.toFixed()).toBe('30')
    expect(parseItalianNumber('abc')).toBeNull()
    expect(parseItalianNumber('1,2,3')).toBeNull()
  })
  it('serializza i decimali come stringhe senza perdita di precisione', () => {
    expect(serialize({ a: d('0.1').plus('0.2'), b: [d('2.385')] })).toEqual({ a: '0.3', b: ['2.385'] })
  })
})
