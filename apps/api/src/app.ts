import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import { ZodError } from 'zod'
import type { Database } from './db/connection'
import { config, type AppConfig } from './env'
import { AppError, validationError } from './http/errors'
import { loadSession, SESSION_COOKIE } from './services/sessions'
import { authRoutes } from './routes/auth'
import { userRoutes } from './routes/users'
import { companyRoutes } from './routes/companies'
import { ingredientRoutes } from './routes/ingredients'
import { tariffRoutes } from './routes/tariffs'
import { equipmentRoutes } from './routes/equipment'
import { employeeRoutes } from './routes/employees'
import { recipeRoutes } from './routes/recipes'
import { importRoutes } from './routes/imports'
import { dashboardRoutes } from './routes/dashboard'

declare module 'fastify' {
  interface FastifyInstance {
    database: Database
    cfg: AppConfig
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export async function buildApp(database: Database, overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const cfg = { ...config(), ...overrides }
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === 'true',
  })
  app.decorate('database', database)
  app.decorate('cfg', cfg)
  app.decorateRequest('auth', null)

  await app.register(cookie)
  await app.register(rateLimit, { global: false })
  await app.register(multipart, { limits: { fileSize: cfg.importMaxBytes, files: 1 } })

  // Protezione CSRF: le richieste che modificano dati devono arrivare dall'app (header dedicato + origine ammessa).
  // Il cookie di sessione è SameSite=Lax e httpOnly.
  app.addHook('onRequest', async (req) => {
    if (!SAFE_METHODS.has(req.method)) {
      if (req.headers['x-requested-with'] !== 'foodcost') throw new AppError(403, 'csrf', 'Richiesta non valida (protezione CSRF).')
      const origin = req.headers.origin
      if (origin && !cfg.allowedOrigins.includes(origin)) throw new AppError(403, 'csrf', 'Origine della richiesta non ammessa.')
    }
    const token = req.cookies[SESSION_COOKIE]
    req.auth = token ? await loadSession(database.db, token) : null
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) err = validationError(err)
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details ?? null } })
    }
    const e = err as { statusCode?: number; code?: string; message: string }
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'Troppi tentativi: riprova tra poco.' } })
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'file_too_large', message: `File troppo grande (massimo ${Math.round(cfg.importMaxBytes / 1024 / 1024)} MB).` } })
    }
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } })
    req.log.error(err)
    return reply.status(500).send({ error: { code: 'server_error', message: 'Errore interno: riprova o contatta l’assistenza.' } })
  })

  app.get('/api/health', async () => ({ ok: true }))

  await app.register(
    async (api) => {
      await authRoutes(api)
      await userRoutes(api)
      await companyRoutes(api)
      await ingredientRoutes(api)
      await tariffRoutes(api)
      await equipmentRoutes(api)
      await employeeRoutes(api)
      await recipeRoutes(api)
      await importRoutes(api)
      await dashboardRoutes(api)
    },
    { prefix: '/api' },
  )
  return app
}
