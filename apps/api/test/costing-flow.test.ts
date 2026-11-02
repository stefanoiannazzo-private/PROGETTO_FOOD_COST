import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { today } from '../src/http/schemas'
import { addMember, createCompany, createUser, expectOk, loginAs, setup, teardown, type Client, type TestEnv } from './helpers'

/**
 * Percorso completo via API: ingredienti → ragù → lasagna → costo/kg e per porzione
 * → modifica prezzo → nuova valorizzazione → confronto con lo snapshot.
 */
let env: TestEnv
let a: Client
const ids: Record<string, string> = {}
const T = today()

beforeAll(async () => {
  env = await setup()
  const c = await createCompany(env, 'Gastronomia Test')
  await addMember(env, c, await createUser(env, 'admin@example.test', 'Admin'), 'admin')
  a = await loginAs(env, 'admin@example.test')

  const ing = async (key: string, body: object) => (ids[key] = expectOk(await a.post('/api/ingredients', body)).id)
  await ing('carne', { code: 'CARNE', name: 'Carne macinata', packageContent: '1', packageUnit: 'kg', usageUnit: 'g', initialPrice: { packagePrice: '8', validFrom: '2026-01-01' } })
  await ing('pomodoro', { code: 'POM', name: 'Pomodoro pelato', packageContent: '2.5', packageUnit: 'kg', usageUnit: 'g', initialPrice: { packagePrice: '5', validFrom: '2026-01-01' } })
  await ing('sfoglia', { code: 'SFO', name: 'Sfoglia fresca', packageContent: '1', packageUnit: 'kg', usageUnit: 'g', initialPrice: { packagePrice: '8', validFrom: '2026-01-01' } })

  ids.luce = expectOk(await a.post('/api/tariffs', { name: 'Luce', kind: 'electricity', unit: 'kwh', firstVersion: { mode: 'direct', pricePerUnit: '0.5', validFrom: '2026-01-01' } })).id
  ids.forno = expectOk(
    await a.post('/api/equipment', { code: 'FORNO', name: 'Forno', powerType: 'electric', electricPowerKw: '5', usageCoefficient: '0.8', electricTariffId: ids.luce }),
  ).id
  ids.mario = expectOk(
    await a.post('/api/employees', { code: 'D1', firstName: 'Mario', lastName: 'Rossi', firstCost: { validFrom: '2026-01-01', grossMonthly: '2400', contributionsMode: 'none', productiveHours: '160' } }),
  ).id
})
afterAll(() => teardown(env))

const raguRevision = () => ({
  finalQuantity: '5',
  finalUnit: 'kg',
  finalWeightKg: '5',
  phases: [{ key: 'f1', name: 'Rosolatura e cottura' }],
  components: [
    { kind: 'ingredient', ingredientId: ids.carne, quantity: '2000', unit: 'g' }, // 16 €
    { kind: 'ingredient', ingredientId: ids.pomodoro, quantity: '2', unit: 'kg' }, // 4 €
  ],
  equipmentUses: [{ phaseKey: 'f1', equipmentId: ids.forno, segment: 'work', minutes: '60', sharePercent: '100' }], // 4 kWh × 0,5 = 2 €
  labor: [{ phaseKey: 'f1', employeeId: ids.mario, activeMinutes: '48', sharePercent: '100' }], // 12 €
})

describe('Percorso ragù → lasagna', () => {
  it('ragù: 34 € per lotto, 6,80 €/kg', async () => {
    const r = expectOk(await a.post('/api/recipes', { code: 'RAGU', title: 'Ragù', status: 'active', revision: raguRevision() }))
    ids.ragu = r.id
    const detail = expectOk(await a.get(`/api/recipes/${ids.ragu}`))
    const v = detail.valuation
    expect(v.complete).toBe(true)
    expect([v.directIngredients, v.energy, v.labor, v.total, v.costPerKg]).toEqual(['20', '2', '12', '34', '6.8'])
    expect(v.machineMinutes).toBe('60')
    expect(v.personMinutes).toBe('48')
  })

  it('lasagna con 600 g di ragù: 19,08 €, 7,95 €/kg, 2,385 €/porzione, nessun doppio conteggio', async () => {
    const r = expectOk(
      await a.post('/api/recipes', {
        code: 'LAS',
        title: 'Lasagna',
        status: 'active',
        revision: {
          finalQuantity: '8',
          finalUnit: 'pz',
          finalWeightKg: '2.4',
          portions: '8',
          components: [
            { kind: 'recipe', recipeId: ids.ragu, quantity: '600', unit: 'g' },
            { kind: 'ingredient', ingredientId: ids.sfoglia, quantity: '1', unit: 'kg' },
          ],
          equipmentUses: [{ equipmentId: ids.forno, segment: 'work', minutes: '30', sharePercent: '100' }], // 1 €
          labor: [{ employeeId: ids.mario, activeMinutes: '24', sharePercent: '100' }], // 6 €
        },
      }),
    )
    ids.lasagna = r.id
    const v = expectOk(await a.get(`/api/recipes/${ids.lasagna}`)).valuation
    expect(v.subrecipeLines[0].cost).toBe('4.08')
    expect(v.total).toBe('19.08')
    expect(v.costPerKg).toBe('7.95')
    expect(v.costPerPortion).toBe('2.385')
    expect(v.expanded.ingredients).toBe('10.4')
    expect(v.subrecipeLines[0].sub.total).toBe('34')
  })

  it('l’elenco ricette mostra costi e completezza', async () => {
    const list = expectOk(await a.get('/api/recipes?sort=title'))
    const las = list.data.find((r: { code: string }) => r.code === 'LAS')
    expect(las.cost).toMatchObject({ complete: true, total: '19.08', costPerKg: '7.95' })
  })

  it('impedisce cicli diretti e indiretti, anche in modifica', async () => {
    const ragu = expectOk(await a.get(`/api/recipes/${ids.ragu}`))
    const rev = { ...raguRevision(), components: [...raguRevision().components, { kind: 'recipe', recipeId: ids.lasagna, quantity: '100', unit: 'g' }] }
    const r = await a.put(`/api/recipes/${ids.ragu}`, { code: 'RAGU', title: 'Ragù', status: 'active', lockVersion: ragu.lockVersion, revision: rev })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('cycle')
    expect(r.body.error.details.path).toEqual(['Ragù', 'Lasagna', 'Ragù'])
    const self = await a.put(`/api/recipes/${ids.ragu}`, {
      code: 'RAGU',
      title: 'Ragù',
      lockVersion: ragu.lockVersion,
      revision: { ...raguRevision(), components: [{ kind: 'recipe', recipeId: ids.ragu, quantity: '1', unit: 'kg' }] },
    })
    expect(self.status).toBe(409)
    // le opzioni per i semilavorati escludono la ricetta stessa e chi la contiene
    const opts = expectOk(await a.get(`/api/recipes/options?exclude=${ids.ragu}`))
    expect(opts.data.map((o: { code: string }) => o.code)).not.toContain('LAS')
  })

  it('snapshot, nuovo prezzo con propagazione indiretta, nuova valorizzazione e confronto', async () => {
    const las = expectOk(await a.get(`/api/recipes/${ids.lasagna}`))
    const snap = expectOk(await a.post(`/api/recipes/${ids.lasagna}/snapshots`, { label: 'Listino autunno', expectedRevisionId: las.revision.id }))
    expect(snap.total).toBe('19.08')

    // la carne passa da 8 a 9 €/kg: interessa il ragù e, indirettamente, la lasagna
    const price = expectOk(await a.post(`/api/ingredients/${ids.carne}/prices`, { packagePrice: '9', validFrom: T, source: 'Fattura fornitore' }))
    expect(price.affectedRecipes.map((r: { code: string }) => r.code).sort()).toEqual(['LAS', 'RAGU'])

    const after = expectOk(await a.get(`/api/recipes/${ids.lasagna}`))
    // ragù = 22 + 2 + 12 = 36 € → 7,20 €/kg → 600 g = 4,32 €
    expect(after.valuation.subrecipeLines[0].cost).toBe('4.32')
    expect(after.valuation.total).toBe('19.32')
    expect(after.comparison.snapshotTotal).toBe('19.08')
    expect(after.comparison.deltaTotal).toBe('0.24')
    expect(after.comparison.reasons.join(' ')).toMatch(/semilavorato Ragù/)

    // lo snapshot è immutabile
    const stored = expectOk(await a.get(`/api/snapshots/${snap.id}`))
    expect(stored.data.total).toBe('19.08')
    expect(stored.data.subrecipeLines[0].sub.ingredientLines[0].unitPrice).toBe('8')

    // la valorizzazione a una data passata usa i prezzi validi a quella data
    const past = expectOk(await a.get(`/api/recipes/${ids.lasagna}/valuation?date=2026-06-01`))
    expect(past.total).toBe('19.08')
  })

  it('una nuova revisione del ragù non altera lo snapshot storico della lasagna', async () => {
    const snaps = expectOk(await a.get(`/api/recipes/${ids.lasagna}`)).snapshots
    const snapId = snaps[0].id
    const ragu = expectOk(await a.get(`/api/recipes/${ids.ragu}`))
    const rev = raguRevision()
    rev.components[0]!.quantity = '2500'
    const saved = expectOk(await a.put(`/api/recipes/${ids.ragu}`, { code: 'RAGU', title: 'Ragù', status: 'active', lockVersion: ragu.lockVersion, revision: rev }))
    expect(saved.revisionNumber).toBe(2)
    expect(saved.affectedRecipes.map((r: { code: string }) => r.code)).toEqual(['LAS'])
    const stored = expectOk(await a.get(`/api/snapshots/${snapId}`))
    expect(stored.data.total).toBe('19.08')
    expect(stored.data.subrecipeLines[0].sub.revisionNumber).toBe(1)
    const now = expectOk(await a.get(`/api/recipes/${ids.lasagna}`))
    expect(now.valuation.subrecipeLines[0].sub.revisionNumber).toBe(2)
    // la revisione 1 resta consultabile
    const revs = expectOk(await a.get(`/api/recipes/${ids.ragu}/revisions`)).data
    expect(revs.map((r: { number: number }) => r.number)).toEqual([2, 1])
    const r1 = expectOk(await a.get(`/api/recipes/${ids.ragu}/revisions/${revs[1].id}`))
    expect(r1.components[0].quantity).toBe('2000.0000')
  })

  it('salvataggi concorrenti: la versione superata è respinta', async () => {
    const ragu = expectOk(await a.get(`/api/recipes/${ids.ragu}`))
    expectOk(await a.put(`/api/recipes/${ids.ragu}`, { code: 'RAGU', title: 'Ragù', lockVersion: ragu.lockVersion, revision: raguRevision() }))
    const stale = await a.put(`/api/recipes/${ids.ragu}`, { code: 'RAGU', title: 'Ragù', lockVersion: ragu.lockVersion, revision: raguRevision() })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('stale')
    const snap = await a.post(`/api/recipes/${ids.ragu}/snapshots`, { expectedRevisionId: ragu.revision.id })
    expect(snap.status).toBe(409)
  })
})

describe('Editor ricette', () => {
  it('bozza incompleta salvabile, con mancanze evidenziate e senza totale definitivo', async () => {
    const r = expectOk(
      await a.post('/api/recipes', {
        title: 'Torta in bozza',
        revision: { components: [{ kind: 'ingredient', ingredientId: ids.sfoglia, quantity: null, unit: 'g' }], labor: [{ employeeId: ids.mario, activeMinutes: null }] },
      }),
    )
    const v = expectOk(await a.get(`/api/recipes/${r.id}`)).valuation
    expect(v.complete).toBe(false)
    expect(v.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['invalid_quantity', 'invalid_minutes', 'missing_final_weight']))
    expect(v.costPerKg).toBeNull()
  })

  it('ingrediente creato al volo e inserito subito; anteprima autorevole senza salvare', async () => {
    const created = expectOk(
      await a.post('/api/ingredients', { name: 'Parmigiano', packageContent: '1', packageUnit: 'kg', usageUnit: 'g', initialPrice: { packagePrice: '20', validFrom: '2026-01-01' } }),
    )
    expect(created.code).toMatch(/^ING-\d{5}$/)
    const preview = expectOk(
      await a.post('/api/recipes/preview', {
        title: 'Prova',
        revision: { finalWeightKg: '0.5', components: [{ kind: 'ingredient', ingredientId: created.id, quantity: '150', unit: 'g' }, { kind: 'recipe', recipeId: ids.ragu, quantity: '500', unit: 'g' }] },
      }),
    )
    expect(preview.ingredientLines[0].cost).toBe('3')
    expect(preview.subrecipeLines[0].name).toBe('Ragù')
  })

  it('duplicazione: nuova identità, originale intatto, nessuno snapshot copiato', async () => {
    const dup = expectOk(await a.post(`/api/recipes/${ids.lasagna}/duplicate`))
    const copy = expectOk(await a.get(`/api/recipes/${dup.id}`))
    expect(copy.title).toBe('Copia di Lasagna')
    expect(copy.status).toBe('draft')
    expect(copy.snapshots).toHaveLength(0)
    expect(copy.revision.components).toHaveLength(2)
    const orig = expectOk(await a.get(`/api/recipes/${ids.lasagna}`))
    expect(orig.snapshots.length).toBeGreaterThan(0)
    expect(orig.code).toBe('LAS')
  })

  it('un ingrediente usato non può essere eliminato, solo archiviato; l’archiviazione non toglie costi', async () => {
    expect((await a.del(`/api/ingredients/${ids.sfoglia}`)).status).toBe(409)
    expectOk(await a.post(`/api/ingredients/${ids.sfoglia}/archive`))
    const v = expectOk(await a.get(`/api/recipes/${ids.lasagna}`)).valuation
    expect(v.complete).toBe(true)
    expectOk(await a.post(`/api/ingredients/${ids.sfoglia}/restore`))
  })
})

describe('Prezzi, utenze e strumenti', () => {
  it('prezzo con stessa data respinto; prezzo futuro non usato oggi', async () => {
    const dup = await a.post(`/api/ingredients/${ids.pomodoro}/prices`, { packagePrice: '5', validFrom: '2026-01-01' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('duplicate_price')
    expectOk(await a.post(`/api/ingredients/${ids.pomodoro}/prices`, { packagePrice: '50', validFrom: '2099-01-01' }))
    const detail = expectOk(await a.get(`/api/ingredients/${ids.pomodoro}`))
    expect(detail.currentPrice.package_price).toBe('5.000000')
    expect(detail.prices[0].future).toBe(true)
  })

  it('unità incompatibili richiedono densità o peso unitario', async () => {
    const r = await a.post('/api/ingredients', { name: 'Olio', packageContent: '1', packageUnit: 'l', usageUnit: 'g' })
    expect(r.status).toBe(422)
    expect(r.body.error.details.fields.densityKgPerL).toBeTruthy()
    expectOk(await a.post('/api/ingredients', { name: 'Olio', packageContent: '1', packageUnit: 'l', usageUnit: 'g', densityKgPerL: '0.92' }))
  })

  it('tariffa da bolletta: quote fisse incluse consapevolmente', async () => {
    const body = {
      mode: 'bill',
      validFrom: '2026-02-01',
      periodFrom: '2026-01-01',
      periodTo: '2026-01-31',
      consumption: '1000',
      consumptionUnit: 'kwh',
      vatBasis: 'net',
      components: [
        { label: 'Energia', amount: '250', kind: 'variable', include: true },
        { label: 'Quota fissa', amount: '50', kind: 'fixed', include: true },
      ],
    }
    const p = expectOk(await a.post('/api/tariffs/bill-preview', body))
    expect(p.pricePerUnit).toBe('0.3')
    expect(p.variableOnlyPricePerUnit).toBe('0.25')
    expect(p.includesFixed).toBe(true)
    const wrongUnit = await a.post(`/api/tariffs/${ids.luce}/versions`, { ...body, consumptionUnit: 'm3' })
    expect(wrongUnit.status).toBe(422)
    expectOk(await a.post(`/api/tariffs/${ids.luce}/versions`, body))
    const t = expectOk(await a.get(`/api/tariffs/${ids.luce}`))
    expect(t.versions).toHaveLength(2)
  })

  it('l’elettricità non può avere unità diversa da kWh', async () => {
    const r = await a.post('/api/tariffs', { name: 'Errata', kind: 'electricity', unit: 'm3' })
    expect(r.status).toBe(422)
  })

  it('gas in m³ con tariffa €/Smc senza coefficiente: avviso e costo incompleto', async () => {
    const gas = expectOk(await a.post('/api/tariffs', { name: 'Gas', kind: 'gas', unit: 'smc', firstVersion: { mode: 'direct', pricePerUnit: '1.2', validFrom: '2026-01-01' } }))
    const eq = expectOk(await a.post('/api/equipment', { name: 'Piastra', powerType: 'gas', gasMode: 'flow', gasFlowPerHour: '2', gasFlowUnit: 'm3', gasTariffId: gas.id }))
    expect(eq.warnings.join(' ')).toMatch(/coefficiente di conversione/)
    const r = expectOk(await a.post('/api/recipes', { title: 'Piastrata', revision: { equipmentUses: [{ equipmentId: eq.id, minutes: '15' }] } }))
    const v = expectOk(await a.get(`/api/recipes/${r.id}`)).valuation
    expect(v.complete).toBe(false)
    expect(v.issues.some((i: { code: string }) => i.code === 'gas_unit_mismatch')).toBe(true)
    // con il coefficiente configurato il costo diventa calcolabile
    const ver = expectOk(await a.post(`/api/tariffs/${gas.id}/versions`, { mode: 'direct', pricePerUnit: '1.2', validFrom: '2026-02-01', m3ToSmc: '1' }))
    expect(ver.affectedRecipes.map((x: { id: string }) => x.id)).toContain(r.id)
    const v2 = expectOk(await a.get(`/api/recipes/${r.id}`)).valuation
    expect(v2.complete).toBe(true)
    expect(v2.energy).toBe('0.6')
  })

  it('dashboard: conteggi e valorizzazioni incomplete', async () => {
    const dash = expectOk(await a.get('/api/dashboard'))
    expect(dash.counts.recipes.active).toBe(2)
    expect(dash.costs.incompleteCount).toBeGreaterThanOrEqual(1)
    expect(dash.costs.incomplete[0].issues.length).toBeGreaterThan(0)
  })
})
