import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app'
import { connect, type Database } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { hashPassword } from '../src/auth/crypto'

export const PASSWORD = 'Password-di-prova-1'

export interface TestEnv {
  app: FastifyInstance
  database: Database
  storageDir: string
}

export async function setup(overrides: Partial<import('../src/env').AppConfig> = {}): Promise<TestEnv> {
  const database = await connect('pglite:memory')
  await migrate(database)
  const storageDir = await mkdtemp(join(tmpdir(), 'foodcost-test-'))
  const app = await buildApp(database, { storageDir, devExposeTokens: true, importMaxRows: 20000, loginRateLimit: 1000, ...overrides })
  await app.ready()
  return { app, database, storageDir }
}

export async function teardown(env: TestEnv) {
  await env.app.close()
  await env.database.close()
}

/** Crea direttamente un utente (solo per i test e per il seed locale). */
export async function createUser(env: TestEnv, email: string, name: string, opts: { platformAdmin?: boolean } = {}) {
  const u = await env.database.db
    .insertInto('users')
    .values({ email, name, password_hash: await hashPassword(PASSWORD), is_platform_admin: opts.platformAdmin ?? false })
    .returning('id')
    .executeTakeFirstOrThrow()
  return u.id
}

export async function createCompany(env: TestEnv, name: string) {
  return (await env.database.db.insertInto('companies').values({ name }).returning('id').executeTakeFirstOrThrow()).id
}

export async function addMember(env: TestEnv, companyId: string, userId: string, role: 'admin' | 'manager' | 'operator', extra: string[] = []) {
  await env.database.db.insertInto('memberships').values({ company_id: companyId, user_id: userId, role, extra_permissions: extra }).execute()
}

export interface Res<T = any> {
  status: number
  body: T
}

export class Client {
  cookie = ''
  constructor(private app: FastifyInstance) {}

  async request<T = any>(method: string, url: string, payload?: unknown, opts: { csrf?: boolean; origin?: string } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = {}
    if (this.cookie) headers.cookie = this.cookie
    if (opts.csrf !== false) headers['x-requested-with'] = 'foodcost'
    if (opts.origin) headers.origin = opts.origin
    const res = await this.app.inject({ method: method as 'GET', url, payload: payload as Record<string, unknown> | undefined, headers })
    const setCookie = res.headers['set-cookie']
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie
    if (first?.startsWith('fc_session=')) this.cookie = first.split(';')[0]!
    let body: unknown = res.body
    try {
      body = res.json()
    } catch {
      /* risposta non JSON */
    }
    return { status: res.statusCode, body: body as T }
  }
  get<T = any>(url: string) {
    return this.request<T>('GET', url)
  }
  post<T = any>(url: string, body: unknown = {}) {
    return this.request<T>('POST', url, body)
  }
  put<T = any>(url: string, body: unknown) {
    return this.request<T>('PUT', url, body)
  }
  patch<T = any>(url: string, body: unknown) {
    return this.request<T>('PATCH', url, body)
  }
  del<T = any>(url: string) {
    return this.request<T>('DELETE', url)
  }
}

export async function loginAs(env: TestEnv, email: string): Promise<Client> {
  const c = new Client(env.app)
  const res = await c.post('/api/auth/login', { email, password: PASSWORD })
  if (res.status !== 200) throw new Error(`login fallito per ${email}: ${JSON.stringify(res.body)}`)
  return c
}

export function expectOk<T>(res: Res<T>, status = 200): T {
  if (res.status !== status) throw new Error(`atteso ${status}, ricevuto ${res.status}: ${JSON.stringify(res.body)}`)
  return res.body
}
