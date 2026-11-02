import type { FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { Permission, Role } from '../auth/permissions'
import { AppError, forbidden, unauthorized, validationError } from './errors'

export interface AuthContext {
  sessionHash: string
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean }
  company: { id: string; name: string } | null
  role: Role | null
  permissions: Set<Permission>
}

export interface TenantContext extends AuthContext {
  company: { id: string; name: string }
  companyId: string
  role: Role
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized()
  return req.auth
}

/**
 * Contesto aziendale: deriva SEMPRE dalla sessione autenticata e dalla membership verificata,
 * mai da un identificativo passato dal browser.
 */
export function requireCompany(req: FastifyRequest, ...perms: Permission[]): TenantContext {
  const auth = requireAuth(req)
  if (!auth.company || !auth.role) throw new AppError(409, 'no_active_company', 'Seleziona un’azienda per continuare.')
  for (const p of perms) if (!auth.permissions.has(p)) throw forbidden()
  return { ...auth, company: auth.company, companyId: auth.company.id, role: auth.role }
}

export function can(ctx: AuthContext, perm: Permission): boolean {
  return ctx.permissions.has(perm)
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {})
  if (!r.success) throw validationError(r.error)
  return r.data
}
