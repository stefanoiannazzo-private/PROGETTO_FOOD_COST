import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { runOnce } from '../src/services/jobs'
import { addMember, createCompany, createUser, expectOk, loginAs, setup, teardown, type Client, type TestEnv } from './helpers'

let env: TestEnv
let admin: Client
let manager: Client
let other: Client

beforeAll(async () => {
  env = await setup()
  const c = await createCompany(env, 'Laboratorio Import')
  await addMember(env, c, await createUser(env, 'admin@imp.test', 'Admin'), 'admin')
  await addMember(env, c, await createUser(env, 'resp@imp.test', 'Resp'), 'manager')
  const c2 = await createCompany(env, 'Altra azienda')
  await addMember(env, c2, await createUser(env, 'altro@imp.test', 'Altro'), 'admin')
  admin = await loginAs(env, 'admin@imp.test')
  manager = await loginAs(env, 'resp@imp.test')
  other = await loginAs(env, 'altro@imp.test')
})
afterAll(() => teardown(env))

/** Corpo multipart costruito a mano per app.inject. */
async function upload(client: Client, type: string, filename: string, content: Buffer) {
  const boundary = '----foodcost' + Math.random().toString(16).slice(2)
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${type}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const res = await env.app.inject({ method: 'POST', url: '/api/imports', payload: body, headers: { cookie: client.cookie, 'x-requested-with': 'foodcost', 'content-type': `multipart/form-data; boundary=${boundary}` } })
  return { status: res.statusCode, body: res.json() }
}

/** Esegue tutti i lavori in coda (il worker reale gira in background). */
async function drain() {
  while (await runOnce(env.database.db, env.app.cfg)) {
    /* continua */
  }
}

async function validate(client: Client, id: string, mapping: Record<string, string | null>, options: object = {}) {
  expectOk(await client.post(`/api/imports/${id}/validate`, { options: { headerRow: 1, numberFormat: 'it', onExisting: 'update', onNew: 'create', generateCodes: true, ...options }, mapping }))
  await drain()
  return expectOk(await client.get(`/api/imports/${id}`))
}

const latin1 = (s: string) => Buffer.from(s, 'latin1')

describe('Importazione ingredienti da CSV italiano', () => {
  let importId: string
  let mapping: Record<string, string | null>

  it('scarica i modelli CSV e XLSX', async () => {
    const csv = await admin.get('/api/imports/templates/ingredients.csv')
    expect(csv.status).toBe(200)
    expect(String(csv.body)).toContain('Codice;Nome;Categoria')
    const res = await env.app.inject({ method: 'GET', url: '/api/imports/templates/ingredients.xlsx', headers: { cookie: admin.cookie } })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Dati', 'Istruzioni'])
  })

  it('rileva separatore punto e virgola, codifica Windows-1252 e propone l’abbinamento delle colonne', async () => {
    const csv = latin1(
      [
        'Codice;Nome;Categoria;Fornitore;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo;Resa edibile %',
        'FAR-00;Farina 00;Farine;Molino;19,50;25;kg;01/01/2026;',
        'CAF-01;Caffè in grani;Bevande;Torrefazione;1.250,00;60;kg;01/01/2026;',
        'CAR-01;Carote;Verdure;Orto;5,50;5;kg;01/01/2026;80',
        ';Zucchero semolato;Dolcificanti;;12,00;10;kg;01/01/2026;',
      ].join('\r\n'),
    )
    const r = await upload(admin, 'ingredients', 'listino.csv', csv)
    expect(r.status).toBe(200)
    expect(r.body.detected).toMatchObject({ delimiter: ';', encoding: 'latin1' })
    expect(r.body.headers).toContain('Unità contenuto')
    expect(r.body.sample[1][1]).toBe('Caffè in grani')
    expect(r.body.suggestedMapping).toMatchObject({ code: 'Codice', name: 'Nome', packagePrice: 'Prezzo confezione', packageUnit: 'Unità contenuto', priceDate: 'Data prezzo', edibleYieldPercent: 'Resa edibile %' })
    importId = r.body.id
    mapping = r.body.suggestedMapping
  })

  it('valida tutto prima di scrivere: riepilogo, valori normalizzati, nessuna scrittura', async () => {
    const imp = await validate(admin, importId, mapping, { encoding: 'latin1', delimiter: ';' })
    expect(imp.status).toBe('validated')
    expect(imp.summary).toMatchObject({ totalRows: 4, create: 4, update: 0, error: 0 })
    const rows = expectOk(await admin.get(`/api/imports/${importId}/rows`))
    const caffe = rows.data.find((r: { row_number: number }) => r.row_number === 3)
    expect(caffe.normalized).toMatchObject({ packagePrice: '1250', packageContent: '60', priceDate: '2026-01-01' })
    const carote = rows.data.find((r: { row_number: number }) => r.row_number === 4)
    expect(carote.normalized.edibleYieldPercent).toBe('80')
    const zucchero = rows.data.find((r: { row_number: number }) => r.row_number === 5)
    expect(zucchero.warnings[0]).toMatch(/generato/)
    const count = await env.database.db.selectFrom('ingredients').select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(0)
  })

  it('conferma esplicita, applicazione atomica, storico prezzi; seconda conferma senza effetti', async () => {
    const imp = expectOk(await admin.get(`/api/imports/${importId}`))
    expectOk(await admin.post(`/api/imports/${importId}/confirm`, { lockVersion: imp.lockVersion }))
    const again = expectOk(await admin.post(`/api/imports/${importId}/confirm`, { lockVersion: imp.lockVersion }))
    expect(again.alreadyConfirmed).toBe(true)
    await drain()
    const done = expectOk(await admin.get(`/api/imports/${importId}`))
    expect(done.status).toBe('applied')
    const list = expectOk(await admin.get('/api/ingredients?sort=code'))
    expect(list.meta.total).toBe(4)
    const caffe = list.data.find((i: { code: string }) => i.code === 'CAF-01')
    expect(caffe.price.packagePrice).toBe('1250.000000')
    expect(caffe.price.unitPrice.startsWith('20.8333')).toBe(true)
    const generated = list.data.find((i: { name: string }) => i.name === 'Zucchero semolato')
    expect(generated.code).toMatch(/^ING-\d{5}$/)
    const prices = await env.database.db.selectFrom('ingredient_prices').selectAll().execute()
    expect(prices).toHaveLength(4)
    expect(prices.every((p) => p.import_id === importId)).toBe(true)
    // un nuovo giro del lavoro di applicazione non duplica nulla
    await env.database.db.insertInto('jobs').values({ type: 'import.apply', payload: JSON.stringify({ importId }) }).execute()
    await drain()
    expect(await env.database.db.selectFrom('ingredient_prices').selectAll().execute()).toHaveLength(4)
  })

  it('reimportando lo stesso file i prezzi identici non vengono duplicati; un prezzo diverso alla stessa data è un errore', async () => {
    const same = latin1('Codice;Nome;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo\r\nFAR-00;Farina 00;19,50;25;kg;01/01/2026\r\n')
    const r = await upload(admin, 'ingredients', 'ripeto.csv', same)
    const imp = await validate(admin, r.body.id, r.body.suggestedMapping)
    expect(imp.summary).toMatchObject({ update: 1, error: 0 })
    const rows = expectOk(await admin.get(`/api/imports/${r.body.id}/rows`))
    expect(rows.data[0].warnings[0]).toMatch(/non verrà duplicato/)
    expectOk(await admin.post(`/api/imports/${r.body.id}/confirm`, { lockVersion: imp.lockVersion }))
    await drain()
    expect(await env.database.db.selectFrom('ingredient_prices').selectAll().execute()).toHaveLength(4)

    const diff = latin1('Codice;Prezzo confezione;Data prezzo;Contenuto confezione;Unità contenuto;Nome\r\nFAR-00;21,00;01/01/2026;25;kg;Farina\r\n')
    const r2 = await upload(admin, 'ingredients', 'diverso.csv', diff)
    const imp2 = await validate(admin, r2.body.id, r2.body.suggestedMapping)
    expect(imp2.summary.error).toBe(1)
    expect((await admin.post(`/api/imports/${r2.body.id}/confirm`, { lockVersion: imp2.lockVersion })).status).toBe(409)
  })
})

describe('Errori, duplicati e atomicità', () => {
  it('duplicati interni al file e dati non validi: nessuna riga applicata', async () => {
    const csv = Buffer.from(
      [
        'Codice;Nome;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo',
        'DUP-1;Uno;1,00;1;kg;01/02/2026',
        'DUP-1;Uno bis;2,00;1;kg;01/02/2026',
        'BAD-1;Litri senza densità;3,00;0;kg;31/02/2026',
        'BAD-2;Unità strana;3,00;1;sacchi;01/02/2026',
        'OK-1;Valido;3,00;1;kg;01/02/2026',
        'BAD-3;Prezzo senza data;3,00;1;kg;',
      ].join('\n'),
    )
    const r = await upload(admin, 'ingredients', 'errori.csv', csv)
    const imp = await validate(admin, r.body.id, r.body.suggestedMapping)
    expect(imp.summary).toMatchObject({ totalRows: 6, error: 5, create: 1, duplicates: 1 })
    const errs = expectOk(await admin.get(`/api/imports/${r.body.id}/rows?action=error`))
    const text = JSON.stringify(errs.data.map((x: { errors: string[] }) => x.errors))
    expect(text).toMatch(/duplicato nel file \(righe 2, 3\)/)
    expect(text).toMatch(/non è una data esistente/)
    expect(text).toMatch(/maggiore di zero/)
    expect(text).toMatch(/sacchi/)
    expect(text).toMatch(/Data del prezzo obbligatoria/)
    const confirm = await admin.post(`/api/imports/${r.body.id}/confirm`, { lockVersion: imp.lockVersion })
    expect(confirm.status).toBe(409)
    const ok = await env.database.db.selectFrom('ingredients').select('id').where('code', '=', 'OK-1').execute()
    expect(ok).toHaveLength(0)
  })

  it('il report degli errori neutralizza le celle con formule (CSV injection)', async () => {
    const csv = Buffer.from('Codice;Nome;Contenuto confezione;Unità contenuto\nINJ-1;"=HYPERLINK(""http://x"",""clic"")";0;kg\n')
    const r = await upload(admin, 'ingredients', 'inj.csv', csv)
    await validate(admin, r.body.id, r.body.suggestedMapping)
    const rep = await env.app.inject({ method: 'GET', url: `/api/imports/${r.body.id}/report.csv`, headers: { cookie: admin.cookie } })
    expect(rep.body).toContain(`;"'=HYPERLINK(""http://x"",""clic"")";`)
    expect(rep.body).not.toMatch(/;=HYPERLINK/)
    // colonne del report nello stesso ordine del file
    expect(rep.body.split('\r\n')[0]).toBe('\uFEFFRiga;Esito;Errori;Avvisi;Codice;Nome;Contenuto confezione;Unità contenuto')
  })

  it('modifica avvenuta dopo l’anteprima: l’applicazione fallisce senza scrivere nulla', async () => {
    const csv = Buffer.from('Codice;Nome;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo\nCAR-01;Carote bio;6,00;5;kg;01/03/2026\nNEW-9;Nuovo;1,00;1;kg;01/03/2026\n')
    const r = await upload(admin, 'ingredients', 'conflitto.csv', csv)
    const imp = await validate(admin, r.body.id, r.body.suggestedMapping)
    expect(imp.summary).toMatchObject({ update: 1, create: 1, error: 0 })
    // nel frattempo qualcuno modifica le carote
    await new Promise((res) => setTimeout(res, 20))
    await env.database.db.updateTable('ingredients').set({ notes: 'modifica concorrente', updated_at: new Date() }).where('code', '=', 'CAR-01').execute()
    expectOk(await admin.post(`/api/imports/${r.body.id}/confirm`, { lockVersion: imp.lockVersion }))
    await drain()
    const after = expectOk(await admin.get(`/api/imports/${r.body.id}`))
    expect(after.status).toBe('failed')
    expect(after.error).toMatch(/modificato dopo l’anteprima/)
    expect(await env.database.db.selectFrom('ingredients').select('id').where('code', '=', 'NEW-9').execute()).toHaveLength(0)
  })
})

describe('Importazione da XLSX', () => {
  it('legge fogli, date e numeri Excel; rifiuta le formule nei campi obbligatori', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('Note').addRow(['foglio da ignorare'])
    const ws = wb.addWorksheet('Listino')
    ws.addRow(['Codice', 'Nome', 'Prezzo confezione', 'Contenuto confezione', 'Unità contenuto', 'Data prezzo'])
    ws.addRow(['XL-1', 'Burro', 11.5, 1, 'kg', new Date(Date.UTC(2026, 2, 15))])
    ws.addRow(['XL-2', 'Latte', { formula: 'B1*2', result: 3 }, 1, 'l', new Date(Date.UTC(2026, 2, 15))])
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const r = await upload(admin, 'ingredients', 'listino.xlsx', buf)
    expect(r.status).toBe(200)
    expect(r.body.sheets).toEqual(['Note', 'Listino'])
    const imp = await validate(admin, r.body.id, { code: 'Codice', name: 'Nome', packagePrice: 'Prezzo confezione', packageContent: 'Contenuto confezione', packageUnit: 'Unità contenuto', priceDate: 'Data prezzo' }, { sheet: 'Listino' })
    expect(imp.summary).toMatchObject({ totalRows: 2, create: 1, error: 1 })
    const rows = expectOk(await admin.get(`/api/imports/${r.body.id}/rows`))
    expect(rows.data[0].normalized).toMatchObject({ packagePrice: '11.5', priceDate: '2026-03-15' })
    expect(rows.data[1].errors[0]).toMatch(/formula/)
  })

  it('rifiuta .xls e file che non corrispondono al formato', async () => {
    expect((await upload(admin, 'ingredients', 'vecchio.xls', Buffer.from('abc'))).body.error.message).toMatch(/\.xls non è supportato/)
    expect((await upload(admin, 'ingredients', 'finto.xlsx', Buffer.from('non è uno zip'))).status).toBe(422)
  })
})

describe('Importazione dipendenti', () => {
  it('serve il permesso sulle retribuzioni', async () => {
    const r = await upload(manager, 'employees', 'dip.csv', Buffer.from('Codice;Nome\n'))
    expect(r.status).toBe(403)
  })

  it('importa dipendenti e costi con decorrenza; oneri senza modalità sono un errore', async () => {
    const csv = Buffer.from(
      ['Codice;Nome;Cognome;Mansione;Lordo mensile;Ore produttive mensili;Decorrenza;Modalità oneri;Oneri', 'D-1;Mario;Rossi;Cuoco;2.400,00;160;01/01/2026;percentuale;30', 'D-2;Anna;Neri;Aiuto;1.800,00;160;01/01/2026;;', 'D-3;Luca;Bassi;Lavapiatti;1.500,00;160;01/01/2026;;200'].join('\n'),
    )
    const r = await upload(admin, 'employees', 'dipendenti.csv', csv)
    expect(r.body.suggestedMapping).toMatchObject({ grossMonthly: 'Lordo mensile', contributionsMode: 'Modalità oneri', contributionsValue: 'Oneri' })
    const imp = await validate(admin, r.body.id, r.body.suggestedMapping)
    expect(imp.summary).toMatchObject({ create: 2, error: 1 })
    const errs = expectOk(await admin.get(`/api/imports/${r.body.id}/rows?action=error`))
    expect(errs.data[0].errors.join(' ')).toMatch(/modalità degli oneri/)
  })

  it('un’altra azienda non vede né usa le importazioni', async () => {
    const list = expectOk(await admin.get('/api/imports'))
    const id = list.data[0].id
    expect((await other.get(`/api/imports/${id}`)).status).toBe(404)
    expect((await other.get(`/api/imports/${id}/report.csv`)).status).toBe(404)
    expect((await other.post(`/api/imports/${id}/confirm`, { lockVersion: 1 })).status).toBe(404)
  })
})

describe('Volumi', () => {
  it('valida e applica 5.000 righe a blocchi', async () => {
    const lines = ['Codice;Nome;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo']
    for (let i = 0; i < 5000; i++) lines.push(`MASS-${i};Articolo ${i};${(i % 97) + 1},${String(i % 100).padStart(2, '0')};${(i % 9) + 1};kg;01/01/2026`)
    const t0 = Date.now()
    const r = await upload(admin, 'ingredients', 'massivo.csv', Buffer.from(lines.join('\n')))
    const imp = await validate(admin, r.body.id, r.body.suggestedMapping)
    expect(imp.summary).toMatchObject({ totalRows: 5000, create: 5000, error: 0 })
    expectOk(await admin.post(`/api/imports/${r.body.id}/confirm`, { lockVersion: imp.lockVersion }))
    await drain()
    expect(expectOk(await admin.get(`/api/imports/${r.body.id}`)).status).toBe('applied')
    const elapsed = Date.now() - t0
    const n = await env.database.db.selectFrom('ingredients').select(({ fn }) => fn.countAll<string>().as('n')).where('code', 'like', 'MASS-%').executeTakeFirstOrThrow()
    expect(Number(n.n)).toBe(5000)
    console.log(`5.000 righe: validazione e applicazione in ${(elapsed / 1000).toFixed(1)} s`)
  }, 180_000)

  it('oltre il limite di righe configurato l’importazione è rifiutata con un messaggio chiaro', async () => {
    const strict = await setup({ importMaxRows: 3 })
    const c = await createCompany(strict, 'Limiti')
    await addMember(strict, c, await createUser(strict, 'lim@imp.test', 'Lim'), 'admin')
    const cl = await loginAs(strict, 'lim@imp.test')
    const boundary = 'b' + Date.now()
    const content = 'Codice;Nome;Contenuto confezione;Unità contenuto\n' + Array.from({ length: 5 }, (_, i) => `L${i};N;1;kg`).join('\n')
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ningredients\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="l.csv"\r\n\r\n${content}\r\n--${boundary}--\r\n`)
    const up = (await strict.app.inject({ method: 'POST', url: '/api/imports', payload: body, headers: { cookie: cl.cookie, 'x-requested-with': 'foodcost', 'content-type': `multipart/form-data; boundary=${boundary}` } })).json()
    await cl.post(`/api/imports/${up.id}/validate`, { options: { headerRow: 1 }, mapping: up.suggestedMapping })
    while (await runOnce(strict.database.db, strict.app.cfg)) {
      /* */
    }
    const imp = expectOk(await cl.get(`/api/imports/${up.id}`))
    expect(imp.status).toBe('failed')
    expect(imp.error).toMatch(/limite di 3 righe/)
    await teardown(strict)
  })
})
