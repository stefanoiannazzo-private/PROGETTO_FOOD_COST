import type { Kysely } from 'kysely'
import type { DB } from '../db/types'

/** Campi che non devono mai finire nei log di audit. */
const SENSITIVE = new Set(['gross_monthly', 'contributions_value', 'other_monthly_costs', 'password_hash', 'password', 'token', 'token_hash'])

export async function audit(
  db: Kysely<DB>,
  entry: { companyId: string | null; userId: string | null; entityType: string; entityId?: string | null; action: string; details?: Record<string, unknown> },
): Promise<void> {
  const details = entry.details ? scrub(entry.details) : null
  await db
    .insertInto('audit_logs')
    .values({
      company_id: entry.companyId,
      user_id: entry.userId,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      action: entry.action,
      details: details ? JSON.stringify(details) : null,
    })
    .execute()
}

function scrub(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.has(k)) out[k] = '[riservato]'
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = scrub(v as Record<string, unknown>)
    else out[k] = v
  }
  return out
}

/** Elenco dei campi cambiati tra due oggetti (solo nomi e valori non sensibili). */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of Object.keys(after)) {
    const a = before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k]
    const b = after[k] instanceof Date ? (after[k] as Date).toISOString() : after[k]
    if (String(a ?? '') !== String(b ?? '')) changes[k] = { from: a ?? null, to: b ?? null }
  }
  return changes
}
