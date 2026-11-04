import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hashToken, newToken } from '../auth/crypto'
import { GRANTABLE, PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, ROLES } from '../auth/permissions'
import { parse, requireCompany } from '../http/context'
import { conflict, notFound } from '../http/errors'
import { audit } from '../services/audit'
import { sendMail } from '../services/mailer'

const extraPermissions = z.array(z.enum(GRANTABLE as [string, ...string[]])).default([])

export async function userRoutes(app: FastifyInstance) {
  const db = app.database.db

  /** Catalogo di ruoli e permessi per la UI. */
  app.get('/users/catalog', async (req) => {
    requireCompany(req)
    return {
      roles: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r] })),
      permissions: Object.entries(PERMISSIONS).map(([value, label]) => ({ value, label, grantable: (GRANTABLE as string[]).includes(value) })),
    }
  })

  app.get('/users', async (req) => {
    const ctx = requireCompany(req, 'users.manage')
    const rows = await db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.id', 'm.role', 'm.extra_permissions', 'm.is_active', 'm.created_at', 'u.id as user_id', 'u.name', 'u.email', 'u.last_login_at', 'u.is_active as user_active'])
      .where('m.company_id', '=', ctx.companyId)
      .orderBy('u.name')
      .execute()
    const invitations = await db
      .selectFrom('invitations')
      .select(['id', 'email', 'name', 'role', 'expires_at', 'created_at'])
      .where('company_id', '=', ctx.companyId)
      .where('accepted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute()
    return {
      data: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        name: r.name,
        email: r.email,
        role: r.role,
        roleLabel: ROLE_LABELS[r.role],
        extraPermissions: r.extra_permissions,
        isActive: r.is_active && r.user_active,
        lastLoginAt: r.last_login_at,
        isSelf: r.user_id === ctx.user.id,
      })),
      invitations: invitations.map((i) => ({ ...i, roleLabel: ROLE_LABELS[i.role], expired: i.expires_at.getTime() < Date.now() })),
    }
  })

  app.post('/users/invitations', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    const ctx = requireCompany(req, 'users.manage')
    const body = parse(
      z.object({ email: z.email('Email non valida.').trim().toLowerCase(), name: z.string().trim().min(2).max(120), role: z.enum(ROLES), extraPermissions }),
      req.body,
    )
    const already = await db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select('m.id')
      .where('m.company_id', '=', ctx.companyId)
      .where(({ fn }) => fn('lower', ['u.email']), '=', body.email)
      .where('m.is_active', '=', true)
      .executeTakeFirst()
    if (already) throw conflict('already_member', 'Questo utente fa già parte dell’azienda.')
    const token = newToken()
    const inv = await db
      .insertInto('invitations')
      .values({
        company_id: ctx.companyId,
        email: body.email,
        name: body.name,
        role: body.role,
        extra_permissions: body.extraPermissions,
        token_hash: hashToken(token),
        invited_by: ctx.user.id,
        expires_at: new Date(Date.now() + 7 * 86400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const link = `${app.cfg.appUrl}/invito?token=${token}`
    let mail: 'sent' | 'outbox' | 'failed'
    try {
      mail = await sendMail(app.cfg.storageDir, body.email, `Invito a Food Cost — ${ctx.company.name}`, `${ctx.user.name} ti ha invitato su Food Cost per ${ctx.company.name} come ${ROLE_LABELS[body.role]}.\nAccetta l’invito entro 7 giorni:\n${link}\n`)
    } catch (e) {
      req.log.error({ err: (e as Error).message }, 'invio email di invito non riuscito')
      mail = 'failed'
    }
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'invitation', entityId: inv.id, action: 'created', details: { email: body.email, role: body.role } })
    // se l'email non è partita, l'amministratore riceve il link da consegnare di persona
    return { id: inv.id, mail, ...(mail !== 'sent' || app.cfg.devExposeTokens ? { inviteLink: link } : {}) }
  })

  app.delete('/users/invitations/:id', async (req) => {
    const ctx = requireCompany(req, 'users.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const res = await db.deleteFrom('invitations').where('id', '=', id).where('company_id', '=', ctx.companyId).where('accepted_at', 'is', null).executeTakeFirst()
    if (!res.numDeletedRows) throw notFound('Invito')
    return { ok: true }
  })

  /** Modifica ruolo, permessi aggiuntivi o stato di una membership. */
  app.patch('/users/:id', async (req) => {
    const ctx = requireCompany(req, 'users.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const body = parse(z.object({ role: z.enum(ROLES).optional(), extraPermissions: extraPermissions.optional(), isActive: z.boolean().optional() }), req.body)
    return db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom('memberships').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).forUpdate().executeTakeFirst()
      if (!m) throw notFound('Utente')
      const nextRole = body.role ?? m.role
      const nextActive = body.isActive ?? m.is_active
      if (m.role === 'admin' && (nextRole !== 'admin' || !nextActive)) {
        const admins = await trx
          .selectFrom('memberships')
          .select(({ fn }) => fn.countAll<string>().as('n'))
          .where('company_id', '=', ctx.companyId)
          .where('role', '=', 'admin')
          .where('is_active', '=', true)
          .executeTakeFirstOrThrow()
        if (Number(admins.n) <= 1) throw conflict('last_admin', 'Deve restare almeno un amministratore attivo.')
      }
      await trx
        .updateTable('memberships')
        .set({ role: nextRole, extra_permissions: body.extraPermissions ?? m.extra_permissions, is_active: nextActive })
        .where('id', '=', id)
        .execute()
      if (!nextActive) {
        // la disattivazione chiude subito le sessioni aperte su questa azienda
        await trx.deleteFrom('sessions').where('user_id', '=', m.user_id).where('active_company_id', '=', ctx.companyId).execute()
      }
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'membership', entityId: id, action: 'updated', details: body })
      return { ok: true }
    })
  })
}
