import type { Kysely } from 'kysely'
import type { DB } from '../db/types'
import { hashToken, newToken } from '../auth/crypto'
import { effectivePermissions, type Role } from '../auth/permissions'
import type { AuthContext } from '../http/context'

export const SESSION_COOKIE = 'fc_session'
const TOUCH_INTERVAL_MS = 5 * 60 * 1000

export async function createSession(db: Kysely<DB>, userId: string, days: number, activeCompanyId: string | null): Promise<string> {
  const token = newToken()
  await db
    .insertInto('sessions')
    .values({ token_hash: hashToken(token), user_id: userId, active_company_id: activeCompanyId, expires_at: new Date(Date.now() + days * 86400_000) })
    .execute()
  return token
}

/** Ricostruisce il contesto autenticato: utente attivo, sessione valida, membership attiva per l'azienda selezionata. */
export async function loadSession(db: Kysely<DB>, token: string): Promise<AuthContext | null> {
  const hash = hashToken(token)
  const row = await db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .leftJoin('memberships as m', (j) => j.onRef('m.user_id', '=', 's.user_id').onRef('m.company_id', '=', 's.active_company_id').on('m.is_active', '=', true))
    .leftJoin('companies as c', (j) => j.onRef('c.id', '=', 'm.company_id').on('c.archived_at', 'is', null))
    .select([
      's.token_hash',
      's.expires_at',
      's.last_seen_at',
      'u.id as user_id',
      'u.email',
      'u.name',
      'u.is_active',
      'u.is_platform_admin',
      'm.role',
      'm.extra_permissions',
      'c.id as company_id',
      'c.name as company_name',
    ])
    .where('s.token_hash', '=', hash)
    .executeTakeFirst()
  if (!row || !row.is_active || row.expires_at.getTime() < Date.now()) return null

  if (Date.now() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await db.updateTable('sessions').set({ last_seen_at: new Date() }).where('token_hash', '=', hash).execute()
  }

  const hasCompany = !!(row.company_id && row.role)
  return {
    sessionHash: hash,
    user: { id: row.user_id, email: row.email, name: row.name, isPlatformAdmin: row.is_platform_admin },
    company: hasCompany ? { id: row.company_id!, name: row.company_name! } : null,
    role: hasCompany ? (row.role as Role) : null,
    permissions: hasCompany ? effectivePermissions(row.role as Role, row.extra_permissions ?? []) : new Set(),
  }
}

export async function destroySession(db: Kysely<DB>, hash: string): Promise<void> {
  await db.deleteFrom('sessions').where('token_hash', '=', hash).execute()
}
