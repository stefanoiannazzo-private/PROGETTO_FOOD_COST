import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/crypto'
import { addMember, Client, createCompany, createUser, expectOk, loginAs, PASSWORD, setup, teardown, type TestEnv } from './helpers'

let env: TestEnv
let companyA: string
let companyB: string

beforeAll(async () => {
  env = await setup()
  companyA = await createCompany(env, 'Trattoria A')
  companyB = await createCompany(env, 'Pasticceria B')
  await addMember(env, companyA, await createUser(env, 'admin.a@example.test', 'Admin A'), 'admin')
  await addMember(env, companyA, await createUser(env, 'resp.a@example.test', 'Responsabile A'), 'manager')
  await addMember(env, companyA, await createUser(env, 'op.a@example.test', 'Operatore A'), 'operator')
  await addMember(env, companyB, await createUser(env, 'admin.b@example.test', 'Admin B'), 'admin')
  const multi = await createUser(env, 'multi@example.test', 'Consulente')
  await addMember(env, companyA, multi, 'manager')
  await addMember(env, companyB, multi, 'operator')
})
afterAll(() => teardown(env))

describe('Autenticazione', () => {
  it('rifiuta credenziali errate con messaggio generico', async () => {
    const c = new Client(env.app)
    const r = await c.post('/api/auth/login', { email: 'admin.a@example.test', password: 'sbagliata' })
    expect(r.status).toBe(401)
    expect(r.body.error.message).toBe('Email o password non corrette.')
    const r2 = await c.post('/api/auth/login', { email: 'nessuno@example.test', password: 'sbagliata' })
    expect(r2.body.error.message).toBe(r.body.error.message)
  })

  it('login, profilo e logout', async () => {
    const c = await loginAs(env, 'admin.a@example.test')
    const me = expectOk(await c.get('/api/auth/me'))
    expect(me.company.name).toBe('Trattoria A')
    expect(me.permissions).toContain('salaries.read')
    expectOk(await c.post('/api/auth/logout'))
    c.cookie = c.cookie || ''
    expect((await c.get('/api/auth/me')).status).toBe(401)
  })

  it('limita i tentativi di login', async () => {
    const strict = await setup({ loginRateLimit: 3 })
    const c = new Client(strict.app)
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/login', { email: 'x@example.test', password: 'y' })).status)
    expect(codes).toEqual([401, 401, 401, 429, 429])
    await teardown(strict)
  })

  it('le richieste che modificano dati senza header CSRF o da origini estranee sono respinte', async () => {
    const c = await loginAs(env, 'admin.a@example.test')
    expect((await c.request('POST', '/api/ingredients', { name: 'X' }, { csrf: false })).status).toBe(403)
    expect((await c.request('POST', '/api/ingredients', { name: 'X' }, { origin: 'https://sito-malevolo.example' })).status).toBe(403)
  })

  it('utente con più aziende deve selezionare esplicitamente quella attiva', async () => {
    const c = await loginAs(env, 'multi@example.test')
    const me = expectOk(await c.get('/api/auth/me'))
    expect(me.company).toBeNull()
    expect(me.companies).toHaveLength(2)
    expect((await c.get('/api/ingredients')).status).toBe(409)
    expectOk(await c.post('/api/auth/company', { companyId: companyB }))
    const me2 = expectOk(await c.get('/api/auth/me'))
    expect(me2.company.id).toBe(companyB)
    expect(me2.role).toBe('operator')
  })

  it('non si può selezionare un’azienda di cui non si è membri', async () => {
    const c = await loginAs(env, 'admin.a@example.test')
    expect((await c.post('/api/auth/company', { companyId: companyB })).status).toBe(403)
  })

  it('recupero password: link valido una sola volta, chiude le sessioni', async () => {
    const anon = new Client(env.app)
    const r = expectOk(await anon.post('/api/auth/password/forgot', { email: 'op.a@example.test' }))
    const token = new URL(r.devLink).searchParams.get('token')!
    const unknown = expectOk(await anon.post('/api/auth/password/forgot', { email: 'sconosciuto@example.test' }))
    expect(unknown.message).toBe(r.message)
    expect((await anon.post('/api/auth/password/reset', { token, password: 'corta' })).status).toBe(422)
    expectOk(await anon.post('/api/auth/password/reset', { token, password: 'Nuova-password-sicura' }))
    expect((await anon.post('/api/auth/password/reset', { token, password: 'Altra-password-sicura' })).status).toBe(422)
    const login = await new Client(env.app).post('/api/auth/login', { email: 'op.a@example.test', password: 'Nuova-password-sicura' })
    expect(login.status).toBe(200)
    // ripristino per gli altri test
    await env.database.db.updateTable('users').set({ password_hash: await hashPassword(PASSWORD) }).where('email', '=', 'op.a@example.test').execute()
  })
})

describe('Utenti, inviti e ruoli', () => {
  it('invito → accettazione → membership con ruolo; modifica ruolo e disattivazione', async () => {
    const admin = await loginAs(env, 'admin.a@example.test')
    const inv = expectOk(await admin.post('/api/users/invitations', { email: 'nuovo@example.test', name: 'Nuovo Cuoco', role: 'operator', extraPermissions: ['costs.read'] }))
    expect(inv.mail).toBe('outbox')
    const token = new URL(inv.inviteLink).searchParams.get('token')!
    const anon = new Client(env.app)
    const info = expectOk(await anon.get(`/api/auth/invitations/${token}`))
    expect(info.company).toBe('Trattoria A')
    expect(info.existingUser).toBe(false)
    const me = expectOk(await anon.post('/api/auth/invitations/accept', { token, password: 'Password-nuovo-1' }))
    expect(me.role).toBe('operator')
    expect(me.permissions).toContain('costs.read')

    const list = expectOk(await admin.get('/api/users'))
    const m = list.data.find((u: { email: string }) => u.email === 'nuovo@example.test')
    expectOk(await admin.patch(`/api/users/${m.id}`, { role: 'manager' }))
    expectOk(await admin.patch(`/api/users/${m.id}`, { isActive: false }))
    // la sessione dell'utente disattivato non vale più per l'azienda
    expect((await anon.get('/api/ingredients')).status).toBe(401)
  })

  it('non si può rimuovere l’ultimo amministratore', async () => {
    const admin = await loginAs(env, 'admin.b@example.test')
    const list = expectOk(await admin.get('/api/users'))
    const self = list.data.find((u: { isSelf: boolean }) => u.isSelf)
    const r = await admin.patch(`/api/users/${self.id}`, { role: 'manager' })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('last_admin')
  })

  it('solo gli amministratori gestiscono gli utenti', async () => {
    const manager = await loginAs(env, 'resp.a@example.test')
    expect((await manager.get('/api/users')).status).toBe(403)
    expect((await manager.post('/api/users/invitations', { email: 'x@example.test', name: 'X Y', role: 'admin' })).status).toBe(403)
  })
})

describe('Isolamento tra aziende', () => {
  let ingA: string
  let recipeA: string

  beforeAll(async () => {
    const a = await loginAs(env, 'admin.a@example.test')
    ingA = expectOk(await a.post('/api/ingredients', { code: 'FAR', name: 'Farina 00', packageContent: 25, packageUnit: 'kg', usageUnit: 'g', initialPrice: { packagePrice: '20', validFrom: '2026-01-01' } })).id
    recipeA = expectOk(await a.post('/api/recipes', { title: 'Pane', revision: { components: [{ kind: 'ingredient', ingredientId: ingA, quantity: '1', unit: 'kg' }] } })).id
  })

  it('B non vede né modifica ingredienti e ricette di A, nemmeno conoscendo gli ID', async () => {
    const b = await loginAs(env, 'admin.b@example.test')
    expect((await b.get(`/api/ingredients/${ingA}`)).status).toBe(404)
    expect((await b.get(`/api/recipes/${recipeA}`)).status).toBe(404)
    expect((await b.patch(`/api/ingredients/${ingA}`, { code: 'FAR', name: 'Hack', packageContent: 1, packageUnit: 'kg', usageUnit: 'g', lockVersion: 1 })).status).toBe(404)
    expect((await b.post(`/api/ingredients/${ingA}/prices`, { packagePrice: '1', validFrom: '2026-02-01' })).status).toBe(404)
    expect((await b.post(`/api/recipes/${recipeA}/snapshots`, { expectedRevisionId: recipeA })).status).toBe(404)
    const list = expectOk(await b.get('/api/ingredients'))
    expect(list.data).toHaveLength(0)
  })

  it('B non può usare ingredienti o ricette di A nelle proprie ricette', async () => {
    const b = await loginAs(env, 'admin.b@example.test')
    const r1 = await b.post('/api/recipes', { title: 'Furto', revision: { components: [{ kind: 'ingredient', ingredientId: ingA, quantity: '1', unit: 'kg' }] } })
    expect(r1.status).toBe(422)
    expect(r1.body.error.code).toBe('invalid_reference')
    const r2 = await b.post('/api/recipes', { title: 'Furto 2', revision: { components: [{ kind: 'recipe', recipeId: recipeA, quantity: '1', unit: 'kg' }] } })
    expect(r2.status).toBe(422)
    const preview = await b.post('/api/recipes/preview', { recipeId: recipeA, revision: {} })
    expect(preview.status).toBe(404)
  })
})

describe('Permessi su costi e retribuzioni', () => {
  let employeeId: string
  let recipeId: string

  beforeAll(async () => {
    const a = await loginAs(env, 'admin.a@example.test')
    const emp = expectOk(
      await a.post('/api/employees', {
        code: 'D1',
        firstName: 'Mario',
        lastName: 'Rossi',
        jobTitle: 'Cuoco',
        firstCost: { validFrom: '2026-01-01', grossMonthly: '2400', contributionsMode: 'none', productiveHours: '160' },
      }),
    )
    employeeId = emp.id
    recipeId = expectOk(await a.post('/api/recipes', { title: 'Brodo', revision: { finalWeightKg: '1', labor: [{ employeeId, activeMinutes: '12', sharePercent: '100' }] } })).id
  })

  it('l’amministratore vede retribuzioni e costo nominativo', async () => {
    const a = await loginAs(env, 'admin.a@example.test')
    const list = expectOk(await a.get('/api/employees'))
    expect(list.data[0].cost.costPerMinute).toBe('0.25')
    const r = expectOk(await a.get(`/api/recipes/${recipeId}`))
    expect(r.valuation.laborLines[0].cost).toBe('3')
    expect(r.valuation.labor).toBe('3')
  })

  it('il responsabile non riceve retribuzioni nel payload, ma vede il costo aggregato', async () => {
    const m = await loginAs(env, 'resp.a@example.test')
    const list = expectOk(await m.get('/api/employees'))
    expect(list.data[0].name).toBe('Mario Rossi')
    expect(list.data[0]).not.toHaveProperty('cost')
    expect(JSON.stringify(list)).not.toContain('2400')
    const detail = expectOk(await m.get(`/api/employees/${employeeId}`))
    expect(detail).not.toHaveProperty('costs')
    const r = expectOk(await m.get(`/api/recipes/${recipeId}`))
    expect(r.valuation.labor).toBe('3')
    expect(r.valuation.laborLines[0].cost).toBeNull()
    expect(r.valuation.laborLines[0].costPerMinute).toBeNull()
    expect((await m.post(`/api/employees/${employeeId}/costs`, { validFrom: '2026-03-01', grossMonthly: '1', contributionsMode: 'none', productiveHours: '1' })).status).toBe(403)
  })

  it('l’operatore non vede costi né prezzi, ma consulta le ricette', async () => {
    const o = await loginAs(env, 'op.a@example.test')
    const r = expectOk(await o.get(`/api/recipes/${recipeId}`))
    expect(r.valuation).toBeNull()
    expect(r.revision.labor).toHaveLength(1)
    const ings = expectOk(await o.get('/api/ingredients'))
    expect(ings.data[0].price).toBeNull()
    expect((await o.get('/api/employees')).status).toBe(404)
    expect((await o.post('/api/recipes', { title: 'X', revision: {} })).status).toBe(403)
  })

  it('l’API accetta solo numeri normalizzati: i separatori delle migliaia sono rifiutati', async () => {
    const a = await loginAs(env, 'admin.a@example.test')
    for (const bad of ['2.400,00', '1.234.567', '2 400', '€ 2400']) {
      const r = await a.post(`/api/employees/${employeeId}/costs`, { validFrom: '2026-05-01', grossMonthly: bad, contributionsMode: 'none', productiveHours: '160' })
      expect(r.status).toBe(422)
    }
    const r = await a.post(`/api/employees/${employeeId}/costs`, { validFrom: '2026-05-01', grossMonthly: '2.400,00', contributionsMode: 'none', productiveHours: '160' })
    expect(r.body.error.details.fields.grossMonthly).toMatch(/non è un numero valido/)
    const ok = await a.post(`/api/employees/${employeeId}/costs`, { validFrom: '2026-05-01', grossMonthly: '2400,50', contributionsMode: 'none', productiveHours: '160' })
    expect(ok.status).toBe(200)
  })

  it('l’audit non contiene importi retributivi', async () => {
    const rows = await env.database.db.selectFrom('audit_logs').select('details').where('entity_type', '=', 'employee_cost').execute()
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toContain('2400')
  })
})
