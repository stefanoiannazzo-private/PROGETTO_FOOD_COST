import type { Kysely } from 'kysely'
import { z } from 'zod'
import { d, findCycle, type MeasureUnit, type RecipeInput } from '@foodcost/domain'
import type { DB } from '../db/types'
import { badRequest, conflict } from '../http/errors'
import { decOpt, measureUnit, optText, reqText } from '../http/schemas'
import { loadEdges } from './costing'

type Db = Kysely<DB>

const percent = (label: string) =>
  decOpt({ gt: 0, max: 100, label }).transform((v) => v ?? '100')

/** Composizione di una revisione come arriva dall'editor. Le fasi sono referenziate con chiavi locali. */
export const revisionBody = z.object({
  instructions: optText(20000),
  finalQuantity: decOpt({ gt: 0, label: 'La quantità finale' }),
  finalUnit: measureUnit.nullable().optional(),
  finalWeightKg: decOpt({ gt: 0, label: 'Il peso finale netto' }),
  portions: decOpt({ gt: 0, label: 'Il numero di porzioni' }),
  declaredDurationMinutes: decOpt({ gt: 0, label: 'La durata complessiva' }),
  yieldNotes: optText(2000),
  phases: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        name: reqText('Il nome della fase', 120),
        description: optText(2000),
        startOffsetMinutes: decOpt({ min: 0, label: 'L’inizio della fase' }),
        durationMinutes: decOpt({ gt: 0, label: 'La durata della fase' }),
      }),
    )
    .max(50)
    .default([]),
  components: z
    .array(
      z
        .object({
          kind: z.enum(['ingredient', 'recipe']),
          ingredientId: z.uuid().nullable().optional(),
          recipeId: z.uuid().nullable().optional(),
          quantity: decOpt({ gt: 0, label: 'La quantità' }),
          unit: measureUnit,
          note: optText(300),
        })
        .refine((c) => (c.kind === 'ingredient' ? !!c.ingredientId && !c.recipeId : !!c.recipeId && !c.ingredientId), {
          message: 'Ogni riga deve riferirsi a un ingrediente oppure a una ricetta.',
        }),
    )
    .max(300)
    .default([]),
  equipmentUses: z
    .array(
      z.object({
        phaseKey: z.string().max(60).nullable().optional(),
        equipmentId: z.uuid(),
        segment: z.enum(['preheat', 'work', 'hold']).default('work'),
        minutes: decOpt({ gt: 0, label: 'La durata d’uso' }),
        sharePercent: percent('La quota di imputazione'),
        sources: z.array(z.enum(['electric', 'gas'])).nullable().optional(),
        measuredElectricKwh: decOpt({ min: 0, label: 'Il consumo elettrico misurato' }),
        measuredGasQuantity: decOpt({ min: 0, label: 'Il consumo gas misurato' }),
        measuredGasUnit: z.enum(['kwh', 'm3', 'smc']).nullable().optional(),
        note: optText(300),
      }),
    )
    .max(200)
    .default([]),
  labor: z
    .array(
      z.object({
        phaseKey: z.string().max(60).nullable().optional(),
        employeeId: z.uuid(),
        activeMinutes: decOpt({ gt: 0, label: 'I minuti attivi' }),
        sharePercent: percent('La quota di imputazione'),
        note: optText(300),
      }),
    )
    .max(200)
    .default([]),
})
export type RevisionBody = z.infer<typeof revisionBody>

export const recipeHeader = z.object({
  code: optText(40),
  title: reqText('Il titolo', 160),
  category: optText(80),
  description: optText(4000),
  status: z.enum(['draft', 'active']).default('draft'),
})

/** Verifica che tutti i riferimenti appartengano all'azienda e che non si creino cicli. */
export async function validateRevision(db: Db, companyId: string, recipeId: string | null, rev: RevisionBody): Promise<void> {
  const phaseKeys = new Set(rev.phases.map((p) => p.key))
  if (phaseKeys.size !== rev.phases.length) throw badRequest('validation_failed', 'Chiavi di fase duplicate.')
  for (const [i, u] of rev.equipmentUses.entries())
    if (u.phaseKey && !phaseKeys.has(u.phaseKey)) throw badRequest('validation_failed', 'Uso strumento collegato a una fase inesistente.', { fields: { [`equipmentUses.${i}.phaseKey`]: 'Fase inesistente.' } })
  for (const [i, a] of rev.labor.entries())
    if (a.phaseKey && !phaseKeys.has(a.phaseKey)) throw badRequest('validation_failed', 'Manodopera collegata a una fase inesistente.', { fields: { [`labor.${i}.phaseKey`]: 'Fase inesistente.' } })
  for (const [i, u] of rev.equipmentUses.entries()) {
    if (u.measuredGasQuantity && !u.measuredGasUnit) throw badRequest('validation_failed', 'Indica l’unità del consumo gas misurato.', { fields: { [`equipmentUses.${i}.measuredGasUnit`]: 'Obbligatoria.' } })
  }

  const ingIds = [...new Set(rev.components.map((c) => c.ingredientId).filter((x): x is string => !!x))]
  const recIds = [...new Set(rev.components.map((c) => c.recipeId).filter((x): x is string => !!x))]
  const eqIds = [...new Set(rev.equipmentUses.map((u) => u.equipmentId))]
  const empIds = [...new Set(rev.labor.map((a) => a.employeeId))]

  const count = async (table: 'ingredients' | 'recipes' | 'equipment' | 'employees', ids: string[]) => {
    if (ids.length === 0) return 0
    const r = await db.selectFrom(table).select(({ fn }) => fn.countAll<string>().as('n')).where('company_id', '=', companyId).where('id', 'in', ids).executeTakeFirstOrThrow()
    return Number(r.n)
  }
  // Riferimenti di altre aziende risultano semplicemente inesistenti.
  if ((await count('ingredients', ingIds)) !== ingIds.length) throw badRequest('invalid_reference', 'Uno o più ingredienti non esistono in questa azienda.')
  if ((await count('recipes', recIds)) !== recIds.length) throw badRequest('invalid_reference', 'Una o più sottoricette non esistono in questa azienda.')
  if ((await count('equipment', eqIds)) !== eqIds.length) throw badRequest('invalid_reference', 'Uno o più strumenti non esistono in questa azienda.')
  if ((await count('employees', empIds)) !== empIds.length) throw badRequest('invalid_reference', 'Uno o più dipendenti non esistono in questa azienda.')

  if (recipeId && recIds.length) {
    const edges = await loadEdges(db, companyId)
    const cycle = findCycle(edges, recipeId, recIds)
    if (cycle) {
      const titles = await db.selectFrom('recipes').select(['id', 'title']).where('company_id', '=', companyId).where('id', 'in', [...new Set(cycle)]).execute()
      const byId = new Map(titles.map((t) => [t.id, t.title]))
      const path = cycle.map((id) => byId.get(id) ?? id)
      throw conflict('cycle', `Inserimento non ammesso: si creerebbe un ciclo (${path.join(' → ')}).`, { path })
    }
  }
}

/** Crea una nuova revisione immutabile e la imposta come corrente. */
export async function insertRevision(trx: Db, companyId: string, userId: string | null, recipeId: string, rev: RevisionBody): Promise<{ id: string; number: number }> {
  const last = await trx.selectFrom('recipe_revisions').select(({ fn }) => fn.max('number').as('n')).where('recipe_id', '=', recipeId).executeTakeFirst()
  const number = Number(last?.n ?? 0) + 1
  const r = await trx
    .insertInto('recipe_revisions')
    .values({
      company_id: companyId,
      recipe_id: recipeId,
      number,
      instructions: rev.instructions ?? null,
      final_quantity: rev.finalQuantity ?? null,
      final_unit: rev.finalUnit ?? null,
      final_weight_kg: rev.finalWeightKg ?? null,
      portions: rev.portions ?? null,
      declared_duration_minutes: rev.declaredDurationMinutes ?? null,
      yield_notes: rev.yieldNotes ?? null,
      created_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const phaseIds = new Map<string, string>()
  for (const [i, p] of rev.phases.entries()) {
    const row = await trx
      .insertInto('recipe_phases')
      .values({
        company_id: companyId,
        revision_id: r.id,
        position: i,
        name: p.name,
        description: p.description ?? null,
        start_offset_minutes: p.startOffsetMinutes ?? null,
        duration_minutes: p.durationMinutes ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    phaseIds.set(p.key, row.id)
  }
  if (rev.components.length)
    await trx
      .insertInto('recipe_components')
      .values(
        rev.components.map((c, i) => ({
          company_id: companyId,
          revision_id: r.id,
          position: i,
          ingredient_id: c.kind === 'ingredient' ? c.ingredientId! : null,
          sub_recipe_id: c.kind === 'recipe' ? c.recipeId! : null,
          quantity: c.quantity ?? null,
          unit: c.unit,
          note: c.note ?? null,
        })),
      )
      .execute()
  if (rev.equipmentUses.length)
    await trx
      .insertInto('recipe_equipment_uses')
      .values(
        rev.equipmentUses.map((u, i) => ({
          company_id: companyId,
          revision_id: r.id,
          phase_id: u.phaseKey ? phaseIds.get(u.phaseKey)! : null,
          position: i,
          equipment_id: u.equipmentId,
          segment: u.segment,
          minutes: u.minutes ?? null,
          share: d(u.sharePercent).div(100).toFixed(),
          sources: u.sources && u.sources.length ? u.sources : null,
          measured_electric_kwh: u.measuredElectricKwh ?? null,
          measured_gas_quantity: u.measuredGasQuantity ?? null,
          measured_gas_unit: u.measuredGasQuantity ? (u.measuredGasUnit ?? null) : null,
          note: u.note ?? null,
        })),
      )
      .execute()
  if (rev.labor.length)
    await trx
      .insertInto('recipe_labor')
      .values(
        rev.labor.map((a, i) => ({
          company_id: companyId,
          revision_id: r.id,
          phase_id: a.phaseKey ? phaseIds.get(a.phaseKey)! : null,
          position: i,
          employee_id: a.employeeId,
          active_minutes: a.activeMinutes ?? null,
          share: d(a.sharePercent).div(100).toFixed(),
          note: a.note ?? null,
        })),
      )
      .execute()
  await trx.updateTable('recipes').set({ current_revision_id: r.id, updated_at: new Date() }).where('id', '=', recipeId).execute()
  return { id: r.id, number }
}

/** Converte una revisione dell'editor (non salvata) in input del motore, per l'anteprima. */
export function draftToInput(recipeId: string, title: string, code: string, rev: RevisionBody): RecipeInput {
  const phaseIds = new Map(rev.phases.map((p) => [p.key, `phase:${p.key}`]))
  return {
    id: recipeId,
    revisionId: 'draft',
    code,
    title,
    finalQuantity: rev.finalQuantity ? d(rev.finalQuantity) : null,
    finalUnit: (rev.finalUnit ?? null) as MeasureUnit | null,
    finalWeightKg: rev.finalWeightKg ? d(rev.finalWeightKg) : null,
    portions: rev.portions ? d(rev.portions) : null,
    declaredDurationMinutes: rev.declaredDurationMinutes ? d(rev.declaredDurationMinutes) : null,
    phases: rev.phases.map((p, i) => ({ id: phaseIds.get(p.key)!, name: p.name, position: i })),
    components: rev.components.map((c, i) => ({
      id: `c${i}`,
      kind: c.kind,
      ingredientId: c.kind === 'ingredient' ? c.ingredientId : null,
      recipeId: c.kind === 'recipe' ? c.recipeId : null,
      quantity: d(c.quantity ?? 0),
      unit: c.unit,
    })),
    equipmentUses: rev.equipmentUses.map((u, i) => ({
      id: `u${i}`,
      equipmentId: u.equipmentId,
      phaseId: u.phaseKey ? (phaseIds.get(u.phaseKey) ?? null) : null,
      segment: u.segment,
      minutes: d(u.minutes ?? 0),
      share: d(u.sharePercent).div(100),
      sources: u.sources ?? null,
      measuredElectricKwh: u.measuredElectricKwh ? d(u.measuredElectricKwh) : null,
      measuredGasQuantity: u.measuredGasQuantity ? d(u.measuredGasQuantity) : null,
      measuredGasUnit: u.measuredGasUnit ?? null,
    })),
    laborAssignments: rev.labor.map((a, i) => ({
      id: `l${i}`,
      employeeId: a.employeeId,
      phaseId: a.phaseKey ? (phaseIds.get(a.phaseKey) ?? null) : null,
      activeMinutes: d(a.activeMinutes ?? 0),
      share: d(a.sharePercent).div(100),
    })),
  }
}

/** Revisione in formato editor, con i nomi delle risorse collegate. */
export async function loadRevisionForm(db: Db, companyId: string, revisionId: string) {
  const rev = await db.selectFrom('recipe_revisions').selectAll().where('id', '=', revisionId).where('company_id', '=', companyId).executeTakeFirstOrThrow()
  const [phases, comps, uses, labor] = await Promise.all([
    db.selectFrom('recipe_phases').selectAll().where('revision_id', '=', revisionId).orderBy('position').execute(),
    db
      .selectFrom('recipe_components as c')
      .leftJoin('ingredients as i', 'i.id', 'c.ingredient_id')
      .leftJoin('recipes as r', 'r.id', 'c.sub_recipe_id')
      .leftJoin('recipe_revisions as rv', 'rv.id', 'r.current_revision_id')
      .select([
        'c.id',
        'c.ingredient_id',
        'c.sub_recipe_id',
        'c.quantity',
        'c.unit',
        'c.note',
        'i.code as ing_code',
        'i.name as ing_name',
        'i.usage_unit',
        'i.package_unit',
        'i.archived_at as ing_archived',
        'r.code as rec_code',
        'r.title as rec_title',
        'r.status as rec_status',
        'rv.final_unit as rec_final_unit',
        'rv.final_weight_kg as rec_final_weight',
      ])
      .where('c.revision_id', '=', revisionId)
      .orderBy('c.position')
      .execute(),
    db
      .selectFrom('recipe_equipment_uses as u')
      .innerJoin('equipment as e', 'e.id', 'u.equipment_id')
      .select(['u.id', 'u.phase_id', 'u.equipment_id', 'u.segment', 'u.minutes', 'u.share', 'u.sources', 'u.measured_electric_kwh', 'u.measured_gas_quantity', 'u.measured_gas_unit', 'u.note', 'e.name', 'e.code', 'e.power_type'])
      .where('u.revision_id', '=', revisionId)
      .orderBy('u.position')
      .execute(),
    db
      .selectFrom('recipe_labor as a')
      .innerJoin('employees as e', 'e.id', 'a.employee_id')
      .select(['a.id', 'a.phase_id', 'a.employee_id', 'a.active_minutes', 'a.share', 'a.note', 'e.first_name', 'e.last_name', 'e.code', 'e.job_title'])
      .where('a.revision_id', '=', revisionId)
      .orderBy('a.position')
      .execute(),
  ])
  const pct = (v: string) => d(v).times(100).toFixed()
  return {
    id: rev.id,
    number: rev.number,
    createdAt: rev.created_at,
    instructions: rev.instructions,
    finalQuantity: rev.final_quantity,
    finalUnit: rev.final_unit,
    finalWeightKg: rev.final_weight_kg,
    portions: rev.portions,
    declaredDurationMinutes: rev.declared_duration_minutes,
    yieldNotes: rev.yield_notes,
    phases: phases.map((p) => ({ key: p.id, name: p.name, description: p.description, startOffsetMinutes: p.start_offset_minutes, durationMinutes: p.duration_minutes })),
    components: comps.map((c) => ({
      id: c.id,
      kind: c.ingredient_id ? ('ingredient' as const) : ('recipe' as const),
      ingredientId: c.ingredient_id,
      recipeId: c.sub_recipe_id,
      quantity: c.quantity,
      unit: c.unit,
      note: c.note,
      ref: c.ingredient_id
        ? { code: c.ing_code, name: c.ing_name, usageUnit: c.usage_unit, packageUnit: c.package_unit, archived: c.ing_archived !== null }
        : { code: c.rec_code, name: c.rec_title, status: c.rec_status, finalUnit: c.rec_final_unit, hasFinalWeight: c.rec_final_weight !== null },
    })),
    equipmentUses: uses.map((u) => ({
      id: u.id,
      phaseKey: u.phase_id,
      equipmentId: u.equipment_id,
      segment: u.segment,
      minutes: u.minutes,
      sharePercent: pct(u.share),
      sources: u.sources,
      measuredElectricKwh: u.measured_electric_kwh,
      measuredGasQuantity: u.measured_gas_quantity,
      measuredGasUnit: u.measured_gas_unit,
      note: u.note,
      ref: { code: u.code, name: u.name, powerType: u.power_type },
    })),
    labor: labor.map((a) => ({
      id: a.id,
      phaseKey: a.phase_id,
      employeeId: a.employee_id,
      activeMinutes: a.active_minutes,
      sharePercent: pct(a.share),
      note: a.note,
      ref: { code: a.code, name: `${a.first_name} ${a.last_name}`, jobTitle: a.job_title },
    })),
  }
}

/** Converte la revisione salvata nel formato di ingresso dell'editor (per duplicazione). */
export function formToBody(form: Awaited<ReturnType<typeof loadRevisionForm>>): RevisionBody {
  return {
    instructions: form.instructions,
    finalQuantity: form.finalQuantity,
    finalUnit: form.finalUnit as MeasureUnit | null,
    finalWeightKg: form.finalWeightKg,
    portions: form.portions,
    declaredDurationMinutes: form.declaredDurationMinutes,
    yieldNotes: form.yieldNotes,
    phases: form.phases.map((p) => ({ key: p.key, name: p.name, description: p.description, startOffsetMinutes: p.startOffsetMinutes, durationMinutes: p.durationMinutes })),
    components: form.components.map((c) => ({ kind: c.kind, ingredientId: c.ingredientId, recipeId: c.recipeId, quantity: c.quantity, unit: c.unit as MeasureUnit, note: c.note })),
    equipmentUses: form.equipmentUses.map((u) => ({
      phaseKey: u.phaseKey,
      equipmentId: u.equipmentId,
      segment: u.segment,
      minutes: u.minutes,
      sharePercent: u.sharePercent,
      sources: (u.sources as Array<'electric' | 'gas'> | null) ?? null,
      measuredElectricKwh: u.measuredElectricKwh,
      measuredGasQuantity: u.measuredGasQuantity,
      measuredGasUnit: u.measuredGasUnit,
      note: u.note,
    })),
    labor: form.labor.map((a) => ({ phaseKey: a.phaseKey, employeeId: a.employeeId, activeMinutes: a.activeMinutes, sharePercent: a.sharePercent, note: a.note })),
  }
}
