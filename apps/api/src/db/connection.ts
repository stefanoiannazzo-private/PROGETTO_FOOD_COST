import { Kysely, PGliteDialect, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { DB } from './types'

/**
 * Connessione al database.
 * - DATABASE_URL=postgres://...       PostgreSQL server (produzione e sviluppo con Docker)
 * - DATABASE_URL=pglite:./.data/dev    PostgreSQL in-process su file (sviluppo senza server)
 * - DATABASE_URL=pglite:memory         PostgreSQL in-process in memoria (test)
 */
export interface Database {
  db: Kysely<DB>
  /** Esegue SQL con più istruzioni (migrazioni). */
  execRaw(sql: string): Promise<void>
  kind: 'postgres' | 'pglite'
  close(): Promise<void>
}

const DATE_OID = 1082

export async function connect(url = process.env.DATABASE_URL ?? 'pglite:./.data/dev'): Promise<Database> {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite')
    const target = url.slice('pglite:'.length)
    if (target !== 'memory') {
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      mkdirSync(dirname(target), { recursive: true })
    }
    const pglite = await PGlite.create(target === 'memory' ? undefined : target, {
      parsers: { [DATE_OID]: (v: string) => v },
    })
    const db = new Kysely<DB>({ dialect: new PGliteDialect({ pglite }) })
    return {
      db,
      kind: 'pglite',
      execRaw: async (sql) => {
        await pglite.exec(sql)
      },
      close: () => db.destroy(),
    }
  }

  pg.types.setTypeParser(DATE_OID, (v) => v)
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) })
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
  return {
    db,
    kind: 'postgres',
    execRaw: async (sql) => {
      const client = await pool.connect()
      try {
        await client.query(sql)
      } finally {
        client.release()
      }
    },
    close: () => db.destroy(),
  }
}
