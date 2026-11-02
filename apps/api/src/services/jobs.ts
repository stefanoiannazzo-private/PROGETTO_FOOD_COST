import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import type { DB } from '../db/types'
import type { AppConfig } from '../env'
import { applyImport, ApplyError } from './imports/apply'
import { ImportError, validateImport } from './imports/validate'

/** Coda di lavoro su database: niente servizi esterni. Un lavoro con la stessa chiave non viene accodato due volte. */
export async function enqueue(db: Kysely<DB>, type: string, payload: Record<string, unknown>, dedupeKey?: string): Promise<boolean> {
  const r = await db
    .insertInto('jobs')
    .values({ type, payload: JSON.stringify(payload), dedupe_key: dedupeKey ?? null })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .returning('id')
    .executeTakeFirst()
  return !!r
}

/** Prende in carico un lavoro (SKIP LOCKED: più worker non si contendono la stessa riga). */
async function claim(db: Kysely<DB>) {
  const r = await sql<{ id: string; type: string; payload: Record<string, unknown>; attempts: number }>`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE (status = 'queued' AND run_at <= now())
         OR (status = 'running' AND locked_at < now() - interval '10 minutes')
      ORDER BY run_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, type, payload, attempts`.execute(db)
  return r.rows[0] ?? null
}

export async function runOnce(db: Kysely<DB>, cfg: AppConfig): Promise<boolean> {
  const job = await claim(db)
  if (!job) return false
  try {
    await handle(db, cfg, job.type, job.payload)
    await db.updateTable('jobs').set({ status: 'done', error: null }).where('id', '=', job.id).execute()
  } catch (e) {
    const msg = (e as Error).message
    const retry = !(e instanceof ImportError || e instanceof ApplyError) && job.attempts < 3
    await db
      .updateTable('jobs')
      .set({ status: retry ? 'queued' : 'failed', error: msg, run_at: new Date(Date.now() + 5000 * job.attempts) })
      .where('id', '=', job.id)
      .execute()
  }
  return true
}

async function handle(db: Kysely<DB>, cfg: AppConfig, type: string, payload: Record<string, unknown>) {
  const importId = payload.importId as string
  if (type === 'import.validate') {
    await db.updateTable('imports').set({ status: 'validating', progress: 0, error: null, summary: null }).where('id', '=', importId).execute()
    try {
      const summary = await validateImport(db, cfg.storageDir, importId, cfg.importMaxRows, async (n) => {
        await db.updateTable('imports').set({ progress: n }).where('id', '=', importId).execute()
      })
      await db
        .updateTable('imports')
        .set({ status: 'validated', summary: JSON.stringify(summary), total_rows: summary.totalRows, progress: summary.totalRows, validated_at: new Date(), lock_version: sql`lock_version + 1` })
        .where('id', '=', importId)
        .execute()
    } catch (e) {
      const known = e instanceof ImportError
      await db
        .updateTable('imports')
        .set({ status: 'failed', error: known ? (e as Error).message : 'Il file non può essere letto: verifica formato, foglio e separatore.' })
        .where('id', '=', importId)
        .execute()
      if (!known) throw e
    }
  } else if (type === 'import.apply') {
    try {
      await applyImport(db, importId)
    } catch (e) {
      if (e instanceof ApplyError) {
        await db.updateTable('imports').set({ status: 'failed', error: e.message }).where('id', '=', importId).where('status', '=', 'applying').execute()
      }
      throw e
    }
  } else if (type === 'imports.cleanup') {
    await cleanupImports(db, cfg)
  }
}

/** Conservazione: i file e le righe di staging sono eliminati dopo IMPORT_RETENTION_DAYS; resta il riepilogo. */
export async function cleanupImports(db: Kysely<DB>, cfg: AppConfig) {
  const limit = new Date(Date.now() - cfg.importRetentionDays * 86400_000)
  const old = await db.selectFrom('imports').select(['id', 'storage_path']).where('created_at', '<', limit).where('storage_path', '<>', '').execute()
  for (const o of old) {
    await rm(join(cfg.storageDir, o.storage_path), { force: true })
    await db.deleteFrom('import_rows').where('import_id', '=', o.id).execute()
    await db.updateTable('imports').set({ storage_path: '' }).where('id', '=', o.id).execute()
  }
  return old.length
}

/** Ciclo del worker: esegue i lavori disponibili, poi attende. */
export function startWorker(db: Kysely<DB>, cfg: AppConfig, log: (m: string) => void = () => {}) {
  let stopped = false
  let lastCleanup = 0
  const loop = async () => {
    while (!stopped) {
      try {
        if (Date.now() - lastCleanup > 6 * 3600_000) {
          lastCleanup = Date.now()
          await enqueue(db, 'imports.cleanup', {}, `cleanup:${new Date().toISOString().slice(0, 13)}`)
        }
        const did = await runOnce(db, cfg)
        if (!did) await new Promise((r) => setTimeout(r, 400))
      } catch (e) {
        log(`worker: ${(e as Error).message}`)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }
  void loop()
  return () => {
    stopped = true
  }
}
