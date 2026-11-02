import { sql, type Kysely, type Selectable } from 'kysely'
import {
  d,
  dependentsOf,
  descendantsOf,
  RecipeCostEngine,
  serialize,
  type EmployeeCostInput,
  type EquipmentInput,
  type IngredientInput,
  type MeasureUnit,
  type RecipeCost,
  type RecipeInput,
  type Serialized,
  type TariffInput,
  type ValuationContext,
} from '@foodcost/domain'
import type { DB, EquipmentTable } from '../db/types'

type Db = Kysely<DB>
const dn = (v: string | null | undefined) => (v === null || v === undefined ? null : d(v))

/* ======================= Grafo delle dipendenze ======================= */

/** Archi padre → sottoricetta secondo le revisioni correnti dell'azienda. */
export async function loadEdges(db: Db, companyId: string): Promise<Map<string, string[]>> {
  const rows = await db
    .selectFrom('recipes as r')
    .innerJoin('recipe_components as c', 'c.revision_id', 'r.current_revision_id')
    .select(['r.id as parent', 'c.sub_recipe_id as child'])
    .where('r.company_id', '=', companyId)
    .where('c.sub_recipe_id', 'is not', null)
    .execute()
  const edges = new Map<string, string[]>()
  for (const r of rows) {
    const list = edges.get(r.parent) ?? []
    list.push(r.child!)
    edges.set(r.parent, list)
  }
  return edges
}

/* ===================== Ricette interessate e cache ===================== */

export type ChangeSource =
  | { type: 'ingredients'; ids: string[] }
  | { type: 'equipment'; ids: string[] }
  | { type: 'tariffs'; ids: string[] }
  | { type: 'employees'; ids: string[] }
  | { type: 'recipes'; ids: string[] }

/** Ricette che usano direttamente la risorsa (revisione corrente) più tutte quelle che ne dipendono. */
export async function affectedRecipes(db: Db, companyId: string, change: ChangeSource): Promise<string[]> {
  if (change.ids.length === 0) return []
  let direct: string[] = []
  if (change.type === 'recipes') direct = change.ids
  else {
    let q
    if (change.type === 'ingredients') {
      q = db.selectFrom('recipes as r').innerJoin('recipe_components as x', 'x.revision_id', 'r.current_revision_id').where('x.ingredient_id', 'in', change.ids)
    } else if (change.type === 'employees') {
      q = db.selectFrom('recipes as r').innerJoin('recipe_labor as x', 'x.revision_id', 'r.current_revision_id').where('x.employee_id', 'in', change.ids)
    } else {
      let equipmentIds = change.ids
      if (change.type === 'tariffs') {
        const eq = await db
          .selectFrom('equipment')
          .select('id')
          .where('company_id', '=', companyId)
          .where((eb) => eb.or([eb('electric_tariff_id', 'in', change.ids), eb('gas_tariff_id', 'in', change.ids)]))
          .execute()
        equipmentIds = eq.map((e) => e.id)
        if (equipmentIds.length === 0) return []
      }
      q = db.selectFrom('recipes as r').innerJoin('recipe_equipment_uses as x', 'x.revision_id', 'r.current_revision_id').where('x.equipment_id', 'in', equipmentIds)
    }
    const rows = await q.select('r.id').distinct().where('r.company_id', '=', companyId).execute()
    direct = rows.map((r) => r.id)
  }
  if (direct.length === 0) return []
  const edges = await loadEdges(db, companyId)
  return [...new Set([...direct, ...dependentsOf(edges, direct)])]
}

/** Invalida la cache delle valorizzazioni correnti per le ricette interessate. Restituisce i loro id. */
export async function invalidate(db: Db, companyId: string, change: ChangeSource): Promise<string[]> {
  const ids = await affectedRecipes(db, companyId, change)
  if (ids.length) await db.deleteFrom('recipe_cost_cache').where('company_id', '=', companyId).where('recipe_id', 'in', ids).execute()
  return ids
}

export async function describeRecipes(db: Db, companyId: string, ids: string[]) {
  if (ids.length === 0) return []
  return db.selectFrom('recipes').select(['id', 'code', 'title', 'status']).where('company_id', '=', companyId).where('id', 'in', ids).orderBy('title').execute()
}

/* ======================== Caricamento del contesto ======================== */

export interface DraftRecipe {
  /** id della ricetta in modifica, oppure un id fittizio per una nuova ricetta */
  input: RecipeInput
}

/**
 * Carica dal database tutto ciò che serve a valorizzare le ricette indicate alla data:
 * chiusura delle sottoricette (revisioni correnti), prezzi, tariffe e costi del lavoro validi alla data.
 * Tutte le query sono delimitate all'azienda.
 */
export async function loadContext(db: Db, companyId: string, rootIds: string[], date: string, draft?: RecipeInput): Promise<ValuationContext> {
  const edges = await loadEdges(db, companyId)
  if (draft) edges.set(draft.id, draft.components.filter((c) => c.recipeId).map((c) => c.recipeId!))
  const closure = [...descendantsOf(edges, rootIds)].filter((id) => !draft || id !== draft.id)

  const recipes = new Map<string, RecipeInput>()
  if (draft) recipes.set(draft.id, draft)

  if (closure.length) {
    const heads = await db
      .selectFrom('recipes as r')
      .innerJoin('recipe_revisions as v', 'v.id', 'r.current_revision_id')
      .select([
        'r.id',
        'r.code',
        'r.title',
        'v.id as revision_id',
        'v.number',
        'v.final_quantity',
        'v.final_unit',
        'v.final_weight_kg',
        'v.portions',
        'v.declared_duration_minutes',
      ])
      .where('r.company_id', '=', companyId)
      .where('r.id', 'in', closure)
      .execute()
    const revIds = heads.map((h) => h.revision_id)
    const parts = await loadRevisionParts(db, companyId, revIds)
    for (const h of heads) {
      const p = parts.get(h.revision_id)
      recipes.set(h.id, {
        id: h.id,
        revisionId: h.revision_id,
        revisionNumber: h.number,
        code: h.code,
        title: h.title,
        finalQuantity: dn(h.final_quantity),
        finalUnit: h.final_unit as MeasureUnit | null,
        finalWeightKg: dn(h.final_weight_kg),
        portions: dn(h.portions),
        declaredDurationMinutes: dn(h.declared_duration_minutes),
        phases: p?.phases ?? [],
        components: p?.components ?? [],
        equipmentUses: p?.equipmentUses ?? [],
        laborAssignments: p?.laborAssignments ?? [],
      })
    }
  }

  const all = [...recipes.values()]
  const ingredientIds = uniq(all.flatMap((r) => r.components.map((c) => c.ingredientId).filter(isStr)))
  const equipmentIds = uniq(all.flatMap((r) => r.equipmentUses.map((u) => u.equipmentId)))
  const employeeIds = uniq(all.flatMap((r) => r.laborAssignments.map((a) => a.employeeId)))

  const [ingredients, equipment, employees] = await Promise.all([
    loadIngredients(db, companyId, ingredientIds, date),
    loadEquipment(db, companyId, equipmentIds),
    loadEmployees(db, companyId, employeeIds, date),
  ])
  const tariffIds = uniq([...equipment.values()].flatMap((e) => [e.electric?.tariffId, e.gas?.tariffId]).filter(isStr))
  const tariffs = await loadTariffs(db, companyId, tariffIds, date)

  return { date, recipes, ingredients, equipment, tariffs, employees }
}

export async function loadRevisionParts(db: Db, companyId: string, revIds: string[]) {
  const out = new Map<string, Pick<RecipeInput, 'phases' | 'components' | 'equipmentUses' | 'laborAssignments'>>()
  if (revIds.length === 0) return out
  for (const id of revIds) out.set(id, { phases: [], components: [], equipmentUses: [], laborAssignments: [] })
  const [phases, comps, uses, labor] = await Promise.all([
    db.selectFrom('recipe_phases').selectAll().where('company_id', '=', companyId).where('revision_id', 'in', revIds).orderBy('position').execute(),
    db.selectFrom('recipe_components').selectAll().where('company_id', '=', companyId).where('revision_id', 'in', revIds).orderBy('position').execute(),
    db.selectFrom('recipe_equipment_uses').selectAll().where('company_id', '=', companyId).where('revision_id', 'in', revIds).orderBy('position').execute(),
    db.selectFrom('recipe_labor').selectAll().where('company_id', '=', companyId).where('revision_id', 'in', revIds).orderBy('position').execute(),
  ])
  for (const p of phases) out.get(p.revision_id)!.phases.push({ id: p.id, name: p.name, position: p.position })
  for (const c of comps)
    out.get(c.revision_id)!.components.push({
      id: c.id,
      kind: c.ingredient_id ? 'ingredient' : 'recipe',
      ingredientId: c.ingredient_id,
      recipeId: c.sub_recipe_id,
      quantity: d(c.quantity ?? 0),
      unit: c.unit as MeasureUnit,
      note: c.note,
    })
  for (const u of uses)
    out.get(u.revision_id)!.equipmentUses.push({
      id: u.id,
      equipmentId: u.equipment_id,
      phaseId: u.phase_id,
      segment: u.segment,
      minutes: d(u.minutes ?? 0),
      share: d(u.share),
      sources: (u.sources as Array<'electric' | 'gas'> | null) ?? null,
      measuredElectricKwh: dn(u.measured_electric_kwh),
      measuredGasQuantity: dn(u.measured_gas_quantity),
      measuredGasUnit: u.measured_gas_unit,
    })
  for (const a of labor)
    out.get(a.revision_id)!.laborAssignments.push({ id: a.id, employeeId: a.employee_id, phaseId: a.phase_id, activeMinutes: d(a.active_minutes ?? 0), share: d(a.share) })
  return out
}

async function loadIngredients(db: Db, companyId: string, ids: string[], date: string): Promise<Map<string, IngredientInput>> {
  const map = new Map<string, IngredientInput>()
  if (ids.length === 0) return map
  const rows = await db
    .selectFrom('ingredients as i')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('ingredient_prices as p')
          .select(['p.id', 'p.package_price', 'p.package_content', 'p.package_unit', 'p.valid_from'])
          .whereRef('p.ingredient_id', '=', 'i.id')
          .where('p.valid_from', '<=', date)
          .orderBy('p.valid_from', 'desc')
          .limit(1)
          .as('p'),
      (j) => j.onTrue(),
    )
    .select([
      'i.id',
      'i.code',
      'i.name',
      'i.package_content',
      'i.package_unit',
      'i.edible_yield',
      'i.density_kg_per_l',
      'i.unit_weight_kg',
      'p.id as price_id',
      'p.package_price',
      'p.package_content as price_content',
      'p.package_unit as price_unit',
      'p.valid_from',
    ])
    .where('i.company_id', '=', companyId)
    .where('i.id', 'in', ids)
    .execute()
  for (const r of rows) {
    const hasPrice = r.price_id !== null
    map.set(r.id, {
      id: r.id,
      code: r.code,
      name: r.name,
      packageUnit: (hasPrice ? r.price_unit : r.package_unit) as MeasureUnit,
      packageContent: d(hasPrice ? r.price_content! : r.package_content),
      packagePrice: hasPrice ? d(r.package_price!) : null,
      priceId: r.price_id,
      priceValidFrom: r.valid_from,
      edibleYield: d(r.edible_yield),
      densityKgPerL: dn(r.density_kg_per_l),
      unitWeightKg: dn(r.unit_weight_kg),
    })
  }
  return map
}

async function loadEquipment(db: Db, companyId: string, ids: string[]): Promise<Map<string, EquipmentInput>> {
  const map = new Map<string, EquipmentInput>()
  if (ids.length === 0) return map
  const rows = await db.selectFrom('equipment').selectAll().where('company_id', '=', companyId).where('id', 'in', ids).execute()
  for (const e of rows) map.set(e.id, equipmentToInput(e))
  return map
}

export function equipmentToInput(e: Selectable<EquipmentTable>): EquipmentInput {
  const hasElectric = e.power_type === 'electric' || e.power_type === 'mixed'
  const hasGas = e.power_type === 'gas' || e.power_type === 'mixed'
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    powerType: e.power_type,
    electric: hasElectric
      ? {
          powerKw: dn(e.electric_power_kw),
          usageCoefficient: dn(e.usage_coefficient),
          preheatCoefficient: dn(e.preheat_coefficient),
          holdCoefficient: dn(e.hold_coefficient),
          tariffId: e.electric_tariff_id,
        }
      : null,
    gas: hasGas
      ? {
          mode: e.gas_mode ?? 'flow',
          flowPerHour: dn(e.gas_flow_per_hour),
          flowUnit: e.gas_flow_unit,
          powerKw: dn(e.gas_power_kw),
          loadFactor: dn(e.gas_load_factor),
          tariffId: e.gas_tariff_id,
        }
      : null,
  }
}

async function loadTariffs(db: Db, companyId: string, ids: string[], date: string): Promise<Map<string, TariffInput>> {
  const map = new Map<string, TariffInput>()
  if (ids.length === 0) return map
  const rows = await db
    .selectFrom('utility_tariffs as t')
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom('tariff_versions as v')
          .select(['v.id', 'v.price_per_unit', 'v.valid_from', 'v.m3_to_smc', 'v.smc_to_kwh'])
          .whereRef('v.tariff_id', '=', 't.id')
          .where('v.valid_from', '<=', date)
          .orderBy('v.valid_from', 'desc')
          .limit(1)
          .as('v'),
      (j) => j.onTrue(),
    )
    .select(['t.id', 't.name', 't.kind', 't.unit', 'v.id as version_id', 'v.price_per_unit', 'v.valid_from', 'v.m3_to_smc', 'v.smc_to_kwh'])
    .where('t.company_id', '=', companyId)
    .where('t.id', 'in', ids)
    .execute()
  for (const t of rows) {
    map.set(t.id, {
      id: t.id,
      name: t.name,
      kind: t.kind,
      unit: t.unit,
      pricePerUnit: d(t.price_per_unit),
      versionId: t.version_id,
      validFrom: t.valid_from,
      m3ToSmc: dn(t.m3_to_smc),
      smcToKwh: dn(t.smc_to_kwh),
    })
  }
  return map
}

async function loadEmployees(db: Db, companyId: string, ids: string[], date: string): Promise<Map<string, EmployeeCostInput>> {
  const map = new Map<string, EmployeeCostInput>()
  if (ids.length === 0) return map
  const rows = await db
    .selectFrom('employees as e')
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom('employee_cost_configs as c')
          .selectAll('c')
          .whereRef('c.employee_id', '=', 'e.id')
          .where('c.valid_from', '<=', date)
          .orderBy('c.valid_from', 'desc')
          .limit(1)
          .as('c'),
      (j) => j.onTrue(),
    )
    .select([
      'e.id',
      'e.code',
      'e.first_name',
      'e.last_name',
      'c.id as config_id',
      'c.gross_monthly',
      'c.contributions_mode',
      'c.contributions_value',
      'c.other_monthly_costs',
      'c.productive_hours',
    ])
    .where('e.company_id', '=', companyId)
    .where('e.id', 'in', ids)
    .execute()
  for (const e of rows) {
    map.set(e.id, {
      employeeId: e.id,
      code: e.code,
      name: `${e.first_name} ${e.last_name}`,
      configId: e.config_id,
      grossMonthly: d(e.gross_monthly),
      contributionsMode: e.contributions_mode,
      contributionsValue: dn(e.contributions_value),
      otherMonthlyCosts: dn(e.other_monthly_costs),
      productiveHours: d(e.productive_hours),
    })
  }
  return map
}

const uniq = <T>(xs: T[]) => [...new Set(xs)]
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0

/* ======================= Valorizzazione corrente ======================= */

export type SerializedCost = Serialized<RecipeCost>

export interface CacheSummary {
  recipeId: string
  revisionId: string
  complete: boolean
  total: string
  costPerKg: string | null
  costPerPortion: string | null
  errorCount: number
}

/**
 * Valorizzazione corrente con cache per (ricetta, data).
 * Le ricette mancanti in cache sono calcolate insieme, con un solo caricamento di contesto,
 * e tutte le ricette della chiusura entrano in cache.
 */
export async function currentValuations(db: Db, companyId: string, recipeIds: string[], date: string): Promise<Map<string, SerializedCost>> {
  const out = new Map<string, SerializedCost>()
  if (recipeIds.length === 0) return out
  const cached = await db
    .selectFrom('recipe_cost_cache as k')
    .innerJoin('recipes as r', 'r.id', 'k.recipe_id')
    .select(['k.recipe_id', 'k.data', 'k.revision_id', 'r.current_revision_id'])
    .where('k.company_id', '=', companyId)
    .where('k.valuation_date', '=', date)
    .where('k.recipe_id', 'in', recipeIds)
    .execute()
  for (const c of cached) if (c.revision_id === c.current_revision_id) out.set(c.recipe_id, c.data as SerializedCost)
  const missing = recipeIds.filter((id) => !out.has(id))
  if (missing.length === 0) return out

  const ctx = await loadContext(db, companyId, missing, date)
  const engine = new RecipeCostEngine(ctx)
  const computed: RecipeCost[] = []
  for (const id of ctx.recipes.keys()) computed.push(engine.value(id))
  const rows = computed.map((r) => {
    const s = serialize(r)
    if (recipeIds.includes(r.recipeId)) out.set(r.recipeId, s)
    return {
      company_id: companyId,
      recipe_id: r.recipeId,
      valuation_date: date,
      revision_id: r.revisionId,
      complete: r.complete,
      total: s.total,
      cost_per_kg: s.costPerKg,
      cost_per_portion: s.costPerPortion,
      error_count: r.issues.filter((i) => i.severity === 'error').length,
      data: JSON.stringify(s),
    }
  })
  if (rows.length) {
    await db
      .insertInto('recipe_cost_cache')
      .values(rows)
      .onConflict((oc) =>
        oc.columns(['recipe_id', 'valuation_date']).doUpdateSet((eb) => ({
          revision_id: eb.ref('excluded.revision_id'),
          complete: eb.ref('excluded.complete'),
          total: eb.ref('excluded.total'),
          cost_per_kg: eb.ref('excluded.cost_per_kg'),
          cost_per_portion: eb.ref('excluded.cost_per_portion'),
          error_count: eb.ref('excluded.error_count'),
          data: eb.ref('excluded.data'),
          computed_at: sql`now()`,
        })),
      )
      .execute()
  }
  return out
}

/** Valorizzazione non memorizzata (data diversa, anteprima, snapshot). */
export async function computeValuation(db: Db, companyId: string, recipeId: string, date: string, draft?: RecipeInput): Promise<RecipeCost> {
  const ctx = await loadContext(db, companyId, [recipeId], date, draft)
  return new RecipeCostEngine(ctx).value(recipeId)
}
