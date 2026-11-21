/**
 * Confronto differenziale delle AZIONI (scritture) tra API originale e API Laravel.
 * Stessa sequenza di operazioni su entrambe, partendo dagli stessi dati dimostrativi appena caricati;
 * a ogni passo si confrontano codice HTTP e risposta (UUID, istanti e token sostituiti da segnaposto).
 * Uso: node tools/parity/actions.mjs http://127.0.0.1:4000 http://127.0.0.1:8000 <password-demo>
 */
const [A, B, PASSWORD] = process.argv.slice(2)
const NEW_KEYS = new Set(['assist', 'supplier', 'agent_name', 'extraMonthly'])

function client(base) {
  let cookie = ''
  const c = async (method, path, body) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-requested-with': 'foodcost' } : {}), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const set = res.headers.get('set-cookie')
    if (set && set.startsWith('fc_session=')) cookie = set.split(';')[0]
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json }
  }
  c.reset = () => { cookie = '' }
  return c
}
const norm = (v) => {
  if (typeof v === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return '<uuid>'
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return '<ts>'
    return v.replace(/token=[A-Za-z0-9_-]+/g, 'token=<tok>').replace(/https?:\/\/[^/\s]+/g, '<url>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  }
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
  return v
}
function diff(a, b, path = '') {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: lunghezza ${a.length} ≠ ${b.length}`
    for (let i = 0; i < a.length; i++) { const r = diff(a[i], b[i], `${path}[${i}]`); if (r) return r }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of Object.keys(a)) { if (!(k in b)) return `${path}.${k}: assente in Laravel`; const r = diff(a[k], b[k], `${path}.${k}`); if (r) return r }
    for (const k of Object.keys(b)) if (!(k in a) && !NEW_KEYS.has(k)) return `${path}.${k}: solo in Laravel`
    return null
  }
  return JSON.stringify(a) === JSON.stringify(b) ? null : `${path}: ${JSON.stringify(a)?.slice(0, 160)} ≠ ${JSON.stringify(b)?.slice(0, 160)}`
}

const sides = [{ c: client(A), anon: client(A), ids: {} }, { c: client(B), anon: client(B), ids: {} }]
async function loadIds(s) {
  const add = (list, key, prefix) => { for (const x of list) s.ids[`${prefix}:${x[key]}`] = x.id }
  add((await s.c('GET', '/recipes?pageSize=100')).json.data, 'code', 'R')
  add((await s.c('GET', '/ingredients?pageSize=100')).json.data, 'code', 'I')
  add((await s.c('GET', '/equipment?pageSize=100&archived=all')).json.data, 'code', 'E')
  add((await s.c('GET', '/employees?archived=all')).json.data, 'code', 'D')
  add((await s.c('GET', '/tariffs?archived=all')).json.data, 'name', 'T')
}
const sub = (x, ids) => JSON.parse(JSON.stringify(x).replace(/\{([A-Z]+:[^}"]+)\}/g, (_, k) => ids[k] ?? `{${k}}`))
let same = 0, different = 0
async function step(label, method, path, body, { anon = false, keep } = {}) {
  const res = []
  for (const s of sides) {
    const r = await (anon ? s.anon : s.c)(method, sub(path, s.ids), body === undefined ? undefined : sub(body, s.ids))
    if (keep) keep(s, r.json)
    res.push(r)
  }
  const d = res[0].status !== res[1].status ? `status ${res[0].status} ≠ ${res[1].status}` : diff(norm(res[0].json), norm(res[1].json))
  if (d) { different++; console.log(`✗ ${label} — ${method} ${path}\n    ${d}`) } else { same++; console.log(`✓ ${label} (${res[0].status})`) }
}

for (const s of sides) { await s.c('POST', '/auth/login', { email: 'admin@demo.local', password: PASSWORD }); await loadIds(s) }

// azienda corrente
await step('rinomina azienda: nome troppo corto', 'PATCH', '/companies/current', { name: 'X' })
await step('rinomina azienda', 'PATCH', '/companies/current', { name: 'Trattoria Demo Rinominata' })
await step('profilo dopo la rinomina', 'GET', '/auth/me')
// strumenti
await step('archivia strumento', 'POST', '/equipment/{E:FOR-01}/archive')
await step('elenco strumenti archiviati', 'GET', '/equipment?archived=1')
await step('ripristina strumento', 'POST', '/equipment/{E:FOR-01}/restore')
await step('nuovo strumento manuale', 'POST', '/equipment', { name: 'Mattarello prova', powerType: 'manual' }, { keep: (s, j) => (s.ids['E:new'] = j.id) })
await step('elimina strumento mai usato', 'DELETE', '/equipment/{E:new}')
await step('elimina strumento usato', 'DELETE', '/equipment/{E:FOR-01}')
await step('strumento con tariffa di tipo sbagliato', 'POST', '/equipment', { name: 'Errato', powerType: 'electric', electricPowerKw: '2', electricTariffId: '{T:Gas metano cucina}' })
// tariffe
await step('nuova versione di tariffa', 'POST', '/tariffs/{T:Energia elettrica laboratorio}/versions', { mode: 'direct', pricePerUnit: '0.31', validFrom: '2026-10-01' })
await step('versioni della tariffa', 'GET', '/tariffs/{T:Energia elettrica laboratorio}', undefined, { keep: (s, j) => (s.ids['V:new'] = j.versions?.find((v) => v.valid_from === '2026-10-01')?.id) })
await step('elimina la versione', 'DELETE', '/tariffs/{T:Energia elettrica laboratorio}/versions/{V:new}')
await step('versione con data duplicata', 'POST', '/tariffs/{T:Energia elettrica laboratorio}/versions', { mode: 'direct', pricePerUnit: '0.5', validFrom: '2026-01-01' })
await step('archivia tariffa', 'POST', '/tariffs/{T:Gas metano cucina}/archive')
await step('tariffe archiviate', 'GET', '/tariffs?archived=1')
await step('ripristina tariffa', 'POST', '/tariffs/{T:Gas metano cucina}/restore')
await step('rinomina tariffa', 'PATCH', '/tariffs/{T:Gas metano cucina}', { name: 'Gas cucina', notes: 'nota' })
// dipendenti
await step('archivia dipendente', 'POST', '/employees/{D:DIP-002}/archive')
await step('dipendenti archiviati', 'GET', '/employees?archived=1')
await step('ripristina dipendente', 'POST', '/employees/{D:DIP-002}/restore')
await step('nuova configurazione di costo', 'POST', '/employees/{D:DIP-002}/costs', { validFrom: '2026-09-01', grossMonthly: '2.000,00'.replace('.', '').replace(',', '.'), contributionsMode: 'percent', contributionsValue: '30', productiveHours: '150' })
await step('scheda dipendente', 'GET', '/employees/{D:DIP-002}', undefined, { keep: (s, j) => (s.ids['C:new'] = j.costs?.find((c) => c.validFrom === '2026-09-01')?.id) })
await step('elimina configurazione', 'DELETE', '/employees/{D:DIP-002}/costs/{C:new}')
await step('oneri oltre il 200%', 'POST', '/employees/{D:DIP-002}/costs', { validFrom: '2026-09-01', grossMonthly: '2000', contributionsMode: 'percent', contributionsValue: '250', productiveHours: '150' })
await step('modifica anagrafica dipendente', 'PATCH', '/employees/{D:DIP-002}', { firstName: 'Lucia', lastName: 'Verdi', jobTitle: 'Pasticciera', status: 'active' })
// ingredienti
await step('modifica con lockVersion superata', 'PATCH', '/ingredients/{I:CAR-MAC}', { code: 'CAR-MAC', name: 'Carne', packageContent: 1, packageUnit: 'kg', usageUnit: 'g', lockVersion: 0 })
await step('nuovo prezzo', 'POST', '/ingredients/{I:CAR-MAC}/prices', { packagePrice: '10.10', validFrom: '2026-09-15', source: 'Fattura' })
await step('scheda ingrediente', 'GET', '/ingredients/{I:CAR-MAC}', undefined, { keep: (s, j) => (s.ids['P:new'] = j.prices?.find((p) => p.valid_from === '2026-09-15')?.id) })
await step('elimina il prezzo', 'DELETE', '/ingredients/{I:CAR-MAC}/prices/{P:new}')
await step('archivia ingrediente', 'POST', '/ingredients/{I:ERB-BAS}/archive')
await step('ingredienti archiviati', 'GET', '/ingredients?archived=1')
await step('ripristina ingrediente', 'POST', '/ingredients/{I:ERB-BAS}/restore')
// ricette: stati
await step('archivia ricetta', 'POST', '/recipes/{R:PEST}/archive')
await step('ripristina ricetta (torna in bozza)', 'POST', '/recipes/{R:PEST}/restore')
await step('stato dopo il ripristino', 'GET', '/recipes/{R:PEST}')
await step('attiva ricetta', 'POST', '/recipes/{R:PEST}/activate')
await step('duplica ricetta', 'POST', '/recipes/{R:BESC}/duplicate', undefined, { keep: (s, j) => (s.ids['R:dup'] = j.id) })
await step('elimina la copia', 'DELETE', '/recipes/{R:dup}')
await step('elimina ricetta usata come semilavorato', 'DELETE', '/recipes/{R:BESC}')
// utenti e inviti
await step('nuova azienda (amministratore di piattaforma)', 'POST', '/companies', { name: 'Seconda sede' }, { keep: (s, j) => (s.ids['CO:new'] = j.id) })
await step('passa alla nuova azienda', 'POST', '/auth/company', { companyId: '{CO:new}' })
await step('invita un utente già registrato', 'POST', '/users/invitations', { email: 'responsabile@demo.local', name: 'Roberto Responsabile', role: 'manager' }, { keep: (s, j) => (s.ids['TOK:inv'] = new URL(j.inviteLink).searchParams.get('token')) })
await step('invita un nuovo utente', 'POST', '/users/invitations', { email: 'nuovo@demo.local', name: 'Nuovo Utente', role: 'operator' }, { keep: (s, j) => (s.ids['INV:del'] = j.id) })
await step('inviti in sospeso', 'GET', '/users')
await step('revoca invito', 'DELETE', '/users/invitations/{INV:del}')
await step('informazioni sull’invito (utente esistente)', 'GET', '/auth/invitations/{TOK:inv}', undefined, { anon: true })
await step('accetta con password sbagliata', 'POST', '/auth/invitations/accept', { token: '{TOK:inv}', password: 'sbagliata' }, { anon: true })
await step('accetta con la propria password', 'POST', '/auth/invitations/accept', { token: '{TOK:inv}', password: PASSWORD }, { anon: true })
await step('aziende del responsabile', 'GET', '/auth/me', undefined, { anon: true })
// password
await step('cambio password: attuale errata', 'POST', '/auth/password/change', { currentPassword: 'sbagliata', newPassword: 'Nuova-password-2026' })
await step('cambio password: troppo corta', 'POST', '/auth/password/change', { currentPassword: PASSWORD, newPassword: 'corta' })
await step('cambio password', 'POST', '/auth/password/change', { currentPassword: PASSWORD, newPassword: 'Nuova-password-2026' })
await step('l’altra sessione del responsabile resta valida', 'GET', '/auth/me', undefined, { anon: true })
for (const s of sides) s.anon.reset()
await step('accesso con la nuova password', 'POST', '/auth/login', { email: 'admin@demo.local', password: 'Nuova-password-2026' }, { anon: true })
await step('accesso con la vecchia password', 'POST', '/auth/login', { email: 'admin@demo.local', password: PASSWORD }, { anon: true })

console.log(`\nIdentici: ${same}  Diversi: ${different}`)
process.exit(different ? 1 : 0)
