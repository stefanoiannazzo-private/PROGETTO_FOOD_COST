import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { z } from 'zod'
import { d, employeeRates } from '@foodcost/domain'
import { can, parse, requireCompany } from '../http/context'
import { badRequest, conflict, notFound } from '../http/errors'
import { dec, decOpt, isoDate, likePattern, listQuery, optText, reqText, today } from '../http/schemas'
import { audit } from '../services/audit'
import { describeRecipes, invalidate } from '../services/costing'
import { nextCode } from '../services/codes'

const employeeBody = z.object({
  code: optText(40),
  firstName: reqText('Il nome', 80),
  lastName: reqText('Il cognome', 80),
  jobTitle: optText(120),
  status: z.enum(['active', 'inactive']).default('active'),
  userId: z.uuid().nullable().optional(),
})

export const costConfigBody = z
  .object({
    validFrom: isoDate,
    grossMonthly: dec({ min: 0, label: 'Il lordo mensile' }),
    contributionsMode: z.enum(['none', 'amount', 'percent']),
    contributionsValue: decOpt({ min: 0, label: 'Gli oneri' }),
    otherMonthlyCosts: decOpt({ min: 0, label: 'Gli altri costi' }),
    productiveHours: dec({ gt: 0, max: 744, label: 'Le ore mensili produttive' }),
    notes: optText(500),
  })
  .superRefine((b, ctx) => {
    if (b.contributionsMode === 'none' && b.contributionsValue) {
      ctx.addIssue({ code: 'custom', path: ['contributionsValue'], message: 'Hai scelto “nessun onere”: lascia vuoto l’importo.' })
    }
    if (b.contributionsMode !== 'none' && !b.contributionsValue) {
      ctx.addIssue({ code: 'custom', path: ['contributionsValue'], message: 'Indica l’importo o la percentuale degli oneri.' })
    }
    if (b.contributionsMode === 'percent' && b.contributionsValue && d(b.contributionsValue).gt(200)) {
      ctx.addIssue({ code: 'custom', path: ['contributionsValue'], message: 'Percentuale oneri non plausibile (oltre 200%).' })
    }
  })

export function ratesFor(c: { gross_monthly: string; contributions_mode: 'none' | 'amount' | 'percent'; contributions_value: string | null; other_monthly_costs: string; productive_hours: string }) {
  const r = employeeRates({
    grossMonthly: d(c.gross_monthly),
    contributionsMode: c.contributions_mode,
    contributionsValue: c.contributions_value ? d(c.contributions_value) : null,
    otherMonthlyCosts: d(c.other_monthly_costs),
    productiveHours: d(c.productive_hours),
  })
  return {
    grossHourly: r.grossHourly.toFixed(),
    contributionsMonthly: r.contributions.toFixed(),
    companyMonthly: r.companyMonthly.toFixed(),
    companyHourly: r.companyHourly.toFixed(),
    costPerMinute: r.costPerMinute.toFixed(),
    basis: r.basis,
  }
}

export async function employeeRoutes(app: FastifyInstance) {
  const db = app.database.db

  /**
   * Elenco dipendenti. Le retribuzioni e i costi orari compaiono SOLO con il permesso salaries.read:
   * negli altri casi i campi non sono nemmeno presenti nel payload.
   */
  app.get('/employees', async (req) => {
    const ctx = requireCompany(req)
    if (!can(ctx, 'employees.read') && !can(ctx, 'recipes.manage')) throw notFound('Elenco')
    const q = parse(listQuery.extend({ status: z.enum(['active', 'inactive']).optional() }), req.query)
    const salaries = can(ctx, 'salaries.read')
    const t = today()
    let query = db
      .selectFrom('employees as e')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('employee_cost_configs as c')
            .selectAll('c')
            .whereRef('c.employee_id', '=', 'e.id')
            .where('c.valid_from', '<=', t)
            .orderBy('c.valid_from', 'desc')
            .limit(1)
            .as('c'),
        (j) => j.onTrue(),
      )
      .where('e.company_id', '=', ctx.companyId)
    if (q.archived === '0') query = query.where('e.archived_at', 'is', null)
    if (q.archived === '1') query = query.where('e.archived_at', 'is not', null)
    if (q.status) query = query.where('e.status', '=', q.status)
    if (q.q) {
      const pat = likePattern(q.q)
      query = query.where((eb) =>
        eb.or([eb(eb.fn('lower', ['e.first_name']), 'like', pat), eb(eb.fn('lower', ['e.last_name']), 'like', pat), eb(eb.fn('lower', ['e.code']), 'like', pat), eb(eb.fn('lower', ['e.job_title']), 'like', pat)]),
      )
    }
    const sorts = { name: 'e.last_name', code: 'e.code', job: 'e.job_title', updated: 'e.updated_at' } as const
    const rows = await query
      .select([
        'e.id',
        'e.code',
        'e.first_name',
        'e.last_name',
        'e.job_title',
        'e.status',
        'e.archived_at',
        'c.id as config_id',
        'c.valid_from',
        'c.gross_monthly',
        'c.contributions_mode',
        'c.contributions_value',
        'c.other_monthly_costs',
        'c.productive_hours',
        sql<string>`count(*) over()`.as('total_count'),
      ])
      .orderBy(sql.ref(sorts[(q.sort ?? 'name') as keyof typeof sorts] ?? 'e.last_name'), q.dir)
      .orderBy('e.first_name')
      .orderBy('e.id')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .execute()
    return {
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        firstName: r.first_name,
        lastName: r.last_name,
        name: `${r.first_name} ${r.last_name}`,
        jobTitle: r.job_title,
        status: r.status,
        archived: r.archived_at !== null,
        hasCost: r.config_id !== null,
        ...(salaries && r.config_id
          ? {
              cost: {
                validFrom: r.valid_from,
                grossMonthly: r.gross_monthly,
                contributionsMode: r.contributions_mode,
                ...ratesFor({ gross_monthly: r.gross_monthly!, contributions_mode: r.contributions_mode!, contributions_value: r.contributions_value, other_monthly_costs: r.other_monthly_costs!, productive_hours: r.productive_hours! }),
              },
            }
          : {}),
      })),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(rows[0]?.total_count ?? 0), salariesVisible: salaries },
    }
  })

  app.get('/employees/:id', async (req) => {
    const ctx = requireCompany(req, 'employees.read')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const e = await db.selectFrom('employees').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!e) throw notFound('Dipendente')
    const salaries = can(ctx, 'salaries.read')
    const configs = salaries ? await db.selectFrom('employee_cost_configs').selectAll().where('employee_id', '=', id).where('company_id', '=', ctx.companyId).orderBy('valid_from', 'desc').execute() : []
    const t = today()
    const configCount = salaries
      ? configs.length
      : Number((await db.selectFrom('employee_cost_configs').select(({ fn }) => fn.countAll<string>().as('n')).where('employee_id', '=', id).executeTakeFirstOrThrow()).n)
    return {
      id: e.id,
      code: e.code,
      firstName: e.first_name,
      lastName: e.last_name,
      jobTitle: e.job_title,
      status: e.status,
      userId: e.user_id,
      archived: e.archived_at !== null,
      salariesVisible: salaries,
      hasCost: configCount > 0,
      ...(salaries
        ? {
            costs: configs.map((c) => ({
              id: c.id,
              validFrom: c.valid_from,
              grossMonthly: c.gross_monthly,
              contributionsMode: c.contributions_mode,
              contributionsValue: c.contributions_value,
              otherMonthlyCosts: c.other_monthly_costs,
              productiveHours: c.productive_hours,
              notes: c.notes,
              current: c.valid_from <= t && configs.find((x) => x.valid_from <= t)?.id === c.id,
              future: c.valid_from > t,
              ...ratesFor(c),
            })),
          }
        : {}),
    }
  })

  app.post('/employees', async (req) => {
    const ctx = requireCompany(req, 'employees.manage')
    const body = parse(employeeBody.extend({ firstCost: costConfigBody.optional() }), req.body)
    if (body.firstCost && !can(ctx, 'salaries.read')) throw badRequest('forbidden_salary', 'Non hai i permessi per inserire dati retributivi.')
    return db.transaction().execute(async (trx) => {
      const code = body.code ?? (await nextCode(trx, 'employees', ctx.companyId, 'DIP'))
      const dup = await trx.selectFrom('employees').select('id').where('company_id', '=', ctx.companyId).where(sql`lower(code)`, '=', code.toLowerCase()).executeTakeFirst()
      if (dup) throw conflict('duplicate_code', `Il codice ${code} è già in uso.`, { fields: { code: 'Codice già in uso.' } })
      if (body.userId) await assertMember(ctx.companyId, body.userId)
      const e = await trx
        .insertInto('employees')
        .values({ company_id: ctx.companyId, code, first_name: body.firstName, last_name: body.lastName, job_title: body.jobTitle ?? null, status: body.status, user_id: body.userId ?? null })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow()
      if (body.firstCost) await insertConfig(trx, ctx.companyId, ctx.user.id, e.id, body.firstCost)
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'employee', entityId: e.id, action: 'created', details: { code } })
      return e
    })
  })

  app.patch('/employees/:id', async (req) => {
    const ctx = requireCompany(req, 'employees.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const body = parse(employeeBody.extend({ code: reqText('Il codice', 40) }), req.body)
    const dup = await db.selectFrom('employees').select('id').where('company_id', '=', ctx.companyId).where(sql`lower(code)`, '=', body.code.toLowerCase()).where('id', '<>', id).executeTakeFirst()
    if (dup) throw conflict('duplicate_code', `Il codice ${body.code} è già in uso.`, { fields: { code: 'Codice già in uso.' } })
    if (body.userId) await assertMember(ctx.companyId, body.userId)
    const res = await db
      .updateTable('employees')
      .set({ code: body.code, first_name: body.firstName, last_name: body.lastName, job_title: body.jobTitle ?? null, status: body.status, user_id: body.userId ?? null, updated_at: new Date() })
      .where('id', '=', id)
      .where('company_id', '=', ctx.companyId)
      .executeTakeFirst()
    if (!res.numUpdatedRows) throw notFound('Dipendente')
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'employee', entityId: id, action: 'updated', details: { code: body.code, status: body.status } })
    return { ok: true }
  })

  /** Nuova configurazione di costo con decorrenza: mantiene lo storico e aggiorna le ricette interessate. */
  app.post('/employees/:id/costs', async (req) => {
    const ctx = requireCompany(req, 'employees.manage', 'salaries.read')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const body = parse(costConfigBody, req.body)
    const e = await db.selectFrom('employees').select('id').where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!e) throw notFound('Dipendente')
    const cfgId = await db.transaction().execute((trx) => insertConfig(trx, ctx.companyId, ctx.user.id, id, body))
    const affected = await invalidate(db, ctx.companyId, { type: 'employees', ids: [id] })
    return { id: cfgId, affectedRecipes: await describeRecipes(db, ctx.companyId, affected) }
  })

  app.delete('/employees/:id/costs/:configId', async (req) => {
    const ctx = requireCompany(req, 'employees.manage', 'salaries.read')
    const { id, configId } = parse(z.object({ id: z.uuid(), configId: z.uuid() }), req.params)
    const res = await db.deleteFrom('employee_cost_configs').where('id', '=', configId).where('employee_id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!res.numDeletedRows) throw notFound('Configurazione')
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'employee_cost', entityId: configId, action: 'deleted' })
    const affected = await invalidate(db, ctx.companyId, { type: 'employees', ids: [id] })
    return { ok: true, affectedRecipes: await describeRecipes(db, ctx.companyId, affected) }
  })

  app.post('/employees/cost-preview', async (req) => {
    requireCompany(req, 'salaries.read')
    const b = parse(costConfigBody, req.body)
    return ratesFor({ gross_monthly: b.grossMonthly, contributions_mode: b.contributionsMode, contributions_value: b.contributionsValue ?? null, other_monthly_costs: b.otherMonthlyCosts ?? '0', productive_hours: b.productiveHours })
  })

  for (const [action, archived] of [['archive', true], ['restore', false]] as const) {
    app.post(`/employees/:id/${action}`, async (req) => {
      const ctx = requireCompany(req, 'employees.manage')
      const { id } = parse(z.object({ id: z.uuid() }), req.params)
      const res = await db.updateTable('employees').set({ archived_at: archived ? new Date() : null, updated_at: new Date() }).where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
      if (!res.numUpdatedRows) throw notFound('Dipendente')
      await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'employee', entityId: id, action: archived ? 'archived' : 'restored' })
      return { ok: true }
    })
  }

  async function assertMember(companyId: string, userId: string) {
    const m = await db.selectFrom('memberships').select('id').where('company_id', '=', companyId).where('user_id', '=', userId).executeTakeFirst()
    if (!m) throw badRequest('validation_failed', 'L’account collegato non appartiene a questa azienda.', { fields: { userId: 'Utente non valido.' } })
  }
}

async function insertConfig(trx: import('kysely').Kysely<import('../db/types').DB>, companyId: string, userId: string, employeeId: string, b: z.infer<typeof costConfigBody>) {
  const dup = await trx.selectFrom('employee_cost_configs').select('id').where('employee_id', '=', employeeId).where('valid_from', '=', b.validFrom).executeTakeFirst()
  if (dup) throw conflict('config_date_conflict', 'Esiste già una configurazione con questa decorrenza.', { fields: { validFrom: 'Data già usata.' } })
  const c = await trx
    .insertInto('employee_cost_configs')
    .values({
      company_id: companyId,
      employee_id: employeeId,
      valid_from: b.validFrom,
      gross_monthly: b.grossMonthly,
      contributions_mode: b.contributionsMode,
      contributions_value: b.contributionsMode === 'none' ? null : b.contributionsValue!,
      other_monthly_costs: b.otherMonthlyCosts ?? '0',
      productive_hours: b.productiveHours,
      notes: b.notes ?? null,
      created_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  // l'audit registra il fatto, non gli importi
  await audit(trx, { companyId, userId, entityType: 'employee_cost', entityId: c.id, action: 'created', details: { employeeId, validFrom: b.validFrom, contributionsMode: b.contributionsMode } })
  return c.id
}
