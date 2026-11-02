import { sql, type Kysely } from 'kysely'
import type { DB } from '../db/types'

type CodedTable = 'ingredients' | 'equipment' | 'employees' | 'recipes'

/**
 * Genera il prossimo codice libero con prefisso (es. ING-00042) per una nuova riga senza codice.
 * Non viene mai usato per abbinare righe esistenti.
 */
export async function nextCode(db: Kysely<DB>, table: CodedTable, companyId: string, prefix: string): Promise<string> {
  const row = await sql<{ n: number | null }>`
    SELECT max(substring(code from ${`^${prefix}-(\\d+)$`})::int) AS n
    FROM ${sql.table(table)}
    WHERE company_id = ${companyId} AND code ~ ${`^${prefix}-\\d+$`}`.execute(db)
  const n = (row.rows[0]?.n ?? 0) + 1
  return `${prefix}-${String(n).padStart(5, '0')}`
}
