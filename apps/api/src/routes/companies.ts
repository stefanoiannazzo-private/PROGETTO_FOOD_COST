import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parse, requireAuth, requireCompany } from '../http/context'
import { forbidden } from '../http/errors'
import { audit } from '../services/audit'

/**
 * Gestione minima delle aziende: un amministratore di piattaforma (COMETOWEB) crea le aziende clienti
 * e ne diventa amministratore per invitarne gli utenti. Niente registrazione pubblica.
 */
export async function companyRoutes(app: FastifyInstance) {
  const db = app.database.db

  app.post('/companies', async (req) => {
    const auth = requireAuth(req)
    if (!auth.user.isPlatformAdmin) throw forbidden('Solo l’amministratore della piattaforma può creare aziende.')
    const body = parse(z.object({ name: z.string().trim().min(2).max(160) }), req.body)
    return db.transaction().execute(async (trx) => {
      const c = await trx.insertInto('companies').values({ name: body.name }).returning(['id', 'name']).executeTakeFirstOrThrow()
      await trx.insertInto('memberships').values({ company_id: c.id, user_id: auth.user.id, role: 'admin' }).execute()
      await audit(trx, { companyId: c.id, userId: auth.user.id, entityType: 'company', entityId: c.id, action: 'created', details: { name: c.name } })
      return c
    })
  })

  app.patch('/companies/current', async (req) => {
    const ctx = requireCompany(req, 'users.manage')
    const body = parse(z.object({ name: z.string().trim().min(2).max(160) }), req.body)
    await db.updateTable('companies').set({ name: body.name }).where('id', '=', ctx.companyId).execute()
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'company', entityId: ctx.companyId, action: 'renamed', details: body })
    return { ok: true }
  })
}
