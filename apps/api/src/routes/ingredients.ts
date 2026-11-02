import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { z } from 'zod'
import { d, dimensionOf, normalizedPrice, BASE_UNIT, type MeasureUnit } from '@foodcost/domain'
import { can, parse, requireCompany } from '../http/context'
import { conflict, notFound, badRequest } from '../http/errors'
import { dec, decOpt, isoDate, likePattern, listQuery, measureUnit, optText, reqText, today } from '../http/schemas'
import { audit, diff } from '../services/audit'
import { describeRecipes, invalidate } from '../services/costing'
import { nextCode } from '../services/codes'

const ingredientBody = z.object({
  code: optText(40),
  name: reqText('Il nome', 160),
  category: optText(80),
  supplier: optText(120),
  notes: optText(2000),
  purchaseUnit: z.string().trim().min(1).max(40).default('confezione'),
  packageContent: dec({ gt: 0, label: 'Il contenuto della confezione' }),
  packageUnit: measureUnit,
  usageUnit: measureUnit,
  edibleYieldPercent: dec({ gt: 0, max: 100, label: 'La resa edibile' }).default('100'),
  densityKgPerL: decOpt({ gt: 0, label: 'La densità' }),
  unitWeightKg: decOpt({ gt: 0, label: 'Il peso medio unitario' }),
})

const priceBody = z.object({
  packagePrice: dec({ min: 0, label: 'Il prezzo' }),
  validFrom: isoDate,
  source: optText(120),
  notes: optText(500),
  packageContent: decOpt({ gt: 0, label: 'Il contenuto della confezione' }).optional(),
  packageUnit: measureUnit.optional(),
})

/** Coerenza tra unità di utilizzo, confezione e dati di conversione. */
function checkConversions(b: { packageUnit: MeasureUnit; usageUnit: MeasureUnit; densityKgPerL: string | null; unitWeightKg: string | null }) {
  const from = dimensionOf(b.usageUnit)
  const to = dimensionOf(b.packageUnit)
  if (from === to) return
  const pair = new Set([from, to])
  if (pair.has('volume') && pair.has('mass') && !b.densityKgPerL) {
    throw badRequest('validation_failed', 'Per usare in ricetta un’unità di volume con una confezione a peso (o viceversa) serve la densità.', { fields: { densityKgPerL: 'Obbligatoria per questa combinazione di unità.' } })
  }
  if (pair.has('count') && !b.unitWeightKg) {
    throw badRequest('validation_failed', 'Per passare da pezzi a peso o volume serve il peso medio unitario.', { fields: { unitWeightKg: 'Obbligatorio per questa combinazione di unità.' } })
  }
  if (pair.has('count') && pair.has('volume') && !b.densityKgPerL) {
    throw badRequest('validation_failed', 'Per passare da pezzi a volume servono peso unitario e densità.', { fields: { densityKgPerL: 'Obbligatoria per questa combinazione di unità.' } })
  }
}

export async function ingredientRoutes(app: FastifyInstance) {
  const db = app.database.db

  const SORTS = { name: 'i.name', code: 'i.code', category: 'i.category', updated: 'i.updated_at', supplier: 'i.supplier' } as const

  app.get('/ingredients', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const q = parse(listQuery.extend({ price: z.enum(['all', 'missing', 'zero']).default('all'), date: isoDate.optional() }), req.query)
    const date = q.date ?? today()
    const showCosts = can(ctx, 'costs.read')
    let query = db
      .selectFrom('ingredients as i')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('ingredient_prices as p')
            .select(['p.package_price', 'p.package_content', 'p.package_unit', 'p.valid_from'])
            .whereRef('p.ingredient_id', '=', 'i.id')
            .where('p.valid_from', '<=', date)
            .orderBy('p.valid_from', 'desc')
            .limit(1)
            .as('p'),
        (j) => j.onTrue(),
      )
      .where('i.company_id', '=', ctx.companyId)
    if (q.archived === '0') query = query.where('i.archived_at', 'is', null)
    if (q.archived === '1') query = query.where('i.archived_at', 'is not', null)
    if (q.category) query = query.where('i.category', '=', q.category)
    if (q.q) {
      const pat = likePattern(q.q)
      query = query.where((eb) => eb.or([eb(eb.fn('lower', ['i.name']), 'like', pat), eb(eb.fn('lower', ['i.code']), 'like', pat), eb(eb.fn('lower', ['i.supplier']), 'like', pat)]))
    }
    if (q.price === 'missing') query = query.where('p.package_price', 'is', null)
    if (q.price === 'zero') query = query.where('p.package_price', '=', '0')
    const sortCol = SORTS[(q.sort ?? 'name') as keyof typeof SORTS] ?? SORTS.name
    const rows = await query
      .select([
        'i.id',
        'i.code',
        'i.name',
        'i.category',
        'i.supplier',
        'i.package_content',
        'i.package_unit',
        'i.usage_unit',
        'i.purchase_unit',
        'i.edible_yield',
        'i.archived_at',
        'i.updated_at',
        'p.package_price',
        'p.package_content as price_content',
        'p.package_unit as price_unit',
        'p.valid_from',
        sql<string>`count(*) over()`.as('total_count'),
      ])
      .orderBy(sql.ref(sortCol), q.dir)
      .orderBy('i.id')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .execute()
    return {
      data: rows.map((r) => {
        const hasPrice = r.package_price !== null
        const unitPrice = hasPrice ? normalizedPrice({ packagePrice: d(r.package_price!), packageContent: d(r.price_content!), packageUnit: r.price_unit as MeasureUnit }) : null
        return {
          id: r.id,
          code: r.code,
          name: r.name,
          category: r.category,
          supplier: r.supplier,
          packageContent: r.package_content,
          packageUnit: r.package_unit,
          purchaseUnit: r.purchase_unit,
          usageUnit: r.usage_unit,
          edibleYieldPercent: d(r.edible_yield).times(100).toFixed(),
          archived: r.archived_at !== null,
          updatedAt: r.updated_at,
          price: showCosts
            ? {
                status: hasPrice ? (d(r.package_price!).isZero() ? 'zero' : 'ok') : 'missing',
                packagePrice: r.package_price,
                validFrom: r.valid_from,
                unitPrice: unitPrice?.toFixed() ?? null,
                baseUnit: BASE_UNIT[dimensionOf((r.price_unit ?? r.package_unit) as MeasureUnit)],
              }
            : null,
        }
      }),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(rows[0]?.total_count ?? 0), date },
    }
  })

  app.get('/ingredients/categories', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const rows = await db.selectFrom('ingredients').select('category').distinct().where('company_id', '=', ctx.companyId).where('category', 'is not', null).orderBy('category').execute()
    return { data: rows.map((r) => r.category) }
  })

  app.get('/ingredients/:id', async (req) => {
    const ctx = requireCompany(req, 'recipes.read')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const i = await db.selectFrom('ingredients').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!i) throw notFound('Ingrediente')
    const showCosts = can(ctx, 'costs.read')
    const prices = showCosts
      ? await db
          .selectFrom('ingredient_prices as p')
          .leftJoin('users as u', 'u.id', 'p.created_by')
          .select(['p.id', 'p.package_price', 'p.package_content', 'p.package_unit', 'p.valid_from', 'p.source', 'p.notes', 'p.created_at', 'p.import_id', 'u.name as created_by'])
          .where('p.ingredient_id', '=', id)
          .where('p.company_id', '=', ctx.companyId)
          .orderBy('p.valid_from', 'desc')
          .execute()
      : []
    const t = today()
    const usedIn = await db
      .selectFrom('recipes as r')
      .innerJoin('recipe_components as c', 'c.revision_id', 'r.current_revision_id')
      .select(['r.id', 'r.code', 'r.title', 'r.status'])
      .distinct()
      .where('r.company_id', '=', ctx.companyId)
      .where('c.ingredient_id', '=', id)
      .orderBy('r.title')
      .execute()
    const current = prices.find((p) => p.valid_from <= t) ?? null
    return {
      id: i.id,
      code: i.code,
      name: i.name,
      category: i.category,
      supplier: i.supplier,
      notes: i.notes,
      purchaseUnit: i.purchase_unit,
      packageContent: i.package_content,
      packageUnit: i.package_unit,
      usageUnit: i.usage_unit,
      edibleYieldPercent: d(i.edible_yield).times(100).toFixed(),
      densityKgPerL: i.density_kg_per_l,
      unitWeightKg: i.unit_weight_kg,
      archived: i.archived_at !== null,
      lockVersion: i.lock_version,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      priceVisible: showCosts,
      currentPrice: current
        ? {
            ...current,
            unitPrice: normalizedPrice({ packagePrice: d(current.package_price), packageContent: d(current.package_content), packageUnit: current.package_unit as MeasureUnit })!.toFixed(),
            baseUnit: BASE_UNIT[dimensionOf(current.package_unit as MeasureUnit)],
          }
        : null,
      prices: prices.map((p) => ({
        ...p,
        unitPrice: normalizedPrice({ packagePrice: d(p.package_price), packageContent: d(p.package_content), packageUnit: p.package_unit as MeasureUnit })!.toFixed(),
        baseUnit: BASE_UNIT[dimensionOf(p.package_unit as MeasureUnit)],
        future: p.valid_from > t,
      })),
      usedIn,
    }
  })

  app.post('/ingredients', async (req) => {
    const ctx = requireCompany(req, 'ingredients.manage')
    const body = parse(ingredientBody.extend({ initialPrice: priceBody.omit({ packageContent: true, packageUnit: true }).optional() }), req.body)
    checkConversions(body)
    if (body.initialPrice && !can(ctx, 'costs.read')) throw badRequest('forbidden_price', 'Non hai i permessi per inserire prezzi.')
    return db.transaction().execute(async (trx) => {
      const code = body.code ?? (await nextCode(trx, 'ingredients', ctx.companyId, 'ING'))
      const exists = await trx.selectFrom('ingredients').select('id').where('company_id', '=', ctx.companyId).where(sql`lower(code)`, '=', code.toLowerCase()).executeTakeFirst()
      if (exists) throw conflict('duplicate_code', `Il codice ${code} è già usato da un altro ingrediente.`, { fields: { code: 'Codice già in uso.' } })
      const row = await trx
        .insertInto('ingredients')
        .values({
          company_id: ctx.companyId,
          code,
          name: body.name,
          category: body.category ?? null,
          supplier: body.supplier ?? null,
          notes: body.notes ?? null,
          purchase_unit: body.purchaseUnit,
          package_content: body.packageContent,
          package_unit: body.packageUnit,
          usage_unit: body.usageUnit,
          edible_yield: d(body.edibleYieldPercent).div(100).toFixed(),
          density_kg_per_l: body.densityKgPerL,
          unit_weight_kg: body.unitWeightKg,
        })
        .returning(['id', 'code', 'name', 'usage_unit', 'package_unit'])
        .executeTakeFirstOrThrow()
      if (body.initialPrice) {
        await trx
          .insertInto('ingredient_prices')
          .values({
            company_id: ctx.companyId,
            ingredient_id: row.id,
            package_price: body.initialPrice.packagePrice,
            package_content: body.packageContent,
            package_unit: body.packageUnit,
            valid_from: body.initialPrice.validFrom,
            source: body.initialPrice.source ?? null,
            notes: body.initialPrice.notes ?? null,
            created_by: ctx.user.id,
          })
          .execute()
      }
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'ingredient', entityId: row.id, action: 'created', details: { code, name: body.name } })
      return { id: row.id, code: row.code, name: row.name, usageUnit: row.usage_unit, packageUnit: row.package_unit }
    })
  })

  app.patch('/ingredients/:id', async (req) => {
    const ctx = requireCompany(req, 'ingredients.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const body = parse(ingredientBody.extend({ code: reqText('Il codice', 40), lockVersion: z.number().int() }), req.body)
    checkConversions(body)
    const result = await db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('ingredients').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).forUpdate().executeTakeFirst()
      if (!cur) throw notFound('Ingrediente')
      if (cur.lock_version !== body.lockVersion) throw conflict('stale', 'L’ingrediente è stato modificato da un altro utente: ricarica la pagina.')
      if (body.code.toLowerCase() !== cur.code.toLowerCase()) {
        const dup = await trx.selectFrom('ingredients').select('id').where('company_id', '=', ctx.companyId).where(sql`lower(code)`, '=', body.code.toLowerCase()).where('id', '<>', id).executeTakeFirst()
        if (dup) throw conflict('duplicate_code', `Il codice ${body.code} è già usato.`, { fields: { code: 'Codice già in uso.' } })
      }
      const next = {
        code: body.code,
        name: body.name,
        category: body.category ?? null,
        supplier: body.supplier ?? null,
        notes: body.notes ?? null,
        purchase_unit: body.purchaseUnit,
        package_content: body.packageContent,
        package_unit: body.packageUnit,
        usage_unit: body.usageUnit,
        edible_yield: d(body.edibleYieldPercent).div(100).toFixed(),
        density_kg_per_l: body.densityKgPerL,
        unit_weight_kg: body.unitWeightKg,
      }
      const changes = diff(
        Object.fromEntries(Object.keys(next).map((k) => [k, normalizeNum((cur as Record<string, unknown>)[k])])),
        Object.fromEntries(Object.entries(next).map(([k, v]) => [k, normalizeNum(v)])),
      )
      await trx
        .updateTable('ingredients')
        .set({ ...next, updated_at: new Date(), lock_version: cur.lock_version + 1 })
        .where('id', '=', id)
        .execute()
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'ingredient', entityId: id, action: 'updated', details: changes })
      return changes
    })
    const costRelevant = ['edible_yield', 'density_kg_per_l', 'unit_weight_kg'].some((k) => k in result)
    const affected = costRelevant ? await invalidate(db, ctx.companyId, { type: 'ingredients', ids: [id] }) : []
    return { ok: true, affectedRecipes: await describeRecipes(db, ctx.companyId, affected) }
  })

  /** Nuovo prezzo: crea una voce di storico e segnala le ricette interessate, anche indirettamente. */
  app.post('/ingredients/:id/prices', async (req) => {
    const ctx = requireCompany(req, 'ingredients.manage', 'costs.read')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const body = parse(priceBody, req.body)
    const ing = await db.selectFrom('ingredients').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!ing) throw notFound('Ingrediente')
    const content = body.packageContent ?? ing.package_content
    const unit = body.packageUnit ?? (ing.package_unit as MeasureUnit)
    if (dimensionOf(unit) !== dimensionOf(ing.package_unit as MeasureUnit)) {
      throw badRequest('validation_failed', 'L’unità della confezione deve restare della stessa grandezza (peso, volume o pezzi).', { fields: { packageUnit: 'Grandezza non compatibile.' } })
    }
    const existing = await db.selectFrom('ingredient_prices').selectAll().where('ingredient_id', '=', id).where('valid_from', '=', body.validFrom).executeTakeFirst()
    if (existing) {
      const same = d(existing.package_price).eq(body.packagePrice) && d(existing.package_content).eq(content) && existing.package_unit === unit
      throw conflict(
        same ? 'duplicate_price' : 'price_date_conflict',
        same ? 'Questo prezzo è già registrato con la stessa data.' : 'Esiste già un prezzo con questa data di validità: scegli un’altra data o elimina quello esistente.',
        { fields: { validFrom: 'Data già usata.' } },
      )
    }
    const price = await db
      .insertInto('ingredient_prices')
      .values({
        company_id: ctx.companyId,
        ingredient_id: id,
        package_price: body.packagePrice,
        package_content: content,
        package_unit: unit,
        valid_from: body.validFrom,
        source: body.source ?? null,
        notes: body.notes ?? null,
        created_by: ctx.user.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'ingredient_price', entityId: price.id, action: 'created', details: { ingredient: ing.code, packagePrice: body.packagePrice, validFrom: body.validFrom } })
    const affected = await invalidate(db, ctx.companyId, { type: 'ingredients', ids: [id] })
    return { id: price.id, affectedRecipes: await describeRecipes(db, ctx.companyId, affected) }
  })

  app.delete('/ingredients/:id/prices/:priceId', async (req) => {
    const ctx = requireCompany(req, 'ingredients.manage', 'costs.read')
    const { id, priceId } = parse(z.object({ id: z.uuid(), priceId: z.uuid() }), req.params)
    const p = await db.selectFrom('ingredient_prices').selectAll().where('id', '=', priceId).where('ingredient_id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!p) throw notFound('Prezzo')
    await db.deleteFrom('ingredient_prices').where('id', '=', priceId).execute()
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'ingredient_price', entityId: priceId, action: 'deleted', details: { packagePrice: p.package_price, validFrom: p.valid_from } })
    const affected = await invalidate(db, ctx.companyId, { type: 'ingredients', ids: [id] })
    return { ok: true, affectedRecipes: await describeRecipes(db, ctx.companyId, affected) }
  })

  app.post('/ingredients/:id/archive', async (req) => setArchived(req, true))
  app.post('/ingredients/:id/restore', async (req) => setArchived(req, false))

  async function setArchived(req: Parameters<typeof requireCompany>[0], archived: boolean) {
    const ctx = requireCompany(req, 'ingredients.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const res = await db
      .updateTable('ingredients')
      .set({ archived_at: archived ? new Date() : null, updated_at: new Date(), lock_version: sql`lock_version + 1` })
      .where('id', '=', id)
      .where('company_id', '=', ctx.companyId)
      .executeTakeFirst()
    if (!res.numUpdatedRows) throw notFound('Ingrediente')
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'ingredient', entityId: id, action: archived ? 'archived' : 'restored' })
    return { ok: true }
  }

  /** Eliminazione definitiva solo se l'ingrediente non è mai stato usato in nessuna revisione di ricetta. */
  app.delete('/ingredients/:id', async (req) => {
    const ctx = requireCompany(req, 'ingredients.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    return db.transaction().execute(async (trx) => {
      const ing = await trx.selectFrom('ingredients').select(['id', 'code']).where('id', '=', id).where('company_id', '=', ctx.companyId).forUpdate().executeTakeFirst()
      if (!ing) throw notFound('Ingrediente')
      const ref = await trx.selectFrom('recipe_components').select('id').where('ingredient_id', '=', id).limit(1).executeTakeFirst()
      if (ref) throw conflict('in_use', 'L’ingrediente è usato in almeno una ricetta (anche in revisioni storiche): puoi archiviarlo ma non eliminarlo.')
      await trx.deleteFrom('ingredient_prices').where('ingredient_id', '=', id).execute()
      await trx.deleteFrom('ingredients').where('id', '=', id).execute()
      await audit(trx, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'ingredient', entityId: id, action: 'deleted', details: { code: ing.code } })
      return { ok: true }
    })
  })
}

function normalizeNum(v: unknown): unknown {
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return d(v).toFixed()
  return v
}
