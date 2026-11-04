import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Carica apps/api/.env se presente (senza sovrascrivere le variabili già impostate). */
export function loadEnv(path = join(process.cwd(), '.env')): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    const key = m[1]!
    let value = m[2]!
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export interface AppConfig {
  port: number
  host: string
  cookieSecure: boolean
  sessionDays: number
  storageDir: string
  importMaxBytes: number
  importMaxRows: number
  importRetentionDays: number
  allowedOrigins: string[]
  appUrl: string
  /** solo sviluppo: espone il link di reset password nella risposta invece di inviare email */
  devExposeTokens: boolean
  /** tentativi di login per IP al minuto */
  loginRateLimit: number
}

export function config(): AppConfig {
  const env = process.env
  return {
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? '127.0.0.1',
    cookieSecure: env.COOKIE_SECURE === 'true',
    sessionDays: Number(env.SESSION_DAYS ?? 14),
    storageDir: env.STORAGE_DIR ?? join(process.cwd(), 'storage'),
    importMaxBytes: Number(env.IMPORT_MAX_BYTES ?? 10 * 1024 * 1024),
    importMaxRows: Number(env.IMPORT_MAX_ROWS ?? 20000),
    importRetentionDays: Number(env.IMPORT_RETENTION_DAYS ?? 30),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000').split(',').map((s) => s.trim()).filter(Boolean),
    appUrl: env.APP_URL ?? 'http://localhost:3000',
    // mai in produzione, qualunque cosa dica la configurazione
    devExposeTokens: env.NODE_ENV !== 'production' && env.DEV_EXPOSE_TOKENS === 'true',
    loginRateLimit: Number(env.LOGIN_RATE_LIMIT ?? 10),
  }
}

/** Controlli bloccanti all'avvio in produzione: meglio non partire che partire insicuri. */
export function assertProductionConfig(c: AppConfig, databaseUrl: string | undefined): string[] {
  if (process.env.NODE_ENV !== 'production') return []
  const errors: string[] = []
  if (!databaseUrl || databaseUrl.startsWith('pglite:')) errors.push('DATABASE_URL deve puntare a un server PostgreSQL (postgres://…).')
  if (!c.cookieSecure) errors.push('COOKIE_SECURE deve essere true (il sito è servito in HTTPS).')
  if (!c.appUrl.startsWith('https://')) errors.push('APP_URL deve essere l’indirizzo pubblico in https://.')
  if (c.allowedOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o)) || !c.allowedOrigins.includes(c.appUrl)) errors.push('ALLOWED_ORIGINS deve contenere solo il dominio pubblico (uguale ad APP_URL).')
  return errors
}
