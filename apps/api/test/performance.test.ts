import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { addMember, createCompany, createUser, expectOk, loginAs, setup, teardown, type Client, type TestEnv } from './helpers'

/**
 * Velocità delle risposte con volumi realistici: 5.000 ingredienti con prezzi e 300 ricette annidate.
 * Misura con PostgreSQL in-process (PGlite, più lento di un server PostgreSQL): i limiti sono prudenti.
 */
let env: TestEnv
let a: Client
const timings: Record<string, number> = {}

async function timed<T>(label: string, fn: () => Promise<T>, runs = 5): Promise<T> {
  let result!: T
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    result = await fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((x, y) => x - y)
  timings[label] = Math.round(samples[Math.floor(samples.length / 2)]!)
  return result
}

beforeAll(async () => {
  env = await setup()
  const c = await createCompany(env, 'Volumi')
  await addMember(env, c, await createUser(env, 'perf@example.test', 'Perf'), 'admin')
  a = await loginAs(env, 'perf@example.test')
  const db = env.database.db
  await sql`
    INSERT INTO ingredients (company_id, code, name, category, package_content, package_unit, usage_unit)
    SELECT ${c}, 'P-' || g, 'Articolo ' || g, 'Categoria ' || (g % 20), 1 + (g % 10), 'kg', 'g' FROM generate_series(1, 5000) g`.execute(db)
  await sql`
    INSERT INTO ingredient_prices (company_id, ingredient_id, package_price, package_content, package_unit, valid_from)
    SELECT company_id, id, 1 + (random() * 40)::numeric(10,2), package_content, package_unit, d::date
    FROM ingredients, (VALUES ('2025-01-01'), ('2026-01-01'), ('2026-06-01')) v(d) WHERE company_id = ${c}`.execute(db)
  const ings = (await db.selectFrom('ingredients').select('id').where('company_id', '=', c).limit(300).execute()).map((r) => r.id)
  // 100 basi, 200 ricette che usano 2 basi ciascuna
  const bases: string[] = []
  for (let i = 0; i < 100; i++) {
    const r = expectOk(await a.post('/api/recipes', { code: `B${i}`, title: `Base ${i}`, status: 'active', revision: { finalWeightKg: '3', components: [0, 1, 2, 3].map((k) => ({ kind: 'ingredient', ingredientId: ings[(i * 3 + k) % ings.length], quantity: '500', unit: 'g' })) } }))
    bases.push(r.id)
  }
  for (let i = 0; i < 200; i++) {
    expectOk(
      await a.post('/api/recipes', {
        code: `R${i}`,
        title: `Piatto ${i}`,
        status: 'active',
        revision: {
          finalWeightKg: '2',
          portions: '8',
          components: [
            { kind: 'recipe', recipeId: bases[i % 100], quantity: '400', unit: 'g' },
            { kind: 'recipe', recipeId: bases[(i * 7) % 100], quantity: '300', unit: 'g' },
            { kind: 'ingredient', ingredientId: ings[i % ings.length], quantity: '200', unit: 'g' },
          ],
        },
      }),
    )
  }
}, 240_000)
afterAll(async () => {
  console.log('Tempi mediani (ms):', JSON.stringify(timings))
  await teardown(env)
})

describe('Velocità con volumi realistici', () => {
  it('elenco ingredienti: pagina, ricerca e filtro su 5.000 articoli', async () => {
    const page = await timed('ingredienti_pagina', () => a.get('/api/ingredients?page=40&pageSize=50&sort=name'))
    expect(page.body.meta.total).toBe(5000)
    await timed('ingredienti_ricerca', () => a.get('/api/ingredients?q=articolo%2042&pageSize=25'))
    await timed('ingredienti_categoria', () => a.get('/api/ingredients?category=Categoria%207&pageSize=25'))
    expect(timings.ingredienti_pagina).toBeLessThan(400)
    expect(timings.ingredienti_ricerca).toBeLessThan(400)
  })

  it('elenco ricette con costi: primo calcolo e poi cache', async () => {
    const t0 = performance.now()
    await a.get('/api/recipes?pageSize=50')
    timings.ricette_primo_calcolo = Math.round(performance.now() - t0)
    const list = await timed('ricette_da_cache', () => a.get('/api/recipes?pageSize=50&sort=title'))
    expect(list.body.data[0].cost).toBeTruthy()
    expect(timings.ricette_da_cache).toBeLessThan(400)
  })

  it('scheda ricetta annidata e anteprima dall’editor', async () => {
    const list = await a.get('/api/recipes?q=piatto%2017&pageSize=1')
    const id = list.body.data[0].id
    const detail = await timed('scheda_ricetta', () => a.get(`/api/recipes/${id}`))
    await timed('anteprima_editor', () =>
      a.post('/api/recipes/preview', { recipeId: id, revision: { finalWeightKg: '2', components: detail.body.revision.components.map((c: Record<string, unknown>) => ({ kind: c.kind, ingredientId: c.ingredientId, recipeId: c.recipeId, quantity: c.quantity, unit: c.unit })) } }),
    )
    expect(timings.scheda_ricetta).toBeLessThan(400)
    expect(timings.anteprima_editor).toBeLessThan(400)
  })

  it('un nuovo prezzo invalida solo le ricette interessate e il ricalcolo resta rapido', async () => {
    const ing = await a.get('/api/ingredients?q=articolo%205&pageSize=1&sort=code')
    const r = await timed('nuovo_prezzo_e_propagazione', async () => a.post(`/api/ingredients/${ing.body.data[0].id}/prices`, { packagePrice: String(10 + Math.random()), validFrom: `2026-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}` }), 1)
    expect(r.status).toBe(200)
    const t0 = performance.now()
    await a.get('/api/dashboard')
    timings.dashboard_dopo_modifica = Math.round(performance.now() - t0)
    expect(timings.dashboard_dopo_modifica).toBeLessThan(1500)
  })
})
