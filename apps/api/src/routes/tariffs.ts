import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Kysely } from 'kysely'
import type { DB } from '../db/types'
import { d, sum } from '@foodcost/domain'
import { parse, requireCompany } from '../http/context'
import { badRequest, conflict, notFound } from '../http/errors'
import { dec, decOpt, isoDate, optText, reqText, today } from '../http/schemas'
import { audit } from '../services/audit'
import { describeRecipes, invalidate } from '../services/costing'

const KIND_UNITS = { electricity: ['kwh'], gas: ['m3', 'smc', 'kwh'], water: ['m3'] } as const

const tariffBody = z
  .object({
    name: reqText('Il nome', 120),
    kind: z.enum(['electricity', 'gas', 'water']),
    unit: z.enum(['kwh', 'm3', 'smc']),
    notes: optText(1000),
  })
  .refine((b) => (KIND_UNITS[b.kind] as readonly string[]).includes(b.unit), {
    message: 'Unità non compatibile: elettricità in kWh (energia, non kW di potenza); gas in m³, Smc o kWh; acqua in m³.',
    path: ['unit'],
  })

const conversions = {
  m3ToSmc: decOpt({ gt: 0, label: 'Il coefficiente m³→Smc' }),
  smcToKwh: decOpt({ gt: 0, label: 'Il coefficiente kWh/Smc' }),
}

/** Modalità diretta: l'utente conosce il prezzo unitario. */
const directVersion = z.object({ mode: z.literal('direct'), pricePerUnit: dec({ min: 0, label: 'Il prezzo unitario' }), validFrom: isoDate, notes: optText(500), ...conversions })

/** Modalità assistita da bolletta: prezzo medio = voci selezionate / consumo del periodo. */
const billVersion = z.object({
  mode: z.literal('bill'),
  validFrom: isoDate,
  periodFrom: isoDate,
  periodTo: isoDate,
  consumption: dec({ gt: 0, label: 'Il consumo del periodo' }),
  consumptionUnit: z.enum(['kwh', 'm3', 'smc']),
  vatBasis: z.literal('net', { error: 'Tutti gli importi devono essere netti IVA.' }),
  components: z
    .array(
      z.object({
        label: reqText('La descrizione della voce', 120),
        amount: dec({ min: 0, label: 'L’importo' }),
        kind: z.enum(['variable', 'fixed']),
        include: z.boolean(),
      }),
    )
    .min(1, 'Inserisci almeno una voce di costo.'),
  notes: optText(500),
  ...conversions,
})
const versionBody = z.discriminatedUnion('mode', [directVersion, billVersion])

export function computeBillTariff(b: z.infer<typeof billVersion>) {
  const included = b.components.filter((c) => c.include)
  if (included.length === 0) throw badRequest('validation_failed', 'Seleziona almeno una voce da includere nella tariffa.', { fields: { components: 'Nessuna voce inclusa.' } })
  const variable = sum(included.filter((c) => c.kind === 'variable').map((c) => d(c.amount)))
  const fixed = sum(included.filter((c) => c.kind === 'fixed').map((c) => d(c.amount)))
  const selected = variable.plus(fixed)
  return {
    pricePerUnit: selected.div(b.consumption),
    variableOnly: variable.div(b.consumption),
    selected,
    variable,
    fixed,
    includesFixed: fixed.gt(0),
  }
}

export async function tariffRoutes(app: FastifyInstance) {
  const db = app.database.db

  app.get('/tariffs', async (req) => {
    const ctx = requireCompany(req, 'tariffs.read')
    const q = parse(z.object({ archived: z.enum(['0', '1', 'all']).default('0'), date: isoDate.optional() }), req.query)
    const date = q.date ?? today()
    let query = db
      .selectFrom('utility_tariffs as t')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('tariff_versions as v')
            .select(['v.price_per_unit', 'v.valid_from', 'v.origin', 'v.m3_to_smc', 'v.smc_to_kwh'])
            .whereRef('v.tariff_id', '=', 't.id')
            .where('v.valid_from', '<=', date)
            .orderBy('v.valid_from', 'desc')
            .limit(1)
            .as('v'),
        (j) => j.onTrue(),
      )
      .select(['t.id', 't.name', 't.kind', 't.unit', 't.notes', 't.archived_at', 'v.price_per_unit', 'v.valid_from', 'v.origin', 'v.m3_to_smc', 'v.smc_to_kwh'])
      .where('t.company_id', '=', ctx.companyId)
    if (q.archived === '0') query = query.where('t.archived_at', 'is', null)
    if (q.archived === '1') query = query.where('t.archived_at', 'is not', null)
    const rows = await query.orderBy('t.kind').orderBy('t.name').execute()
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        unit: r.unit,
        notes: r.notes,
        archived: r.archived_at !== null,
        current: r.price_per_unit !== null ? { pricePerUnit: r.price_per_unit, validFrom: r.valid_from, origin: r.origin, m3ToSmc: r.m3_to_smc, smcToKwh: r.smc_to_kwh } : null,
      })),
      meta: { date },
    }
  })

  app.get('/tariffs/:id', async (req) => {
    const ctx = requireCompany(req, 'tariffs.read')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const t = await db.selectFrom('utility_tariffs').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!t) throw notFound('Tariffa')
    const versions = await db
      .selectFrom('tariff_versions as v')
      .leftJoin('users as u', 'u.id', 'v.created_by')
      .select(['v.id', 'v.price_per_unit', 'v.valid_from', 'v.origin', 'v.m3_to_smc', 'v.smc_to_kwh', 'v.bill', 'v.notes', 'v.created_at', 'u.name as created_by'])
      .where('v.tariff_id', '=', id)
      .where('v.company_id', '=', ctx.companyId)
      .orderBy('v.valid_from', 'desc')
      .execute()
    const equipment = await db
      .selectFrom('equipment')
      .select(['id', 'code', 'name'])
      .where('company_id', '=', ctx.companyId)
      .where((eb) => eb.or([eb('electric_tariff_id', '=', id), eb('gas_tariff_id', '=', id)]))
      .orderBy('name')
      .execute()
    const t0 = today()
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      unit: t.unit,
      notes: t.notes,
      archived: t.archived_at !== null,
      versions: versions.map((v) => ({ ...v, future: v.valid_from > t0 })),
      current: versions.find((v) => v.valid_from <= t0) ?? null,
      equipment,
    }
  })

  app.post('/tariffs', async (req) => {
    const ctx = requireCompany(req, 'tariffs.manage')
    const body = parse(tariffBody.and(z.object({ firstVersion: versionBody.optional() })), req.body)
    const created = await db.transaction().execute(async (trx) => {
      const t = await trx
        .insertInto('utility_tariffs')
        .values({ company_id: ctx.companyId, name: body.name, kind: body.kind, unit: body.unit, notes: body.notes ?? null })
        .returning(['id', 'name'])
        .executeTakeFirstOrThrow()
      if (body.firstVersion) await insertVersion(trx, ctx.companyId, ctx.user.id, { id: t.id, unit: body.unit, kind: body.kind }, body.firstVersion)
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'tariff', entityId: t.id, action: 'created', details: { name: body.name, kind: body.kind, unit: body.unit } })
      return t
    })
    return created
  })

  app.patch('/tariffs/:id', async (req) => {
    const ctx = requireCompany(req, 'tariffs.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const body = parse(z.object({ name: reqText('Il nome', 120), notes: optText(1000) }), req.body)
    const res = await db.updateTable('utility_tariffs').set({ name: body.name, notes: body.notes ?? null, updated_at: new Date() }).where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!res.numUpdatedRows) throw notFound('Tariffa')
    return { ok: true }
  })

  /** Anteprima del calcolo da bolletta, senza salvare. */
  app.post('/tariffs/bill-preview', async (req) => {
    requireCompany(req, 'tariffs.read')
    const body = parse(billVersion, req.body)
    const r = computeBillTariff(body)
    return {
      pricePerUnit: r.pricePerUnit.toFixed(),
      variableOnlyPricePerUnit: r.variableOnly.toFixed(),
      selectedTotal: r.selected.toFixed(),
      variableTotal: r.variable.toFixed(),
      fixedTotal: r.fixed.toFixed(),
      includesFixed: r.includesFixed,
      note: 'Tariffa media del periodo: costo delle voci selezionate diviso il consumo.',
    }
  })

  app.post('/tariffs/:id/versions', async (req) => {
    const ctx = requireCompany(req, 'tariffs.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const body = parse(versionBody, req.body)
    const t = await db.selectFrom('utility_tariffs').select(['id', 'unit', 'kind']).where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!t) throw notFound('Tariffa')
    const v = await db.transaction().execute((trx) => insertVersion(trx, ctx.companyId, ctx.user.id, t, body))
    const affected = await invalidate(db, ctx.companyId, { type: 'tariffs', ids: [id] })
    return { id: v, affectedRecipes: await describeRecipes(db, ctx.companyId, affected) }
  })

  app.delete('/tariffs/:id/versions/:versionId', async (req) => {
    const ctx = requireCompany(req, 'tariffs.manage')
    const { id, versionId } = parse(z.object({ id: z.uuid(), versionId: z.uuid() }), req.params)
    const res = await db.deleteFrom('tariff_versions').where('id', '=', versionId).where('tariff_id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!res.numDeletedRows) throw notFound('Versione della tariffa')
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'tariff_version', entityId: versionId, action: 'deleted' })
    const affected = await invalidate(db, ctx.companyId, { type: 'tariffs', ids: [id] })
    return { ok: true, affectedRecipes: await describeRecipes(db, ctx.companyId, affected) }
  })

  app.post('/tariffs/:id/archive', async (req) => {
    const ctx = requireCompany(req, 'tariffs.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const res = await db.updateTable('utility_tariffs').set({ archived_at: new Date() }).where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!res.numUpdatedRows) throw notFound('Tariffa')
    return { ok: true }
  })
  app.post('/tariffs/:id/restore', async (req) => {
    const ctx = requireCompany(req, 'tariffs.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const res = await db.updateTable('utility_tariffs').set({ archived_at: null }).where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!res.numUpdatedRows) throw notFound('Tariffa')
    return { ok: true }
  })
}

async function insertVersion(
  trx: Kysely<DB>,
  companyId: string,
  userId: string,
  t: { id: string; unit: string; kind: string },
  body: z.infer<typeof versionBody>,
): Promise<string> {
  let price: string
  let bill: Record<string, unknown> | null = null
  if (body.mode === 'direct') price = body.pricePerUnit
  else {
    if (body.consumptionUnit !== t.unit) {
      throw badRequest('validation_failed', `Il consumo in bolletta deve essere espresso nell’unità della tariffa (${t.unit}).`, { fields: { consumptionUnit: 'Unità non coerente.' } })
    }
    if (body.periodTo < body.periodFrom) throw badRequest('validation_failed', 'Il periodo della bolletta non è coerente.', { fields: { periodTo: 'Fine precedente all’inizio.' } })
    const r = computeBillTariff(body)
    price = r.pricePerUnit.toFixed()
    bill = {
      periodFrom: body.periodFrom,
      periodTo: body.periodTo,
      consumption: body.consumption,
      consumptionUnit: body.consumptionUnit,
      vatBasis: 'net',
      components: body.components,
      selectedTotal: r.selected.toFixed(),
      variableTotal: r.variable.toFixed(),
      fixedTotal: r.fixed.toFixed(),
      includesFixed: r.includesFixed,
    }
  }
  if (t.kind !== 'gas' && (body.m3ToSmc || body.smcToKwh)) throw badRequest('validation_failed', 'I coefficienti di conversione si applicano solo alle tariffe gas.')
  const dup = await trx.selectFrom('tariff_versions').select('id').where('tariff_id', '=', t.id).where('valid_from', '=', body.validFrom).executeTakeFirst()
  if (dup) throw conflict('version_date_conflict', 'Esiste già un valore con questa data di validità.', { fields: { validFrom: 'Data già usata.' } })
  const v = await trx
    .insertInto('tariff_versions')
    .values({
      company_id: companyId,
      tariff_id: t.id,
      price_per_unit: price,
      valid_from: body.validFrom,
      origin: body.mode,
      m3_to_smc: body.m3ToSmc ?? null,
      smc_to_kwh: body.smcToKwh ?? null,
      bill: bill ? JSON.stringify(bill) : null,
      notes: body.notes ?? null,
      created_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await audit(trx, { companyId, userId, entityType: 'tariff_version', entityId: v.id, action: 'created', details: { tariffId: t.id, pricePerUnit: price, validFrom: body.validFrom, origin: body.mode } })
  return v.id
}
