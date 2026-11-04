/**
 * Crea il primo amministratore e la prima azienda (produzione).
 *
 *   npm run create-admin -- --email anna@esempio.it --name "Anna Rossi" --company "Trattoria Esempio"
 *
 * La password viene chiesta a terminale (non compare a schermo né nella cronologia),
 * oppure letta da ADMIN_PASSWORD per installazioni automatiche.
 * L'utente creato è amministratore della piattaforma: può creare altre aziende dalle Impostazioni.
 * Con --reset-password reimposta la password di un utente esistente.
 */
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { loadEnv } from '../env'
import { connect } from './connection'
import { migrate } from './migrate'
import { hashPassword, PASSWORD_MIN_LENGTH } from '../auth/crypto'

loadEnv()
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const email = arg('email')?.trim().toLowerCase()
const name = arg('name')?.trim()
const company = arg('company')?.trim()
const reset = process.argv.includes('--reset-password')

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('Indica un’email valida con --email.')
if (!reset && (!name || !company)) fail('Indica --name e --company (oppure usa --reset-password per un utente esistente).')

async function askHidden(question: string): Promise<string> {
  let muted = false
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk)
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output: out, terminal: true })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    muted = true
  })
}

let password = process.env.ADMIN_PASSWORD
if (!password) {
  if (!process.stdin.isTTY) fail('Nessun terminale interattivo: imposta la password con la variabile ADMIN_PASSWORD.')
  password = await askHidden('Password del nuovo amministratore: ')
  const again = await askHidden('Ripeti la password: ')
  if (password !== again) fail('Le password non coincidono.')
}
if (password.length < PASSWORD_MIN_LENGTH) fail(`La password deve avere almeno ${PASSWORD_MIN_LENGTH} caratteri.`)

const database = await connect()
try {
  await migrate(database)
  const db = database.db
  const existing = await db.selectFrom('users').select(['id', 'name']).where(({ fn }) => fn('lower', ['email']), '=', email).executeTakeFirst()
  if (reset) {
    if (!existing) fail(`Nessun utente con email ${email}.`)
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ password_hash: await hashPassword(password!), is_active: true }).where('id', '=', existing.id).execute()
      await trx.deleteFrom('sessions').where('user_id', '=', existing.id).execute()
    })
    console.log(`Password reimpostata per ${email}. Le sessioni aperte sono state chiuse.`)
  } else {
    if (existing) fail(`Esiste già un utente con email ${email}. Usa --reset-password per cambiarne la password.`)
    const r = await db.transaction().execute(async (trx) => {
      const u = await trx.insertInto('users').values({ email, name: name!, password_hash: await hashPassword(password!), is_platform_admin: true }).returning('id').executeTakeFirstOrThrow()
      const c = await trx.insertInto('companies').values({ name: company! }).returning('id').executeTakeFirstOrThrow()
      await trx.insertInto('memberships').values({ company_id: c.id, user_id: u.id, role: 'admin' }).execute()
      await trx.insertInto('audit_logs').values({ company_id: c.id, user_id: u.id, entity_type: 'user', entity_id: u.id, action: 'bootstrap_admin', details: JSON.stringify({ email }) }).execute()
      return c
    })
    console.log(`Creati l’amministratore ${email} e l’azienda “${company}” (${r.id}).`)
    console.log('Accedi all’applicazione e invita gli altri utenti da Utenti.')
  }
} finally {
  await database.close()
}
