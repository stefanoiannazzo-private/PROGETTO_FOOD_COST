/** Verifica E2E della console superadmin: aziende, tutte le ricette, confronto, prodotti, statistiche prezzi, assistenza.
 *  Uso: BASE_URL=http://localhost:8000 DEMO_PASSWORD=... node e2e/console-saas.mjs */
import puppeteer from 'puppeteer-core'
const BASE = process.env.BASE_URL ?? 'http://localhost:8000'
const OUT = process.env.OUT_DIR ?? '/tmp'
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--no-proxy-server'] })
const page = await b.newPage()
await page.setViewport({ width: 1366, height: 900 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)))
const settle = async () => { await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {}); await new Promise((r) => setTimeout(r, 500)) }
const shot = async (n) => { await settle(); await page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }) }
const clickText = (sel, t) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(t)); if (!el) throw new Error('non trovato: ' + t); el.click() }, sel, t)
const step = (m) => console.log('✓ ' + m)
await page.goto(`${BASE}/accedi`, { waitUntil: 'networkidle0' })
await page.waitForFunction(() => { const el = document.querySelector('#email'); return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps')) })
await page.type('#email', 'admin@demo.local'); await page.type('#password', process.env.DEMO_PASSWORD)
await page.click('button[type=submit]'); await page.waitForSelector('.kpis')
await clickText('.nav a', 'Aziende'); await page.waitForSelector('table'); await shot('01-aziende'); step('console aziende')
await clickText('.nav a', 'Tutte le ricette'); await page.waitForSelector('table')
await page.type('input[type=search]', 'lasagn'); await settle()
const n = await page.$$eval('tbody tr', (r) => r.length); if (n < 2) throw new Error('attese almeno 2 lasagne, trovate ' + n)
await page.$$eval('tbody tr', (rows) => rows.slice(0, 2).forEach((r) => r.click()))
await shot('02-ricette-selezione')
await clickText('.page-head button', 'Confronta'); await page.waitForSelector('#g-name')
await page.click('#g-name', { clickCount: 3 }); await page.type('#g-name', 'Lasagne (confronto)')
await clickText('.drawer button, [role=dialog] button, button', 'Crea confronto')
await page.waitForFunction(() => location.pathname.startsWith('/piattaforma/confronti/')); await page.waitForSelector('table')
await clickText('button', 'Ingredienti'); await shot('03-confronto'); step('confronto creato: ' + await page.$eval('h1', (h) => h.textContent))
await page.goto(`${BASE}/piattaforma/prodotti`); await page.waitForSelector('table'); await shot('04-prodotti')
await clickText('[role=tab]', 'Fornitori'); await shot('05-fornitori'); step('prodotti e fornitori')
await page.goto(`${BASE}/piattaforma/prezzi?prodotto=carne`); await page.waitForSelector('.card-head'); await shot('06-prezzi'); step('statistiche prezzi')
await page.goto(`${BASE}/piattaforma`); await page.waitForSelector('table')
await page.evaluate(() => { const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('Osteria')); [...tr.querySelectorAll('button')].find((x) => x.textContent.includes('Assisti')).click() })
await new Promise((r) => setTimeout(r, 2500)); await shot('07-assistenza'); console.log(page.url(), await page.evaluate(() => document.body.innerText.slice(0, 400))); step('assistenza: ' + await page.$eval('.topbar', (t) => t.textContent))
console.log(JSON.stringify({ errors }))
await b.close()
