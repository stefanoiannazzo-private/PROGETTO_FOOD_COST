import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { z } from 'zod'
import { dependentsOf, serialize } from '@foodcost/domain'
import { can, parse, requireCompany } from '../http/context'
import { conflict, notFound } from '../http/errors'
import { isoDate, likePattern, listQuery, today } from '../http/schemas'
import { audit } from '../services/audit'
import { computeValuation, currentValuations, describeRecipes, invalidate, loadEdges, type SerializedCost } from '../services/costing'
import { nextCode } from '../services/codes'
import { compare, redactCost } from '../services/presentation'
import { draftToInput, formToBody, insertRevision, loadRevisionForm, recipeHeader, revisionBody, validateRevision } from '../services/recipes'

const idParam = z.object({ id: z.uuid() })

export async function recipeRoutes(app: FastifyInstance) {
  const db = app.database.db

  /* ------------------------------ elenco ------------------------------ */
  app.get('/recipes', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const q = parse(
      listQuery.extend({
        status: z.enum(['draft', 'active', 'archived', 'all']).default('all'),
        completeness: z.enum(['all', 'complete', 'incomplete']).default('all'),
      }),
      req.query,
    )
    const showCosts = can(ctx, 'costs.read')
    const t = today()
    if (showCosts && q.completeness !== 'all') {
      // il filtro per completezza richiede la valorizzazione di tutte le ricette (una sola elaborazione, poi in cache)
      const all = await db.selectFrom('recipes').select('id').where('company_id', '=', ctx.companyId).where('current_revision_id', 'is not', null).execute()
      await currentValuations(db, ctx.companyId, all.map((r) => r.id), t)
    }
    let query = db
      .selectFrom('recipes as r')
      .leftJoin('recipe_revisions as v', 'v.id', 'r.current_revision_id')
      .leftJoin('recipe_cost_cache as k', (j) => j.onRef('k.recipe_id', '=', 'r.id').on('k.valuation_date', '=', t))
      .where('r.company_id', '=', ctx.companyId)
    if (q.status === 'all') query = query.where('r.status', '<>', 'archived')
    else query = query.where('r.status', '=', q.status)
    if (q.category) query = query.where('r.category', '=', q.category)
    if (q.q) {
      const pat = likePattern(q.q)
      query = query.where((eb) => eb.or([eb(eb.fn('lower', ['r.title']), 'like', pat), eb(eb.fn('lower', ['r.code']), 'like', pat)]))
    }
    if (showCosts && q.completeness === 'complete') query = query.where('k.complete', '=', true)
    if (showCosts && q.completeness === 'incomplete') query = query.where('k.complete', '=', false)
    const sorts = { title: 'r.title', code: 'r.code', category: 'r.category', updated: 'r.updated_at', total: 'k.total', perKg: 'k.cost_per_kg' } as const
    const sortKey = (q.sort ?? 'title') as keyof typeof sorts
    const sortCol = !showCosts && (sortKey === 'total' || sortKey === 'perKg') ? 'r.title' : (sorts[sortKey] ?? 'r.title')
    const rows = await query
      .select([
        'r.id',
        'r.code',
        'r.title',
        'r.category',
        'r.status',
        'r.updated_at',
        'v.number as revision_number',
        'v.final_weight_kg',
        'v.portions',
        'v.final_quantity',
        'v.final_unit',
        sql<string>`count(*) over()`.as('total_count'),
      ])
      .orderBy(sql`${sql.ref(sortCol)} ${sql.raw(q.dir === 'desc' ? 'desc' : 'asc')} nulls last`)
      .orderBy('r.id')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .execute()
    const valuations = showCosts ? await currentValuations(db, ctx.companyId, rows.map((r) => r.id), t) : new Map<string, SerializedCost>()
    return {
      data: rows.map((r) => {
        const v = valuations.get(r.id)
        return {
          id: r.id,
          code: r.code,
          title: r.title,
          category: r.category,
          status: r.status,
          updatedAt: r.updated_at,
          revisionNumber: r.revision_number,
          finalWeightKg: r.final_weight_kg,
          portions: r.portions,
          finalQuantity: r.final_quantity,
          finalUnit: r.final_unit,
          cost: v
            ? {
                complete: v.complete,
                total: v.total,
                costPerKg: v.costPerKg,
                costPerPortion: v.costPerPortion,
                errors: v.issues.filter((i) => i.severity === 'error').length,
                warnings: v.issues.filter((i) => i.severity === 'warning').length,
              }
            : null,
        }
      }),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(rows[0]?.total_count ?? 0), date: t, costsVisible: showCosts },
    }
  })

  app.get('/recipes/categories', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const rows = await db.selectFrom('recipes').select('category').distinct().where('company_id', '=', ctx.companyId).where('category', 'is not', null).orderBy('category').execute()
    return { data: rows.map((r) => r.category) }
  })

  /** Ricette selezionabili come semilavorato (esclude se stessa e le ricette che già la contengono). */
  app.get('/recipes/options', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), exclude: z.uuid().optional() }), req.query)
    let excluded = new Set<string>()
    if (q.exclude) {
      excluded = dependentsOf(await loadEdges(db, ctx.companyId), [q.exclude])
      excluded.add(q.exclude)
    }
    let query = db
      .selectFrom('recipes as r')
      .leftJoin('recipe_revisions as v', 'v.id', 'r.current_revision_id')
      .select(['r.id', 'r.code', 'r.title', 'r.status', 'v.final_unit', 'v.final_quantity', 'v.final_weight_kg'])
      .where('r.company_id', '=', ctx.companyId)
      .where('r.status', '<>', 'archived')
    if (q.q) {
      const pat = likePattern(q.q)
      query = query.where((eb) => eb.or([eb(eb.fn('lower', ['r.title']), 'like', pat), eb(eb.fn('lower', ['r.code']), 'like', pat)]))
    }
    const rows = await query.orderBy('r.title').limit(50).execute()
    return { data: rows.filter((r) => !excluded.has(r.id)).map((r) => ({ id: r.id, code: r.code, title: r.title, status: r.status, finalUnit: r.final_unit, finalQuantity: r.final_quantity, finalWeightKg: r.final_weight_kg })) }
  })

  /* ----------------------------- dettaglio ----------------------------- */
  app.get('/recipes/:id', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const { id } = parse(idParam, req.params)
    const q = parse(z.object({ date: isoDate.optional() }), req.query)
    const r = await db.selectFrom('recipes').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!r) throw notFound('Ricetta')
    const t = today()
    const date = q.date ?? t
    const form = r.current_revision_id ? await loadRevisionForm(db, ctx.companyId, r.current_revision_id) : null
    let valuation: SerializedCost | null = null
    let comparison = null
    let snapshots: Array<Record<string, unknown>> = []
    if (can(ctx, 'costs.read') && r.current_revision_id) {
      valuation = date === t ? ((await currentValuations(db, ctx.companyId, [id], t)).get(id) ?? null) : serialize(await computeValuation(db, ctx.companyId, id, date))
      const snaps = await db
        .selectFrom('cost_snapshots as s')
        .leftJoin('users as u', 'u.id', 's.created_by')
        .leftJoin('recipe_revisions as v', 'v.id', 's.revision_id')
        .select(['s.id', 's.created_at', 's.valuation_date', 's.label', 's.total', 's.cost_per_kg', 's.cost_per_portion', 's.complete', 'u.name as created_by', 'v.number as revision_number'])
        .where('s.recipe_id', '=', id)
        .where('s.company_id', '=', ctx.companyId)
        .orderBy('s.created_at', 'desc')
        .limit(20)
        .execute()
      snapshots = snaps
      if (snaps[0] && valuation) {
        const full = await db.selectFrom('cost_snapshots').select(['id', 'created_at', 'valuation_date', 'label', 'data']).where('id', '=', snaps[0].id).executeTakeFirstOrThrow()
        comparison = compare(valuation, full, can(ctx, 'salaries.read'))
      }
    }
    const usedBy = await db
      .selectFrom('recipes as p')
      .innerJoin('recipe_components as c', 'c.revision_id', 'p.current_revision_id')
      .select(['p.id', 'p.code', 'p.title', 'p.status'])
      .distinct()
      .where('p.company_id', '=', ctx.companyId)
      .where('c.sub_recipe_id', '=', id)
      .orderBy('p.title')
      .execute()
    return {
      id: r.id,
      code: r.code,
      title: r.title,
      category: r.category,
      description: r.description,
      status: r.status,
      lockVersion: r.lock_version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      duplicatedFromId: r.duplicated_from_id,
      revision: form,
      valuation: redactCost(valuation, ctx),
      valuationDate: date,
      comparison: can(ctx, 'costs.read') ? comparison : null,
      snapshots,
      usedBy,
      permissions: { canEdit: can(ctx, 'recipes.manage'), costsVisible: can(ctx, 'costs.read'), salariesVisible: can(ctx, 'salaries.read'), canSnapshot: can(ctx, 'snapshots.create') },
    }
  })

  /* ------------------------ anteprima dall'editor ------------------------ */
  /** Valorizzazione autorevole di una composizione non ancora salvata. */
  app.post('/recipes/preview', async (req) => {
    const ctx = requireCompany(req, 'recipes.manage', 'costs.read')
    const body = parse(z.object({ recipeId: z.uuid().nullable().optional(), title: z.string().max(160).default('Nuova ricetta'), revision: revisionBody, date: isoDate.optional() }), req.body)
    if (body.recipeId) {
      const r = await db.selectFrom('recipes').select('id').where('id', '=', body.recipeId).where('company_id', '=', ctx.companyId).executeTakeFirst()
      if (!r) throw notFound('Ricetta')
    }
    const id = body.recipeId ?? '00000000-0000-0000-0000-000000000000'
    const draft = draftToInput(id, body.title || 'Nuova ricetta', 'BOZZA', body.revision)
    const result = await computeValuation(db, ctx.companyId, id, body.date ?? today(), draft)
    return redactCost(serialize(result), ctx)
  })

  /* --------------------------- creazione/modifica --------------------------- */
  app.post('/recipes', async (req) => {
    const ctx = requireCompany(req, 'recipes.manage')
    const body = parse(recipeHeader.extend({ revision: revisionBody }), req.body)
    await validateRevision(db, ctx.companyId, null, body.revision)
    const res = await db.transaction().execute(async (trx) => {
      const code = body.code ?? (await nextCode(trx, 'recipes', ctx.companyId, 'RIC'))
      const dup = await trx.selectFrom('recipes').select('id').where('company_id', '=', ctx.companyId).where(sql`lower(code)`, '=', code.toLowerCase()).executeTakeFirst()
      if (dup) throw conflict('duplicate_code', `Il codice ${code} è già in uso.`, { fields: { code: 'Codice già in uso.' } })
      const r = await trx
        .insertInto('recipes')
        .values({ company_id: ctx.companyId, code, title: body.title, category: body.category ?? null, description: body.description ?? null, status: body.status })
        .returning('id')
        .executeTakeFirstOrThrow()
      const rev = await insertRevision(trx, ctx.companyId, ctx.user.id, r.id, body.revision)
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'recipe', entityId: r.id, action: 'created', details: { code, title: body.title, revision: rev.number } })
      return { id: r.id, code, revisionId: rev.id, revisionNumber: rev.number }
    })
    return res
  })

  /** Salvataggio: crea una nuova revisione immutabile (concorrenza ottimistica su lockVersion). */
  app.put('/recipes/:id', async (req) => {
    const ctx = requireCompany(req, 'recipes.manage')
    const { id } = parse(idParam, req.params)
    const body = parse(recipeHeader.extend({ code: z.string().trim().min(1).max(40), status: z.enum(['draft', 'active']).optional(), lockVersion: z.number().int(), revision: revisionBody }), req.body)
    await validateRevision(db, ctx.companyId, id, body.revision)
    const res = await db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('recipes').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).forUpdate().executeTakeFirst()
      if (!cur) throw notFound('Ricetta')
      if (cur.lock_version !== body.lockVersion) throw conflict('stale', 'La ricetta è stata salvata da un altro utente nel frattempo. Le tue modifiche non sono andate perse: ricarica la versione aggiornata per confrontarle.')
      const dup = await trx.selectFrom('recipes').select('id').where('company_id', '=', ctx.companyId).where(sql`lower(code)`, '=', body.code.toLowerCase()).where('id', '<>', id).executeTakeFirst()
      if (dup) throw conflict('duplicate_code', `Il codice ${body.code} è già in uso.`, { fields: { code: 'Codice già in uso.' } })
      // ricontrollo dei cicli dentro la transazione, con il grafo aggiornato
      await validateRevision(trx, ctx.companyId, id, body.revision)
      await trx
        .updateTable('recipes')
        .set({
          code: body.code,
          title: body.title,
          category: body.category ?? null,
          description: body.description ?? null,
          status: cur.status === 'archived' ? 'archived' : (body.status ?? cur.status),
          lock_version: cur.lock_version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .execute()
      const rev = await insertRevision(trx, ctx.companyId, ctx.user.id, id, body.revision)
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'recipe', entityId: id, action: 'revised', details: { revision: rev.number, title: body.title } })
      return { id, revisionId: rev.id, revisionNumber: rev.number, lockVersion: cur.lock_version + 1 }
    })
    const affected = await invalidate(db, ctx.companyId, { type: 'recipes', ids: [id] })
    return { ...res, affectedRecipes: await describeRecipes(db, ctx.companyId, affected.filter((x) => x !== id)) }
  })

  /** Duplicazione: nuova identità, revisione copiata, nessuno snapshot copiato. */
  app.post('/recipes/:id/duplicate', async (req) => {
    const ctx = requireCompany(req, 'recipes.manage')
    const { id } = parse(idParam, req.params)
    const src = await db.selectFrom('recipes').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!src) throw notFound('Ricetta')
    const form = src.current_revision_id ? await loadRevisionForm(db, ctx.companyId, src.current_revision_id) : null
    return db.transaction().execute(async (trx) => {
      const code = await nextCode(trx, 'recipes', ctx.companyId, 'RIC')
      const r = await trx
        .insertInto('recipes')
        .values({ company_id: ctx.companyId, code, title: `Copia di ${src.title}`.slice(0, 160), category: src.category, description: src.description, status: 'draft', duplicated_from_id: src.id })
        .returning('id')
        .executeTakeFirstOrThrow()
      if (form) await insertRevision(trx, ctx.companyId, ctx.user.id, r.id, formToBody(form))
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'recipe', entityId: r.id, action: 'duplicated', details: { from: src.code } })
      return { id: r.id, code }
    })
  })

  for (const [action, status] of [['archive', 'archived'], ['restore', 'draft'], ['activate', 'active']] as const) {
    app.post(`/recipes/:id/${action}`, async (req) => {
      const ctx = requireCompany(req, 'recipes.manage')
      const { id } = parse(idParam, req.params)
      const res = await db
        .updateTable('recipes')
        .set({ status, updated_at: new Date(), lock_version: sql`lock_version + 1` })
        .where('id', '=', id)
        .where('company_id', '=', ctx.companyId)
        .executeTakeFirst()
      if (!res.numUpdatedRows) throw notFound('Ricetta')
      await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'recipe', entityId: id, action })
      // L'archiviazione non cancella nulla: le ricette che la usano continuano a valorizzarla.
      const parents = action === 'archive' ? await describeRecipes(db, ctx.companyId, [...dependentsOf(await loadEdges(db, ctx.companyId), [id])]) : []
      return { ok: true, usedBy: parents }
    })
  }

  /* ------------------------- valorizzazioni e storico ------------------------- */
  app.get('/recipes/:id/valuation', async (req) => {
    const ctx = requireCompany(req, 'recipes.read', 'costs.read')
    const { id } = parse(idParam, req.params)
    const q = parse(z.object({ date: isoDate.optional() }), req.query)
    const r = await db.selectFrom('recipes').select(['id', 'current_revision_id']).where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!r?.current_revision_id) throw notFound('Ricetta')
    const date = q.date ?? today()
    const v = date === today() ? (await currentValuations(db, ctx.companyId, [id], date)).get(id)! : serialize(await computeValuation(db, ctx.companyId, id, date))
    return redactCost(v, ctx)
  })

  app.get('/recipes/:id/revisions', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const { id } = parse(idParam, req.params)
    const rows = await db
      .selectFrom('recipe_revisions as v')
      .leftJoin('users as u', 'u.id', 'v.created_by')
      .select(['v.id', 'v.number', 'v.created_at', 'u.name as created_by'])
      .where('v.recipe_id', '=', id)
      .where('v.company_id', '=', ctx.companyId)
      .orderBy('v.number', 'desc')
      .execute()
    return { data: rows }
  })

  app.get('/recipes/:id/revisions/:revisionId', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const { id, revisionId } = parse(z.object({ id: z.uuid(), revisionId: z.uuid() }), req.params)
    const rev = await db.selectFrom('recipe_revisions').select('id').where('id', '=', revisionId).where('recipe_id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!rev) throw notFound('Revisione')
    return loadRevisionForm(db, ctx.companyId, revisionId)
  })

  /**
   * Snapshot di costo: fotografia immutabile e autosufficiente (comprese le sottoricette annidate).
   * Calcolata dentro una transazione REPEATABLE READ con lock sulla ricetta e verifica della revisione attesa.
   */
  app.post('/recipes/:id/snapshots', async (req) => {
    const ctx = requireCompany(req, 'snapshots.create')
    const { id } = parse(idParam, req.params)
    const body = parse(z.object({ label: z.string().trim().max(120).optional(), expectedRevisionId: z.uuid(), date: isoDate.optional() }), req.body)
    const date = body.date ?? today()
    const snap = await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        const r = await trx.selectFrom('recipes').select(['id', 'current_revision_id', 'title']).where('id', '=', id).where('company_id', '=', ctx.companyId).forUpdate().executeTakeFirst()
        if (!r) throw notFound('Ricetta')
        if (r.current_revision_id !== body.expectedRevisionId) throw conflict('stale', 'La ricetta è cambiata dopo che hai aperto la scheda: ricarica prima di salvare lo snapshot.')
        const result = serialize(await computeValuation(trx, ctx.companyId, id, date))
        const s = await trx
          .insertInto('cost_snapshots')
          .values({
            company_id: ctx.companyId,
            recipe_id: id,
            revision_id: r.current_revision_id,
            valuation_date: date,
            label: body.label || null,
            complete: result.complete,
            total: result.total,
            cost_per_kg: result.costPerKg,
            cost_per_portion: result.costPerPortion,
            data: JSON.stringify(result),
            created_by: ctx.user.id,
          })
          .returning(['id', 'created_at'])
          .executeTakeFirstOrThrow()
        await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'cost_snapshot', entityId: s.id, action: 'created', details: { recipe: r.title, total: result.total, complete: result.complete } })
        return { ...s, complete: result.complete, total: result.total }
      })
    return snap
  })

  app.get('/snapshots/:id', async (req) => {
    const ctx = requireCompany(req, 'costs.read')
    const { id } = parse(idParam, req.params)
    const s = await db
      .selectFrom('cost_snapshots as s')
      .leftJoin('users as u', 'u.id', 's.created_by')
      .leftJoin('recipe_revisions as v', 'v.id', 's.revision_id')
      .select(['s.id', 's.recipe_id', 's.revision_id', 's.valuation_date', 's.label', 's.complete', 's.total', 's.data', 's.created_at', 'u.name as created_by', 'v.number as revision_number'])
      .where('s.id', '=', id)
      .where('s.company_id', '=', ctx.companyId)
      .executeTakeFirst()
    if (!s) throw notFound('Snapshot')
    return { ...s, data: redactCost(s.data as SerializedCost, ctx) }
  })

  /** Eliminazione definitiva di una bozza mai usata altrove e senza snapshot. */
  app.delete('/recipes/:id', async (req) => {
    const ctx = requireCompany(req, 'recipes.manage')
    const { id } = parse(idParam, req.params)
    return db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('recipes').select(['id', 'code', 'status']).where('id', '=', id).where('company_id', '=', ctx.companyId).forUpdate().executeTakeFirst()
      if (!r) throw notFound('Ricetta')
      const used = await trx.selectFrom('recipe_components').select('id').where('sub_recipe_id', '=', id).limit(1).executeTakeFirst()
      const snap = await trx.selectFrom('cost_snapshots').select('id').where('recipe_id', '=', id).limit(1).executeTakeFirst()
      if (used || snap) throw conflict('in_use', 'La ricetta è usata come semilavorato o ha snapshot di costo: archiviala invece di eliminarla.')
      await trx.updateTable('recipes').set({ current_revision_id: null }).where('id', '=', id).execute()
      await trx.updateTable('recipes').set({ duplicated_from_id: null }).where('duplicated_from_id', '=', id).execute()
      const revs = trx.selectFrom('recipe_revisions').select('id').where('recipe_id', '=', id)
      await trx.deleteFrom('recipe_equipment_uses').where('revision_id', 'in', revs).execute()
      await trx.deleteFrom('recipe_labor').where('revision_id', 'in', revs).execute()
      await trx.deleteFrom('recipe_components').where('revision_id', 'in', revs).execute()
      await trx.deleteFrom('recipe_phases').where('revision_id', 'in', revs).execute()
      await trx.deleteFrom('recipe_cost_cache').where('recipe_id', '=', id).execute()
      await trx.deleteFrom('recipe_revisions').where('recipe_id', '=', id).execute()
      await trx.deleteFrom('recipes').where('id', '=', id).execute()
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'recipe', entityId: id, action: 'deleted', details: { code: r.code } })
      return { ok: true }
    })
  })
}
