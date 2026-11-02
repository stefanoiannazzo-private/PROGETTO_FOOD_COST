import { d } from '../src/decimal'
import type { EmployeeCostInput, EquipmentInput, IngredientInput, RecipeInput, TariffInput, ValuationContext } from '../src/types'

export function ingredient(
  p: Partial<Omit<IngredientInput, 'packagePrice' | 'packageContent'>> & { id: string; packagePrice: string | null; packageContent: string; packageUnit: IngredientInput['packageUnit'] },
): IngredientInput {
  return {
    code: p.id.toUpperCase(),
    name: p.id,
    edibleYield: d(1),
    ...p,
    packagePrice: p.packagePrice === null ? null : d(p.packagePrice),
    packageContent: d(p.packageContent),
  }
}

export function recipe(p: Partial<RecipeInput> & { id: string }): RecipeInput {
  return {
    revisionId: `${p.id}-r1`,
    code: p.id.toUpperCase(),
    title: p.id,
    finalQuantity: null,
    finalUnit: null,
    finalWeightKg: null,
    portions: null,
    declaredDurationMinutes: null,
    phases: [],
    components: [],
    equipmentUses: [],
    laborAssignments: [],
    ...p,
  }
}

export function ctx(parts: {
  recipes?: RecipeInput[]
  ingredients?: IngredientInput[]
  equipment?: EquipmentInput[]
  tariffs?: TariffInput[]
  employees?: EmployeeCostInput[]
}): ValuationContext {
  return {
    date: '2026-11-02',
    recipes: new Map((parts.recipes ?? []).map((r) => [r.id, r])),
    ingredients: new Map((parts.ingredients ?? []).map((i) => [i.id, i])),
    equipment: new Map((parts.equipment ?? []).map((e) => [e.id, e])),
    tariffs: new Map((parts.tariffs ?? []).map((t) => [t.id, t])),
    employees: new Map((parts.employees ?? []).map((e) => [e.employeeId, e])),
  }
}

/**
 * Ricetta "a costo fisso" usata per il caso E: un ingrediente fittizio con prezzo
 * pari alla cifra voluta, uno strumento manuale e una manodopera tarati sui valori richiesti.
 */
export function fixedCostRecipe(id: string, opts: { ingredients: string; energy: string; labor: string; finalWeightKg: string; portions?: string; extra?: Partial<RecipeInput> }) {
  const ing = ingredient({ id: `${id}-ing`, packagePrice: opts.ingredients, packageContent: '1', packageUnit: 'kg' })
  // energia: 1 kW × 60 min × coefficiente 1 = 1 kWh; tariffa = cifra richiesta €/kWh
  const tariff: TariffInput = { id: `${id}-el`, name: `${id} elettricità`, kind: 'electricity', unit: 'kwh', pricePerUnit: d(opts.energy) }
  const eq: EquipmentInput = {
    id: `${id}-eq`,
    code: `${id}-EQ`,
    name: `${id} strumento`,
    powerType: 'electric',
    electric: { powerKw: d(1), usageCoefficient: d(1), tariffId: tariff.id },
  }
  // manodopera: 60 minuti a (cifra × 60) €/h → costo = cifra
  const emp: EmployeeCostInput = {
    employeeId: `${id}-emp`,
    code: `${id}-E`,
    name: `${id} addetto`,
    grossMonthly: d(opts.labor).times(60),
    contributionsMode: 'amount',
    contributionsValue: d(0),
    otherMonthlyCosts: d(0),
    productiveHours: d(60),
  }
  const r = recipe({
    id,
    finalQuantity: d(opts.finalWeightKg),
    finalUnit: 'kg',
    finalWeightKg: d(opts.finalWeightKg),
    portions: opts.portions ? d(opts.portions) : null,
    components: [{ id: `${id}-c1`, kind: 'ingredient', ingredientId: ing.id, quantity: d(1), unit: 'kg' }],
    equipmentUses: [{ id: `${id}-u1`, equipmentId: eq.id, segment: 'work', minutes: d(60), share: d(1) }],
    laborAssignments: [{ id: `${id}-l1`, employeeId: emp.employeeId, activeMinutes: d(60), share: d(1) }],
    ...opts.extra,
  })
  return { recipe: r, ingredient: ing, tariff, equipment: eq, employee: emp }
}
