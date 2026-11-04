import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { hashPassword, hashToken, newToken, PASSWORD_MIN_LENGTH, verifyPassword } from '../auth/crypto'
import { effectivePermissions, ROLE_LABELS, type Role } from '../auth/permissions'
import { parse, requireAuth } from '../http/context'
import { AppError, badRequest, forbidden } from '../http/errors'
import { createSession, destroySession, loadSession, SESSION_COOKIE } from '../services/sessions'
import { audit } from '../services/audit'
import { sendMail } from '../services/mailer'

const password = z.string().min(PASSWORD_MIN_LENGTH, `La password deve avere almeno ${PASSWORD_MIN_LENGTH} caratteri.`).max(200)

export async function authRoutes(app: FastifyInstance) {
  const db = app.database.db
  const cfg = app.cfg

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure, maxAge: cfg.sessionDays * 86400 })

  async function me(userId: string, auth: ReturnType<typeof requireAuth> | null) {
    const companies = await db
      .selectFrom('memberships as m')
      .innerJoin('companies as c', 'c.id', 'm.company_id')
      .select(['c.id', 'c.name', 'm.role'])
      .where('m.user_id', '=', userId)
      .where('m.is_active', '=', true)
      .where('c.archived_at', 'is', null)
      .orderBy('c.name')
      .execute()
    return {
      user: auth?.user ?? null,
      company: auth?.company ?? null,
      role: auth?.role ?? null,
      roleLabel: auth?.role ? ROLE_LABELS[auth.role] : null,
      permissions: auth ? [...auth.permissions].sort() : [],
      companies: companies.map((c) => ({ id: c.id, name: c.name, role: c.role, roleLabel: ROLE_LABELS[c.role] })),
    }
  }

  app.post('/auth/login', { config: { rateLimit: { max: cfg.loginRateLimit, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase().min(3), password: z.string().min(1) }), req.body)
    const user = await db.selectFrom('users').selectAll().where(({ fn }) => fn('lower', ['email']), '=', body.email).executeTakeFirst()
    // stesso messaggio per utente inesistente, disattivato o password errata
    if (!user || !user.is_active || !(await verifyPassword(body.password, user.password_hash))) {
      throw new AppError(401, 'invalid_credentials', 'Email o password non corrette.')
    }
    const memberships = await db
      .selectFrom('memberships as m')
      .innerJoin('companies as c', 'c.id', 'm.company_id')
      .select('m.company_id')
      .where('m.user_id', '=', user.id)
      .where('m.is_active', '=', true)
      .where('c.archived_at', 'is', null)
      .execute()
    const active = memberships.length === 1 ? memberships[0]!.company_id : null
    const token = await createSession(db, user.id, cfg.sessionDays, active)
    await db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute()
    setCookie(reply, token)
    await audit(db, { companyId: active, userId: user.id, entityType: 'user', entityId: user.id, action: 'login' })
    return me(user.id, await loadSession(db, token))
  })

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) await destroySession(db, req.auth.sessionHash)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/auth/me', async (req) => {
    const auth = requireAuth(req)
    return me(auth.user.id, auth)
  })

  /** Selezione esplicita dell'azienda attiva, verificata contro le membership. */
  app.post('/auth/company', async (req) => {
    const auth = requireAuth(req)
    const { companyId } = parse(z.object({ companyId: z.uuid() }), req.body)
    const m = await db
      .selectFrom('memberships as m')
      .innerJoin('companies as c', 'c.id', 'm.company_id')
      .select(['m.role', 'm.extra_permissions', 'c.id', 'c.name'])
      .where('m.user_id', '=', auth.user.id)
      .where('m.company_id', '=', companyId)
      .where('m.is_active', '=', true)
      .where('c.archived_at', 'is', null)
      .executeTakeFirst()
    if (!m) throw forbidden('Non appartieni a questa azienda.')
    await db.updateTable('sessions').set({ active_company_id: companyId }).where('token_hash', '=', auth.sessionHash).execute()
    return me(auth.user.id, {
      ...auth,
      company: { id: m.id, name: m.name },
      role: m.role as Role,
      permissions: effectivePermissions(m.role as Role, m.extra_permissions),
    })
  })

  app.post('/auth/password/change', async (req) => {
    const auth = requireAuth(req)
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body)
    const user = await db.selectFrom('users').select('password_hash').where('id', '=', auth.user.id).executeTakeFirstOrThrow()
    if (!(await verifyPassword(body.currentPassword, user.password_hash))) throw badRequest('invalid_password', 'La password attuale non è corretta.')
    await db.updateTable('users').set({ password_hash: await hashPassword(body.newPassword) }).where('id', '=', auth.user.id).execute()
    // chiude le altre sessioni
    await db.deleteFrom('sessions').where('user_id', '=', auth.user.id).where('token_hash', '<>', auth.sessionHash).execute()
    return { ok: true }
  })

  app.post('/auth/password/forgot', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().min(3) }), req.body)
    const user = await db.selectFrom('users').select(['id', 'email', 'is_active']).where(({ fn }) => fn('lower', ['email']), '=', email).executeTakeFirst()
    let devLink: string | undefined
    if (user && user.is_active) {
      const token = newToken()
      await db.insertInto('password_resets').values({ token_hash: hashToken(token), user_id: user.id, expires_at: new Date(Date.now() + 60 * 60 * 1000) }).execute()
      const link = `${cfg.appUrl}/reimposta-password?token=${token}`
      try {
        await sendMail(cfg.storageDir, user.email, 'Food Cost — reimpostazione password', `Per reimpostare la password apri questo link entro 60 minuti:\n${link}\n`)
      } catch (e) {
        // la risposta resta identica: non si rivela se l'indirizzo esiste
        req.log.error({ err: (e as Error).message }, 'invio email di reset non riuscito')
      }
      if (cfg.devExposeTokens) devLink = link
    }
    // risposta identica che l'utente esista o meno
    return { ok: true, message: 'Se l’indirizzo è registrato riceverai un’email con le istruzioni.', ...(devLink ? { devLink } : {}) }
  })

  app.post('/auth/password/reset', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    const body = parse(z.object({ token: z.string().min(10), password }), req.body)
    const row = await db.selectFrom('password_resets').selectAll().where('token_hash', '=', hashToken(body.token)).executeTakeFirst()
    if (!row || row.used_at || row.expires_at.getTime() < Date.now()) throw badRequest('invalid_token', 'Il link non è valido o è scaduto.')
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('password_resets').set({ used_at: new Date() }).where('token_hash', '=', row.token_hash).execute()
      await trx.updateTable('users').set({ password_hash: await hashPassword(body.password) }).where('id', '=', row.user_id).execute()
      await trx.deleteFrom('sessions').where('user_id', '=', row.user_id).execute()
    })
    return { ok: true }
  })

  app.get('/auth/invitations/:token', async (req) => {
    const { token } = req.params as { token: string }
    const inv = await db
      .selectFrom('invitations as i')
      .innerJoin('companies as c', 'c.id', 'i.company_id')
      .select(['i.email', 'i.name', 'i.role', 'i.expires_at', 'i.accepted_at', 'c.name as company'])
      .where('i.token_hash', '=', hashToken(token))
      .executeTakeFirst()
    if (!inv || inv.accepted_at || inv.expires_at.getTime() < Date.now()) throw badRequest('invalid_token', 'L’invito non è valido o è scaduto.')
    const existing = await db.selectFrom('users').select('id').where(({ fn }) => fn('lower', ['email']), '=', inv.email.toLowerCase()).executeTakeFirst()
    return { email: inv.email, name: inv.name, company: inv.company, role: inv.role, roleLabel: ROLE_LABELS[inv.role], existingUser: !!existing }
  })

  app.post('/auth/invitations/accept', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(10), password: z.string().min(1) }), req.body)
    const inv = await db.selectFrom('invitations').selectAll().where('token_hash', '=', hashToken(body.token)).executeTakeFirst()
    if (!inv || inv.accepted_at || inv.expires_at.getTime() < Date.now()) throw badRequest('invalid_token', 'L’invito non è valido o è scaduto.')
    const existing = await db.selectFrom('users').selectAll().where(({ fn }) => fn('lower', ['email']), '=', inv.email.toLowerCase()).executeTakeFirst()
    let userId: string
    if (existing) {
      // un utente già registrato conferma con la propria password
      if (!(await verifyPassword(body.password, existing.password_hash))) throw badRequest('invalid_password', 'Password non corretta per l’account esistente.')
      userId = existing.id
    } else {
      parse(z.object({ password }), { password: body.password })
      const created = await db.insertInto('users').values({ email: inv.email, name: inv.name, password_hash: await hashPassword(body.password) }).returning('id').executeTakeFirstOrThrow()
      userId = created.id
    }
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('invitations').set({ accepted_at: new Date() }).where('id', '=', inv.id).execute()
      await trx
        .insertInto('memberships')
        .values({ company_id: inv.company_id, user_id: userId, role: inv.role, extra_permissions: inv.extra_permissions })
        .onConflict((oc) => oc.columns(['company_id', 'user_id']).doUpdateSet({ role: inv.role, extra_permissions: inv.extra_permissions, is_active: true }))
        .execute()
    })
    await audit(db, { companyId: inv.company_id, userId, entityType: 'membership', entityId: userId, action: 'invitation_accepted', details: { role: inv.role } })
    const token = await createSession(db, userId, cfg.sessionDays, inv.company_id)
    setCookie(reply, token)
    return me(userId, await loadSession(db, token))
  })
}
