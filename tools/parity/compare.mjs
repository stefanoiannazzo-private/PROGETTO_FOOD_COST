/**
 * Confronto differenziale tra l'API originale (Node) e l'API Laravel sugli stessi dati dimostrativi.
 * Uso: node tools/parity/compare.mjs http://127.0.0.1:4000 http://127.0.0.1:8000 <password>
 * Gli UUID e gli istanti sono sostituiti da segnaposto; le chiavi presenti solo in Laravel (novità) sono elencate a parte.
 */
const [A, B, PASSWORD] = process.argv.slice(2)
const NEW_KEYS = new Set(['assist', 'supplier', 'agent_name', 'extraMonthly'])

function client(base) {
  let cookie = ''
  return async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-requested-with': 'foodcost' } : {}), ...(cookie ? { cookie } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const set = res.headers.get('set-cookie')
    if (set && set.startsWith('fc_session=')) cookie = set.split(';')[0]
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json }
  }
}
const norm = (v) => {
  if (typeof v === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return '<uuid>'
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return '<ts>'
    return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  }
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
  return v
}
const extras = new Set()
function diff(a, b, path = '') {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: lunghezza ${a.length} ≠ ${b.length}`
    for (let i = 0; i < a.length; i++) { const r = diff(a[i], b[i], `${path}[${i}]`); if (r) return r }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of Object.keys(a)) { if (!(k in b)) return `${path}.${k}: assente in Laravel`; const r = diff(a[k], b[k], `${path}.${k}`); if (r) return r }
    for (const k of Object.keys(b)) if (!(k in a)) { if (NEW_KEYS.has(k)) extras.add(k); else return `${path}.${k}: solo in Laravel` }
    return null
  }
  return JSON.stringify(a) === JSON.stringify(b) ? null : `${path}: ${JSON.stringify(a)?.slice(0, 160)} ≠ ${JSON.stringify(b)?.slice(0, 160)}`
}

const a = client(A), b = client(B)
for (const c of [a, b]) await c('POST', '/auth/login', { email: 'admin@demo.local', password: PASSWORD })
async function ids(c) {
  const out = {}
  const add = (list, key, prefix) => { for (const x of list) out[`${prefix}:${x[key]}`] = x.id }
  add((await c('GET', '/recipes?pageSize=100')).json.data, 'code', 'R')
  add((await c('GET', '/ingredients?pageSize=100')).json.data, 'code', 'I')
  add((await c('GET', '/equipment?pageSize=100')).json.data, 'code', 'E')
  add((await c('GET', '/employees?pageSize=100')).json.data, 'code', 'D')
  add((await c('GET', '/tariffs')).json.data, 'name', 'T')
  const lasa = (await c('GET', `/recipes/${out['R:LASA']}`)).json
  out['S:first'] = lasa.snapshots[0]?.id
  out['REV:LASA'] = lasa.revision.id
  return out
}
const ia = await ids(a), ib = await ids(b)
const sub = (path, m) => path.replace(/\{([A-Z]+:[^}"]+)\}/g, (_, k) => m[k] ?? `{${k}}`)

const cases = [
  ['GET', '/auth/me'], ['GET', '/dashboard'], ['GET', '/users'], ['GET', '/users/catalog'],
  ['GET', '/recipes'], ['GET', '/recipes?sort=total&dir=desc'], ['GET', '/recipes?sort=perKg'], ['GET', '/recipes?completeness=incomplete'], ['GET', '/recipes?q=ragù'], ['GET', '/recipes?status=draft'],
  ['GET', '/recipes/categories'], ['GET', '/recipes/options'], ['GET', '/recipes/options?exclude={R:RAGU}'],
  ['GET', '/recipes/{R:LASA}'], ['GET', '/recipes/{R:RAGU}'], ['GET', '/recipes/{R:PEST}'], ['GET', '/recipes/{R:BESC}'],
  ['GET', '/recipes/{R:LASA}?date=2026-03-01'], ['GET', '/recipes/{R:LASA}/valuation'], ['GET', '/recipes/{R:LASA}/valuation?date=2026-08-01'],
  ['GET', '/recipes/{R:LASA}/revisions'], ['GET', '/recipes/{R:LASA}/revisions/{REV:LASA}'], ['GET', '/snapshots/{S:first}'],
  ['GET', '/ingredients'], ['GET', '/ingredients?price=missing'], ['GET', '/ingredients?price=zero'], ['GET', '/ingredients?sort=category&dir=desc'], ['GET', '/ingredients?q=lat&pageSize=3&page=2'],
  ['GET', '/ingredients/categories'], ['GET', '/ingredients/{I:CAR-MAC}'], ['GET', '/ingredients/{I:OLI-EVO}'], ['GET', '/ingredients/{I:ERB-BAS}'],
  ['GET', '/tariffs'], ['GET', '/tariffs?date=2026-03-01'], ['GET', '/tariffs/{T:Energia elettrica laboratorio}'], ['GET', '/tariffs/{T:Gas metano cucina}'],
  ['GET', '/equipment'], ['GET', '/equipment?powerType=electric'], ['GET', '/equipment/{E:FOR-01}'], ['GET', '/equipment/{E:FUO-01}'],
  ['GET', '/employees'], ['GET', '/employees/{D:DIP-001}'], ['GET', '/employees/{D:DIP-002}'],
  ['GET', '/imports'], ['GET', '/imports/fields/employees'],
  ['GET', '/recipes/00000000-0000-4000-8000-000000000000'], ['GET', '/recipes/non-un-uuid'], ['GET', '/ingredients?page=0'],
  ['POST', '/tariffs/bill-preview', { mode: 'bill', validFrom: '2026-07-01', periodFrom: '2026-05-01', periodTo: '2026-06-30', consumption: '1850', consumptionUnit: 'kwh', vatBasis: 'net', components: [{ label: 'Energia', amount: '412.30', kind: 'variable', include: true }, { label: 'Fissa', amount: '64.20', kind: 'fixed', include: true }] }],
  ['POST', '/tariffs/bill-preview', { mode: 'bill', validFrom: '2026-07-01', periodFrom: '2026-05-01', periodTo: '2026-06-30', consumption: '0', consumptionUnit: 'kwh', vatBasis: 'lordo', components: [] }],
  ['POST', '/employees/cost-preview', { validFrom: '2026-01-01', grossMonthly: '2400', contributionsMode: 'percent', contributionsValue: '30', productiveHours: '160' }],
  ['POST', '/employees/cost-preview', { validFrom: '2026-01-01', grossMonthly: '2.400', contributionsMode: 'none', contributionsValue: '5', productiveHours: '800' }],
  ['POST', '/recipes/preview', { title: 'Prova', revision: { finalWeightKg: '2', portions: '4', components: [{ kind: 'recipe', recipeId: '{R:RAGU}', quantity: '500', unit: 'g' }, { kind: 'ingredient', ingredientId: '{I:UOV-FRE}', quantity: '3', unit: 'pz' }, { kind: 'ingredient', ingredientId: '{I:OLI-EVO}', quantity: '20', unit: 'g' }], equipmentUses: [{ equipmentId: '{E:FUO-01}', minutes: '15', sharePercent: '33,3' }], labor: [{ employeeId: '{D:DIP-001}', activeMinutes: '7' }] } }],
  ['POST', '/recipes/preview', { revision: { components: [{ kind: 'ingredient', quantity: 'abc', unit: 'kg' }], equipmentUses: [{ equipmentId: 'x' }] } }],
  ['POST', '/ingredients', {}],
  ['POST', '/ingredients', { name: '  ', packageContent: '1.000', packageUnit: 'kg', usageUnit: 'ml' }],
  ['POST', '/ingredients', { name: 'X', packageContent: '1', packageUnit: 'kg', usageUnit: 'ml' }],
  ['POST', '/tariffs', { name: 'Luce', kind: 'electricity', unit: 'm3' }],
  ['POST', '/recipes', { title: 'Ciclo', revision: { components: [{ kind: 'recipe', quantity: '1', unit: 'kg' }] } }],
  ['PUT', '/recipes/{R:RAGU}', { code: 'RAGU', title: 'Ragù alla bolognese', lockVersion: 999, revision: {} }],
  ['PUT', '/recipes/{R:RAGU}', { code: 'RAGU', title: 'Ragù alla bolognese', lockVersion: 1, revision: { components: [{ kind: 'recipe', recipeId: '{R:LASA}', quantity: '1', unit: 'kg' }] } }],
  ['POST', '/recipes/{R:LASA}/snapshots', { expectedRevisionId: '00000000-0000-4000-8000-000000000000' }],
  ['POST', '/auth/company', { companyId: '00000000-0000-4000-8000-000000000000' }],
  ['DELETE', '/ingredients/{I:CAR-MAC}'], ['DELETE', '/recipes/{R:RAGU}'], ['DELETE', '/equipment/{E:FOR-01}'],
]
let ok = 0, ko = 0
for (const [m, p, body] of cases) {
  const bodyA = body === undefined ? undefined : JSON.parse(sub(JSON.stringify(body), ia))
  const bodyB = body === undefined ? undefined : JSON.parse(sub(JSON.stringify(body), ib))
  const ra = await a(m, sub(p, ia), bodyA), rb = await b(m, sub(p, ib), bodyB)
  const d = ra.status !== rb.status ? `stato ${ra.status} ≠ ${rb.status} — ${JSON.stringify(ra.json).slice(0, 200)} | ${JSON.stringify(rb.json).slice(0, 200)}` : diff(norm(ra.json), norm(rb.json))
  if (d) { ko++; console.log(`✗ ${m} ${p}\n    ${d}`) } else ok++
}
// CSRF
for (const c of [[a, 'orig'], [b, 'laravel']]) { const r = await c[0]('POST', '/auth/logout', {}, { 'x-requested-with': '' }); console.log(`csrf ${c[1]}: ${r.status} ${JSON.stringify(r.json)}`) }
console.log(`\nIdentici: ${ok}  Diversi: ${ko}  Chiavi nuove solo in Laravel: ${[...extras].join(', ') || 'nessuna'}`)
