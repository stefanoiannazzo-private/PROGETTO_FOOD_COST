import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'kysely'
import type { Database } from './connection'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/** Applica in ordine le migrazioni SQL non ancora eseguite, ciascuna in una transazione. */
export async function migrate(database: Database, log: (msg: string) => void = () => {}): Promise<string[]> {
  await database.execRaw(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
  const done = await sql<{ name: string }>`SELECT name FROM schema_migrations`.execute(database.db)
  const applied = new Set(done.rows.map((r) => r.name))
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
  const ran: string[] = []
  for (const file of files) {
    if (applied.has(file)) continue
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    const name = file.replace(/'/g, "''")
    await database.execRaw(`BEGIN;\n${body}\nINSERT INTO schema_migrations (name) VALUES ('${name}');\nCOMMIT;`)
    log(`migrazione applicata: ${file}`)
    ran.push(file)
  }
  return ran
}
