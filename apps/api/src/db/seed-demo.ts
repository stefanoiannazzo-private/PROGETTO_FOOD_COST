/**
 * Dati dimostrativi SINTETICI per lo sviluppo locale.
 * Uso:  npm run seed:demo -- --password "una-password-locale"
 * Crea l'azienda "Trattoria Demo" con utenti, anagrafiche e le ricette ragù → lasagna.
 * Non usare in produzione: si rifiuta di partire con NODE_ENV=production.
 */
import { randomBytes } from 'node:crypto'
import { loadEnv } from '../env'
import { connect } from './connection'
import { migrate } from './migrate'
import { buildApp } from '../app'
import { hashPassword } from '../auth/crypto'

loadEnv()
process.env.LOG_LEVEL ??= 'warn'
if (process.env.NODE_ENV === 'production') {
  console.error('Il seed dimostrativo non può essere eseguito in produzione.')
  process.exit(1)
}
const argPw = process.argv.indexOf('--password')
const password = (argPw > 0 ? process.argv[argPw + 1] : undefined) ?? process.env.DEMO_PASSWORD ?? randomBytes(9).toString('base64url')
if (password.length < 10) {
  console.error('La password deve avere almeno 10 caratteri.')
  process.exit(1)
}

const database = await connect()
await migrate(database)
const db = database.db
const existing = await db.selectFrom('companies').select('id').where('name', '=', 'Trattoria Demo').executeTakeFirst()
if (existing) {
  console.log('Dati dimostrativi già presenti (azienda "Trattoria Demo"). Nulla da fare.')
  await database.close()
  process.exit(0)
}

const app = await buildApp(database, { loginRateLimit: 1000 })
let cookie = ''
async function call<T = any>(method: string, url: string, payload?: unknown): Promise<T> {
  const res = await app.inject({ method: method as 'POST', url: `/api${url}`, payload: payload as object, headers: { cookie, 'x-requested-with': 'foodcost' } })
  const set = res.headers['set-cookie']
  const first = Array.isArray(set) ? set[0] : set
  if (first?.startsWith('fc_session=')) cookie = first.split(';')[0]!
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`)
  return res.json() as T
}

const hash = await hashPassword(password)
const mk = async (email: string, name: string, admin = false) =>
  (await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()) ??
  (await db.insertInto('users').values({ email, name, password_hash: hash, is_platform_admin: admin }).returning('id').executeTakeFirstOrThrow())

const company = await db.insertInto('companies').values({ name: 'Trattoria Demo' }).returning('id').executeTakeFirstOrThrow()
const users = [
  { email: 'admin@demo.local', name: 'Anna Amministratrice', role: 'admin' as const, platform: true },
  { email: 'responsabile@demo.local', name: 'Roberto Responsabile', role: 'manager' as const },
  { email: 'operatore@demo.local', name: 'Olga Operatrice', role: 'operator' as const },
]
for (const u of users) {
  const row = await mk(u.email, u.name, u.platform)
  await db.insertInto('memberships').values({ company_id: company.id, user_id: row.id, role: u.role }).execute()
}
await call('POST', '/auth/login', { email: 'admin@demo.local', password })

const date = '2026-01-01'
const ing = async (code: string, name: string, category: string, content: string, unit: string, usage: string, price: string | null, extra: object = {}) =>
  (
    await call<{ id: string }>('POST', '/ingredients', {
      code,
      name,
      category,
      supplier: 'Fornitore dimostrativo',
      packageContent: content,
      packageUnit: unit,
      usageUnit: usage,
      ...(price !== null ? { initialPrice: { packagePrice: price, validFrom: date, source: 'Listino dimostrativo' } } : {}),
      ...extra,
    })
  ).id

const I = {
  carne: await ing('CAR-MAC', 'Carne macinata mista', 'Carni', '1', 'kg', 'g', '9.80'),
  pomodoro: await ing('POM-PEL', 'Pomodori pelati', 'Conserve', '2.5', 'kg', 'g', '4.50'),
  cipolla: await ing('VER-CIP', 'Cipolle', 'Verdure', '5', 'kg', 'g', '6.00', { edibleYieldPercent: '85' }),
  carota: await ing('VER-CAR', 'Carote', 'Verdure', '5', 'kg', 'g', '5.50', { edibleYieldPercent: '80' }),
  sedano: await ing('VER-SED', 'Sedano', 'Verdure', '1', 'kg', 'g', '2.20', { edibleYieldPercent: '70' }),
  olio: await ing('OLI-EVO', 'Olio extravergine di oliva', 'Condimenti', '5', 'l', 'ml', '42.00', { densityKgPerL: '0.916' }),
  vino: await ing('VIN-ROS', 'Vino rosso da cucina', 'Bevande', '0.75', 'l', 'ml', '3.90'),
  latte: await ing('LAT-INT', 'Latte intero', 'Latticini', '1', 'l', 'ml', '1.35'),
  burro: await ing('LAT-BUR', 'Burro', 'Latticini', '1', 'kg', 'g', '11.50'),
  farina: await ing('FAR-00', 'Farina 00', 'Farine', '25', 'kg', 'g', '19.00'),
  noce: await ing('SPE-NOC', 'Noce moscata', 'Spezie', '50', 'g', 'g', '3.20'),
  sfoglia: await ing('PAS-SFO', 'Sfoglia fresca all’uovo', 'Pasta', '1', 'kg', 'g', '7.80'),
  parmigiano: await ing('LAT-PAR', 'Parmigiano Reggiano 24 mesi', 'Latticini', '1', 'kg', 'g', '21.00'),
  uova: await ing('UOV-FRE', 'Uova fresche', 'Uova', '30', 'pz', 'pz', '9.60', { unitWeightKg: '0.06' }),
  sale: await ing('SPE-SAL', 'Sale fino', 'Spezie', '1', 'kg', 'g', '0'),
  basilico: await ing('ERB-BAS', 'Basilico fresco', 'Erbe', '100', 'g', 'g', null),
}

const luce = await call<{ id: string }>('POST', '/tariffs', { name: 'Energia elettrica laboratorio', kind: 'electricity', unit: 'kwh', firstVersion: { mode: 'direct', pricePerUnit: '0.28', validFrom: date } })
await call('POST', `/tariffs/${luce.id}/versions`, {
  mode: 'bill',
  validFrom: '2026-07-01',
  periodFrom: '2026-05-01',
  periodTo: '2026-06-30',
  consumption: '1850',
  consumptionUnit: 'kwh',
  vatBasis: 'net',
  components: [
    { label: 'Spesa per la materia energia', amount: '412.30', kind: 'variable', include: true },
    { label: 'Trasporto e oneri di sistema variabili', amount: '128.75', kind: 'variable', include: true },
    { label: 'Quota fissa e quota potenza', amount: '64.20', kind: 'fixed', include: false },
  ],
})
const gas = await call<{ id: string }>('POST', '/tariffs', { name: 'Gas metano cucina', kind: 'gas', unit: 'smc', firstVersion: { mode: 'direct', pricePerUnit: '1.15', validFrom: date, m3ToSmc: '0.9667', smcToKwh: '10.69' } })

const E = {
  forno: (await call<{ id: string }>('POST', '/equipment', { code: 'FOR-01', name: 'Forno combinato 10 teglie', category: 'Forni', powerType: 'electric', capacity: '10 GN 1/1', electricPowerKw: '18', usageCoefficient: '0.55', preheatCoefficient: '0.95', holdCoefficient: '0.3', electricTariffId: luce.id })).id,
  fornello: (await call<{ id: string }>('POST', '/equipment', { code: 'FUO-01', name: 'Fuochi a gas 6 bruciatori', category: 'Fuochi', powerType: 'gas', gasMode: 'flow', gasFlowPerHour: '0.9', gasFlowUnit: 'm3', gasLoadFactor: '0.6', gasTariffId: gas.id })).id,
  planetaria: (await call<{ id: string }>('POST', '/equipment', { code: 'PLA-01', name: 'Planetaria 20 l', category: 'Impastatrici', powerType: 'electric', electricPowerKw: '1.1', usageCoefficient: '0.7', electricTariffId: luce.id })).id,
  abbattitore: (await call<{ id: string }>('POST', '/equipment', { code: 'ABB-01', name: 'Abbattitore di temperatura', category: 'Freddo', powerType: 'electric', electricPowerKw: '2.4', usageCoefficient: '0.8', electricTariffId: luce.id })).id,
  mattarello: (await call<{ id: string }>('POST', '/equipment', { code: 'MAN-01', name: 'Teglie e utensili manuali', category: 'Manuali', powerType: 'manual' })).id,
}

const P = {
  cuoco: (await call<{ id: string }>('POST', '/employees', { code: 'DIP-001', firstName: 'Marco', lastName: 'Bianchi', jobTitle: 'Capo cuoco', firstCost: { validFrom: date, grossMonthly: '2600', contributionsMode: 'percent', contributionsValue: '32', otherMonthlyCosts: '120', productiveHours: '150' } })).id,
  aiuto: (await call<{ id: string }>('POST', '/employees', { code: 'DIP-002', firstName: 'Giulia', lastName: 'Verdi', jobTitle: 'Aiuto cuoco', firstCost: { validFrom: date, grossMonthly: '1750', contributionsMode: 'none', productiveHours: '160' } })).id,
}

const ragu = await call<{ id: string }>('POST', '/recipes', {
  code: 'RAGU',
  title: 'Ragù alla bolognese',
  category: 'Sughi',
  status: 'active',
  description: 'Base per lasagne e primi piatti.',
  revision: {
    finalQuantity: '5',
    finalUnit: 'kg',
    finalWeightKg: '5',
    declaredDurationMinutes: '210',
    yieldNotes: 'Cottura lenta: evaporazione circa 30%.',
    instructions: 'Soffriggere le verdure nell’olio, rosolare la carne, sfumare con il vino, aggiungere il pomodoro e cuocere a fuoco basso per 3 ore. Abbattere e porzionare.',
    phases: [
      { key: 'p1', name: 'Mondatura e soffritto' },
      { key: 'p2', name: 'Cottura lenta' },
      { key: 'p3', name: 'Abbattimento' },
    ],
    components: [
      { kind: 'ingredient', ingredientId: I.carne, quantity: '2500', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.pomodoro, quantity: '3000', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.cipolla, quantity: '300', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.carota, quantity: '300', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.sedano, quantity: '200', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.olio, quantity: '150', unit: 'ml' },
      { kind: 'ingredient', ingredientId: I.vino, quantity: '375', unit: 'ml' },
      { kind: 'ingredient', ingredientId: I.sale, quantity: '40', unit: 'g' },
    ],
    equipmentUses: [
      { phaseKey: 'p1', equipmentId: E.fornello, segment: 'work', minutes: '30', sharePercent: '100' },
      { phaseKey: 'p2', equipmentId: E.fornello, segment: 'hold', minutes: '180', sharePercent: '50', note: 'Fuoco condiviso con il brodo' },
      { phaseKey: 'p3', equipmentId: E.abbattitore, segment: 'work', minutes: '90', sharePercent: '100' },
    ],
    labor: [
      { phaseKey: 'p1', employeeId: P.aiuto, activeMinutes: '35' },
      { phaseKey: 'p1', employeeId: P.cuoco, activeMinutes: '15' },
      { phaseKey: 'p2', employeeId: P.cuoco, activeMinutes: '20' },
      { phaseKey: 'p3', employeeId: P.aiuto, activeMinutes: '10' },
    ],
  },
})

const besciamella = await call<{ id: string }>('POST', '/recipes', {
  code: 'BESC',
  title: 'Besciamella',
  category: 'Salse',
  status: 'active',
  revision: {
    finalQuantity: '2.2',
    finalUnit: 'kg',
    finalWeightKg: '2.2',
    declaredDurationMinutes: '25',
    components: [
      { kind: 'ingredient', ingredientId: I.latte, quantity: '2', unit: 'l' },
      { kind: 'ingredient', ingredientId: I.burro, quantity: '120', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.farina, quantity: '120', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.noce, quantity: '2', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.sale, quantity: '10', unit: 'g' },
    ],
    equipmentUses: [{ equipmentId: E.fornello, segment: 'work', minutes: '20' }],
    labor: [{ employeeId: P.aiuto, activeMinutes: '20' }],
  },
})

const lasagna = await call<{ id: string }>('POST', '/recipes', {
  code: 'LASA',
  title: 'Lasagna alla bolognese',
  category: 'Primi',
  status: 'active',
  description: 'Teglia da 12 porzioni.',
  revision: {
    finalQuantity: '1',
    finalUnit: 'pz',
    finalWeightKg: '3.6',
    portions: '12',
    declaredDurationMinutes: '75',
    phases: [
      { key: 'a', name: 'Assemblaggio' },
      { key: 'b', name: 'Cottura in forno' },
    ],
    components: [
      { kind: 'recipe', recipeId: ragu.id, quantity: '1400', unit: 'g' },
      { kind: 'recipe', recipeId: besciamella.id, quantity: '900', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.sfoglia, quantity: '750', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.parmigiano, quantity: '180', unit: 'g' },
      { kind: 'ingredient', ingredientId: I.burro, quantity: '30', unit: 'g' },
    ],
    equipmentUses: [
      { phaseKey: 'a', equipmentId: E.mattarello, segment: 'work', minutes: '20' },
      { phaseKey: 'b', equipmentId: E.forno, segment: 'preheat', minutes: '15', sharePercent: '50' },
      { phaseKey: 'b', equipmentId: E.forno, segment: 'work', minutes: '40', sharePercent: '50', note: 'Forno condiviso con un’altra teglia' },
    ],
    labor: [
      { phaseKey: 'a', employeeId: P.aiuto, activeMinutes: '25' },
      { phaseKey: 'b', employeeId: P.cuoco, activeMinutes: '5' },
    ],
  },
})

// una ricetta in bozza, volutamente incompleta, per vedere le segnalazioni
await call('POST', '/recipes', {
  code: 'PEST',
  title: 'Pesto al basilico (bozza)',
  category: 'Salse',
  revision: { components: [{ kind: 'ingredient', ingredientId: I.basilico, quantity: '200', unit: 'g' }, { kind: 'ingredient', ingredientId: I.olio, quantity: null, unit: 'ml' }] },
})

const detail = await call<{ revision: { id: string }; valuation: { total: string; costPerKg: string; costPerPortion: string } }>('GET', `/recipes/${lasagna.id}`)
await call('POST', `/recipes/${lasagna.id}/snapshots`, { label: 'Listino autunno 2026', expectedRevisionId: detail.revision.id })

console.log('\nDati dimostrativi creati (azienda "Trattoria Demo").')
const r2 = (v: string) => Number(v).toFixed(2).replace('.', ',')
console.log(`Lasagna: ${r2(detail.valuation.total)} € a teglia, ${r2(detail.valuation.costPerKg)} €/kg, ${r2(detail.valuation.costPerPortion)} €/porzione.\n`)
console.log('Accessi locali (stessa password per tutti):')
for (const u of users) console.log(`  ${u.role.padEnd(9)} ${u.email}`)
if (argPw < 0 && !process.env.DEMO_PASSWORD) console.log(`  password generata: ${password}`)
await app.close()
await database.close()
