import { sql, type Kysely } from 'kysely'
import { d } from '@foodcost/domain'
import type { DB } from '../../db/types'
import { effectivePermissions, type Role } from '../../auth/permissions'
import { audit } from '../audit'
import { invalidate } from '../costing'
import { nextCode } from '../codes'

export class ApplyError extends Error {}

const CHUNK = 500

/**
 * Applicazione atomica di un'importazione validata: o tutte le righe o nessuna.
 * Prima di scrivere ricontrolla permessi e azienda dell'autore e i conflitti con modifiche
 * avvenute dopo l'anteprima. È idempotente: una seconda esecuzione dello stesso lavoro non duplica nulla.
 */
export async function applyImport(db: Kysely<DB>, importId: string): Promise<{ applied: boolean; reason?: string }> {
  const result = await db.transaction().execute(async (trx) => {
    const imp = await trx.selectFrom('imports').selectAll().where('id', '=', importId).forUpdate().executeTakeFirstOrThrow()
    if (imp.status === 'applied') return { applied: false, reason: 'già applicata', ids: [] as string[], companyId: imp.company_id, type: imp.type }
    if (imp.status !== 'applying') throw new ApplyError(`Stato non valido per l’applicazione: ${imp.status}.`)

    // ricontrollo autorizzazioni e azienda al momento della scrittura
    const m = await trx
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.role', 'm.extra_permissions'])
      .where('m.user_id', '=', imp.created_by!)
      .where('m.company_id', '=', imp.company_id)
      .where('m.is_active', '=', true)
      .where('u.is_active', '=', true)
      .executeTakeFirst()
    const perms = m ? effectivePermissions(m.role as Role, m.extra_permissions) : new Set()
    const needed = imp.type === 'ingredients' ? ['imports.manage', 'ingredients.manage'] : ['imports.manage', 'employees.manage', 'salaries.read']
    if (!m || needed.some((p) => !perms.has(p as never))) throw new ApplyError('L’autore dell’importazione non ha più i permessi necessari.')

    const errors = await trx.selectFrom('import_rows').select(({ fn }) => fn.countAll<string>().as('n')).where('import_id', '=', importId).where('action', '=', 'error').executeTakeFirstOrThrow()
    if (Number(errors.n) > 0) throw new ApplyError('L’importazione contiene righe con errori: nessuna riga è stata applicata.')

    const validatedAt = imp.validated_at!
    const touched: string[] = []
    let offset = 0
    for (;;) {
      const rows = await trx
        .selectFrom('import_rows')
        .select(['row_number', 'normalized', 'action', 'target_id'])
        .where('import_id', '=', importId)
        .where('action', 'in', ['create', 'update'])
        .orderBy('row_number')
        .limit(CHUNK)
        .offset(offset)
        .execute()
      if (!rows.length) break
      offset += rows.length
      if (imp.type === 'ingredients') touched.push(...(await applyIngredients(trx, imp.company_id, imp.created_by!, importId, validatedAt, rows)))
      else touched.push(...(await applyEmployees(trx, imp.company_id, imp.created_by!, importId, validatedAt, rows)))
    }
    await trx.updateTable('imports').set({ status: 'applied', applied_at: new Date(), progress: offset }).where('id', '=', importId).execute()
    await audit(trx, { companyId: imp.company_id, userId: imp.created_by, entityType: 'import', entityId: importId, action: 'applied', details: { type: imp.type, rows: offset } })
    return { applied: true, ids: touched, companyId: imp.company_id, type: imp.type }
  })
  if (result.applied && result.ids.length) {
    await invalidate(db, result.companyId, { type: result.type === 'ingredients' ? 'ingredients' : 'employees', ids: result.ids })
  }
  return { applied: result.applied, reason: result.reason }
}

type RowIn = { row_number: number; normalized: unknown; action: string | null; target_id: string | null }

async function applyIngredients(trx: Kysely<DB>, companyId: string, userId: string, importId: string, validatedAt: Date, rows: RowIn[]) {
  const ids: string[] = []
  for (const r of rows) {
    const n = r.normalized as Record<string, string | null | boolean>
    let id = r.target_id
    if (r.action === 'update') {
      const cur = await trx.selectFrom('ingredients').select(['id', 'updated_at', 'package_unit', 'package_content']).where('id', '=', id!).where('company_id', '=', companyId).forUpdate().executeTakeFirst()
      if (!cur) throw new ApplyError(`Riga ${r.row_number}: l’ingrediente non esiste più.`)
      if (cur.updated_at > validatedAt) throw new ApplyError(`Riga ${r.row_number}: l’ingrediente ${n.code} è stato modificato dopo l’anteprima. Rivalida l’importazione.`)
      const set: Record<string, unknown> = {}
      if (n.name) set.name = n.name
      if (n.category) set.category = n.category
      if (n.supplier) set.supplier = n.supplier
      if (n.packageContent) set.package_content = n.packageContent
      if (n.packageUnit) set.package_unit = n.packageUnit
      if (n.edibleYieldPercent) set.edible_yield = d(n.edibleYieldPercent as string).div(100).toFixed()
      if (n.densityKgPerL) set.density_kg_per_l = n.densityKgPerL
      if (n.unitWeightKg) set.unit_weight_kg = n.unitWeightKg
      if (Object.keys(set).length) await trx.updateTable('ingredients').set({ ...set, updated_at: new Date(), lock_version: sql`lock_version + 1` }).where('id', '=', id!).execute()
    } else {
      const code = (n.code as string | null) ?? (await nextCode(trx, 'ingredients', companyId, 'ING'))
      const clash = await trx.selectFrom('ingredients').select('id').where('company_id', '=', companyId).where(sql`lower(code)`, '=', code.toLowerCase()).executeTakeFirst()
      if (clash) throw new ApplyError(`Riga ${r.row_number}: il codice ${code} è stato creato da qualcun altro dopo l’anteprima. Rivalida l’importazione.`)
      const created = await trx
        .insertInto('ingredients')
        .values({
          company_id: companyId,
          code,
          name: n.name as string,
          category: (n.category as string) ?? null,
          supplier: (n.supplier as string) ?? null,
          package_content: n.packageContent as string,
          package_unit: n.packageUnit as string,
          usage_unit: (n.usageUnit as string) ?? (n.packageUnit as string),
          edible_yield: n.edibleYieldPercent ? d(n.edibleYieldPercent as string).div(100).toFixed() : '1',
          density_kg_per_l: (n.densityKgPerL as string) ?? null,
          unit_weight_kg: (n.unitWeightKg as string) ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      id = created.id
    }
    if (n.packagePrice !== null && n.packagePrice !== undefined && n.priceDate && !n.priceDuplicate) {
      const ing = await trx.selectFrom('ingredients').select(['package_content', 'package_unit']).where('id', '=', id!).executeTakeFirstOrThrow()
      const existing = await trx.selectFrom('ingredient_prices').select(['id', 'package_price']).where('ingredient_id', '=', id!).where('valid_from', '=', n.priceDate as string).executeTakeFirst()
      if (existing) {
        if (!d(existing.package_price).eq(n.packagePrice as string)) throw new ApplyError(`Riga ${r.row_number}: un prezzo diverso con la stessa data è stato inserito dopo l’anteprima.`)
      } else {
        await trx
          .insertInto('ingredient_prices')
          .values({
            company_id: companyId,
            ingredient_id: id!,
            package_price: n.packagePrice as string,
            package_content: (n.packageContent as string) ?? ing.package_content,
            package_unit: (n.packageUnit as string) ?? ing.package_unit,
            valid_from: n.priceDate as string,
            source: (n.priceSource as string) ?? 'Importazione',
            import_id: importId,
            created_by: userId,
          })
          .execute()
      }
    }
    ids.push(id!)
  }
  return ids
}

async function applyEmployees(trx: Kysely<DB>, companyId: string, userId: string, importId: string, validatedAt: Date, rows: RowIn[]) {
  const ids: string[] = []
  for (const r of rows) {
    const n = r.normalized as Record<string, string | null | boolean>
    let id = r.target_id
    if (r.action === 'update') {
      const cur = await trx.selectFrom('employees').select(['id', 'updated_at']).where('id', '=', id!).where('company_id', '=', companyId).forUpdate().executeTakeFirst()
      if (!cur) throw new ApplyError(`Riga ${r.row_number}: il dipendente non esiste più.`)
      if (cur.updated_at > validatedAt) throw new ApplyError(`Riga ${r.row_number}: il dipendente ${n.code} è stato modificato dopo l’anteprima. Rivalida l’importazione.`)
      const set: Record<string, unknown> = {}
      if (n.firstName) set.first_name = n.firstName
      if (n.lastName) set.last_name = n.lastName
      if (n.jobTitle) set.job_title = n.jobTitle
      if (n.status) set.status = n.status
      if (Object.keys(set).length) await trx.updateTable('employees').set({ ...set, updated_at: new Date() }).where('id', '=', id!).execute()
    } else {
      const code = (n.code as string | null) ?? (await nextCode(trx, 'employees', companyId, 'DIP'))
      const clash = await trx.selectFrom('employees').select('id').where('company_id', '=', companyId).where(sql`lower(code)`, '=', code.toLowerCase()).executeTakeFirst()
      if (clash) throw new ApplyError(`Riga ${r.row_number}: il codice ${code} è stato creato da qualcun altro dopo l’anteprima. Rivalida l’importazione.`)
      id = (
        await trx
          .insertInto('employees')
          .values({ company_id: companyId, code, first_name: n.firstName as string, last_name: n.lastName as string, job_title: (n.jobTitle as string) ?? null, status: (n.status as 'active' | 'inactive') ?? 'active' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    }
    if (!n.configDuplicate) {
      const dup = await trx.selectFrom('employee_cost_configs').select('id').where('employee_id', '=', id!).where('valid_from', '=', n.validFrom as string).executeTakeFirst()
      if (dup) throw new ApplyError(`Riga ${r.row_number}: una configurazione con la stessa decorrenza è stata inserita dopo l’anteprima.`)
      await trx
        .insertInto('employee_cost_configs')
        .values({
          company_id: companyId,
          employee_id: id!,
          valid_from: n.validFrom as string,
          gross_monthly: n.grossMonthly as string,
          contributions_mode: n.contributionsMode as 'none' | 'amount' | 'percent',
          contributions_value: n.contributionsMode === 'none' ? null : (n.contributionsValue as string),
          other_monthly_costs: (n.otherMonthlyCosts as string) ?? '0',
          productive_hours: n.productiveHours as string,
          import_id: importId,
          created_by: userId,
        })
        .execute()
    }
    ids.push(id!)
  }
  return ids
}
