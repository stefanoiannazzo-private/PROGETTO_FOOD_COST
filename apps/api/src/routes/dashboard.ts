import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { can, requireCompany } from '../http/context'
import { today } from '../http/schemas'
import { currentValuations } from '../services/costing'

export async function dashboardRoutes(app: FastifyInstance) {
  const db = app.database.db

  app.get('/dashboard', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const t = today()
    const c = ctx.companyId
    const count = (table: 'ingredients' | 'equipment' | 'employees', extra = sql`true`) =>
      sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE company_id = ${c} AND archived_at IS NULL AND ${extra}`.execute(db).then((r) => Number(r.rows[0]?.n ?? 0))

    const [ingredients, equipment, employees, recipeCounts] = await Promise.all([
      count('ingredients'),
      count('equipment'),
      can(ctx, 'employees.read') ? count('employees') : Promise.resolve(null),
      db.selectFrom('recipes').select(['status', ({ fn }) => fn.countAll<string>().as('n')]).where('company_id', '=', c).groupBy('status').execute(),
    ])
    const recipes = Object.fromEntries(recipeCounts.map((r) => [r.status, Number(r.n)]))

    let costs = null
    if (can(ctx, 'costs.read')) {
      const ids = await db.selectFrom('recipes').select('id').where('company_id', '=', c).where('status', '<>', 'archived').where('current_revision_id', 'is not', null).execute()
      const vals = await currentValuations(db, c, ids.map((r) => r.id), t)
      const titles = await db.selectFrom('recipes').select(['id', 'code', 'title', 'status']).where('company_id', '=', c).where('status', '<>', 'archived').execute()
      const incomplete = titles
        .map((r) => ({ ...r, v: vals.get(r.id) }))
        .filter((r) => r.v && !r.v.complete)
        .map((r) => ({
          id: r.id,
          code: r.code,
          title: r.title,
          status: r.status,
          total: r.v!.total,
          issues: r.v!.issues.filter((i) => i.severity === 'error').slice(0, 3).map((i) => ({ code: i.code, message: i.message, path: i.path })),
          errorCount: r.v!.issues.filter((i) => i.severity === 'error').length,
        }))
        .sort((a, b) => b.errorCount - a.errorCount)
      const missingPrices = await sql<{ n: string }>`
        SELECT count(*) AS n FROM ingredients i
        WHERE i.company_id = ${c} AND i.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM ingredient_prices p WHERE p.ingredient_id = i.id AND p.valid_from <= ${t})`.execute(db)
      const recentPrices = await db
        .selectFrom('ingredient_prices as p')
        .innerJoin('ingredients as i', 'i.id', 'p.ingredient_id')
        .select(['i.id', 'i.name', 'p.package_price', 'p.valid_from', 'p.created_at'])
        .where('p.company_id', '=', c)
        .orderBy('p.created_at', 'desc')
        .limit(5)
        .execute()
      costs = { incompleteCount: incomplete.length, incomplete: incomplete.slice(0, 10), missingPrices: Number(missingPrices.rows[0]?.n ?? 0), recentPrices }
    }
    const recentRecipes = await db.selectFrom('recipes').select(['id', 'code', 'title', 'status', 'updated_at']).where('company_id', '=', c).where('status', '<>', 'archived').orderBy('updated_at', 'desc').limit(6).execute()
    return { date: t, counts: { ingredients, equipment, employees, recipes }, costs, recentRecipes }
  })
}
