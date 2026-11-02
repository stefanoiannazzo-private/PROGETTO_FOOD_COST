import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { z } from 'zod'
import { can, parse, requireCompany } from '../http/context'
import { badRequest, conflict, notFound } from '../http/errors'
import { decOpt, likePattern, listQuery, optText, reqText } from '../http/schemas'
import { audit, diff } from '../services/audit'
import { describeRecipes, invalidate } from '../services/costing'
import { nextCode } from '../services/codes'

const coefficient = (label: string) => decOpt({ gt: 0, max: 1, label })

const equipmentBody = z.object({
  code: optText(40),
  name: reqText('Il nome', 160),
  category: optText(80),
  description: optText(2000),
  powerType: z.enum(['electric', 'gas', 'mixed', 'manual']),
  status: z.enum(['active', 'maintenance', 'inactive']).default('active'),
  capacity: optText(120),
  electricPowerKw: decOpt({ gt: 0, label: 'La potenza (kW)' }),
  usageCoefficient: coefficient('Il coefficiente di utilizzo'),
  preheatCoefficient: coefficient('Il coefficiente di preriscaldamento'),
  holdCoefficient: coefficient('Il coefficiente di mantenimento'),
  electricTariffId: z.uuid().nullable().optional(),
  gasMode: z.enum(['flow', 'energy']).nullable().optional(),
  gasFlowPerHour: decOpt({ gt: 0, label: 'La portata oraria' }),
  gasFlowUnit: z.enum(['m3', 'smc']).nullable().optional(),
  gasPowerKw: decOpt({ gt: 0, label: 'La potenza gas (kW)' }),
  gasLoadFactor: coefficient('Il fattore di carico'),
  gasTariffId: z.uuid().nullable().optional(),
})
type EquipmentBody = z.infer<typeof equipmentBody>

const UNIT_LABEL: Record<string, string> = { kwh: 'kWh', m3: 'm³', smc: 'Smc' }

export async function equipmentRoutes(app: FastifyInstance) {
  const db = app.database.db

  /** Normalizza secondo l'alimentazione e verifica le tariffe; restituisce le avvertenze di completezza. */
  async function prepare(companyId: string, b: EquipmentBody) {
    const electric = b.powerType === 'electric' || b.powerType === 'mixed'
    const gas = b.powerType === 'gas' || b.powerType === 'mixed'
    const warnings: string[] = []
    const row = {
      code: b.code ?? null,
      name: b.name,
      category: b.category ?? null,
      description: b.description ?? null,
      power_type: b.powerType,
      status: b.status,
      capacity: b.capacity ?? null,
      electric_power_kw: electric ? (b.electricPowerKw ?? null) : null,
      usage_coefficient: electric ? (b.usageCoefficient ?? null) : null,
      preheat_coefficient: electric ? (b.preheatCoefficient ?? null) : null,
      hold_coefficient: electric ? (b.holdCoefficient ?? null) : null,
      electric_tariff_id: electric ? (b.electricTariffId ?? null) : null,
      gas_mode: gas ? (b.gasMode ?? 'flow') : null,
      gas_flow_per_hour: gas && (b.gasMode ?? 'flow') === 'flow' ? (b.gasFlowPerHour ?? null) : null,
      gas_flow_unit: gas && (b.gasMode ?? 'flow') === 'flow' ? (b.gasFlowUnit ?? null) : null,
      gas_power_kw: gas && b.gasMode === 'energy' ? (b.gasPowerKw ?? null) : null,
      gas_load_factor: gas ? (b.gasLoadFactor ?? null) : null,
      gas_tariff_id: gas ? (b.gasTariffId ?? null) : null,
    }
    const tariffIds = [row.electric_tariff_id, row.gas_tariff_id].filter((x): x is string => !!x)
    const tariffs = tariffIds.length
      ? await db.selectFrom('utility_tariffs').select(['id', 'kind', 'unit', 'name']).where('company_id', '=', companyId).where('id', 'in', tariffIds).execute()
      : []
    const byId = new Map(tariffs.map((t) => [t.id, t]))
    if (row.electric_tariff_id) {
      const t = byId.get(row.electric_tariff_id)
      if (!t) throw badRequest('validation_failed', 'Tariffa elettrica non trovata.', { fields: { electricTariffId: 'Tariffa non valida.' } })
      if (t.kind !== 'electricity') throw badRequest('validation_failed', 'Associa una tariffa di tipo elettricità (€/kWh).', { fields: { electricTariffId: 'Tipo di tariffa non compatibile.' } })
    }
    if (row.gas_tariff_id) {
      const t = byId.get(row.gas_tariff_id)
      if (!t) throw badRequest('validation_failed', 'Tariffa gas non trovata.', { fields: { gasTariffId: 'Tariffa non valida.' } })
      if (t.kind !== 'gas') throw badRequest('validation_failed', 'Associa una tariffa di tipo gas.', { fields: { gasTariffId: 'Tipo di tariffa non compatibile.' } })
      const consumptionUnit = row.gas_mode === 'energy' ? 'kwh' : row.gas_flow_unit
      if (consumptionUnit && consumptionUnit !== t.unit) {
        warnings.push(`Il consumo è in ${UNIT_LABEL[consumptionUnit]} ma la tariffa "${t.name}" è in €/${UNIT_LABEL[t.unit]}: serve un coefficiente di conversione sulla tariffa, altrimenti il costo risulterà incompleto.`)
      }
    }
    if (electric) {
      if (!row.electric_power_kw) warnings.push('Potenza elettrica (kW) non indicata: il costo energetico risulterà incompleto.')
      if (!row.usage_coefficient) warnings.push('Coefficiente medio di utilizzo non indicato.')
      if (!row.electric_tariff_id) warnings.push('Nessuna tariffa elettrica associata.')
    }
    if (gas) {
      if (row.gas_mode === 'flow' && (!row.gas_flow_per_hour || !row.gas_flow_unit)) warnings.push('Portata gas oraria o relativa unità non indicata.')
      if (row.gas_mode === 'energy' && !row.gas_power_kw) warnings.push('Potenza gas (kW) non indicata.')
      if (!row.gas_tariff_id) warnings.push('Nessuna tariffa gas associata.')
    }
    return { row, warnings }
  }

  app.get('/equipment', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const q = parse(listQuery.extend({ powerType: z.enum(['electric', 'gas', 'mixed', 'manual']).optional() }), req.query)
    let query = db.selectFrom('equipment as e').where('e.company_id', '=', ctx.companyId)
    if (q.archived === '0') query = query.where('e.archived_at', 'is', null)
    if (q.archived === '1') query = query.where('e.archived_at', 'is not', null)
    if (q.category) query = query.where('e.category', '=', q.category)
    if (q.powerType) query = query.where('e.power_type', '=', q.powerType)
    if (q.q) {
      const pat = likePattern(q.q)
      query = query.where((eb) => eb.or([eb(eb.fn('lower', ['e.name']), 'like', pat), eb(eb.fn('lower', ['e.code']), 'like', pat)]))
    }
    const sorts = { name: 'e.name', code: 'e.code', category: 'e.category', updated: 'e.updated_at' } as const
    const rows = await query
      .selectAll('e')
      .select(sql<string>`count(*) over()`.as('total_count'))
      .orderBy(sql.ref(sorts[(q.sort ?? 'name') as keyof typeof sorts] ?? 'e.name'), q.dir)
      .orderBy('e.id')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .execute()
    return { data: rows.map((r) => present(r, can(ctx, 'equipment.manage'))), meta: { page: q.page, pageSize: q.pageSize, total: Number(rows[0]?.total_count ?? 0) } }
  })

  app.get('/equipment/:id', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const e = await db.selectFrom('equipment').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!e) throw notFound('Strumento')
    const usedIn = await db
      .selectFrom('recipes as r')
      .innerJoin('recipe_equipment_uses as u', 'u.revision_id', 'r.current_revision_id')
      .select(['r.id', 'r.code', 'r.title', 'r.status'])
      .distinct()
      .where('r.company_id', '=', ctx.companyId)
      .where('u.equipment_id', '=', id)
      .orderBy('r.title')
      .execute()
    return { ...present(e, true), usedIn }
  })

  app.post('/equipment', async (req) => {
    const ctx = requireCompany(req, 'equipment.manage')
    const body = parse(equipmentBody, req.body)
    const { row, warnings } = await prepare(ctx.companyId, body)
    return db.transaction().execute(async (trx) => {
      const code = row.code ?? (await nextCode(trx, 'equipment', ctx.companyId, 'STR'))
      const dup = await trx.selectFrom('equipment').select('id').where('company_id', '=', ctx.companyId).where(sql`lower(code)`, '=', code.toLowerCase()).executeTakeFirst()
      if (dup) throw conflict('duplicate_code', `Il codice ${code} è già in uso.`, { fields: { code: 'Codice già in uso.' } })
      const e = await trx.insertInto('equipment').values({ ...row, code, company_id: ctx.companyId }).returning(['id', 'code', 'name']).executeTakeFirstOrThrow()
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'equipment', entityId: e.id, action: 'created', details: { code, name: body.name } })
      return { ...e, warnings }
    })
  })

  app.patch('/equipment/:id', async (req) => {
    const ctx = requireCompany(req, 'equipment.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const body = parse(equipmentBody.extend({ code: reqText('Il codice', 40), lockVersion: z.number().int() }), req.body)
    const { row, warnings } = await prepare(ctx.companyId, body)
    await db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('equipment').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).forUpdate().executeTakeFirst()
      if (!cur) throw notFound('Strumento')
      if (cur.lock_version !== body.lockVersion) throw conflict('stale', 'Lo strumento è stato modificato da un altro utente: ricarica la pagina.')
      const dup = await trx.selectFrom('equipment').select('id').where('company_id', '=', ctx.companyId).where(sql`lower(code)`, '=', body.code.toLowerCase()).where('id', '<>', id).executeTakeFirst()
      if (dup) throw conflict('duplicate_code', `Il codice ${body.code} è già in uso.`, { fields: { code: 'Codice già in uso.' } })
      await trx.updateTable('equipment').set({ ...row, code: body.code, updated_at: new Date(), lock_version: cur.lock_version + 1 }).where('id', '=', id).execute()
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'equipment', entityId: id, action: 'updated', details: diff(cur as unknown as Record<string, unknown>, { ...row, code: body.code }) })
    })
    const affected = await invalidate(db, ctx.companyId, { type: 'equipment', ids: [id] })
    return { ok: true, warnings, affectedRecipes: await describeRecipes(db, ctx.companyId, affected) }
  })

  for (const [action, archived] of [['archive', true], ['restore', false]] as const) {
    app.post(`/equipment/:id/${action}`, async (req) => {
      const ctx = requireCompany(req, 'equipment.manage')
      const { id } = parse(z.object({ id: z.uuid() }), req.params)
      const res = await db
        .updateTable('equipment')
        .set({ archived_at: archived ? new Date() : null, updated_at: new Date(), lock_version: sql`lock_version + 1` })
        .where('id', '=', id)
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirst()
      if (!res.numUpdatedRows) throw notFound('Strumento')
      await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'equipment', entityId: id, action: archived ? 'archived' : 'restored' })
      return { ok: true }
    })
  }

  app.delete('/equipment/:id', async (req) => {
    const ctx = requireCompany(req, 'equipment.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    return db.transaction().execute(async (trx) => {
      const e = await trx.selectFrom('equipment').select(['id', 'code']).where('id', '=', id).where('company_id', '=', ctx.companyId).forUpdate().executeTakeFirst()
      if (!e) throw notFound('Strumento')
      const ref = await trx.selectFrom('recipe_equipment_uses').select('id').where('equipment_id', '=', id).limit(1).executeTakeFirst()
      if (ref) throw conflict('in_use', 'Lo strumento è usato in almeno una ricetta (anche in revisioni storiche): puoi archiviarlo ma non eliminarlo.')
      await trx.deleteFrom('equipment').where('id', '=', id).execute()
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'equipment', entityId: id, action: 'deleted', details: { code: e.code } })
      return { ok: true }
    })
  })
}

function present(e: Record<string, any>, full: boolean) {
  const base = {
    id: e.id as string,
    code: e.code as string,
    name: e.name as string,
    category: e.category as string | null,
    powerType: e.power_type as string,
    status: e.status as string,
    capacity: e.capacity as string | null,
    archived: e.archived_at !== null,
  }
  if (!full) return base
  return {
    ...base,
    description: e.description,
    electricPowerKw: e.electric_power_kw,
    usageCoefficient: e.usage_coefficient,
    preheatCoefficient: e.preheat_coefficient,
    holdCoefficient: e.hold_coefficient,
    electricTariffId: e.electric_tariff_id,
    gasMode: e.gas_mode,
    gasFlowPerHour: e.gas_flow_per_hour,
    gasFlowUnit: e.gas_flow_unit,
    gasPowerKw: e.gas_power_kw,
    gasLoadFactor: e.gas_load_factor,
    gasTariffId: e.gas_tariff_id,
    lockVersion: e.lock_version,
    updatedAt: e.updated_at,
  }
}
