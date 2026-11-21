/** Schermate delle stesse pagine su originale e clone: node tools/parity/screens.mjs <BASE_URL> <cartella>  (USER_EMAIL, DEMO_PASSWORD). */
// Schermate delle stesse pagine su due installazioni (originale e clone) per il confronto visivo.
import puppeteer from 'puppeteer-core'
const [BASE, OUT] = process.argv.slice(2)
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--no-proxy-server', '--font-render-hinting=none'] })
const page = await b.newPage()
await page.setViewport({ width: 1366, height: 900 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)))
const settle = async () => { await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {}); await new Promise((r) => setTimeout(r, 600)) }
const shot = async (name) => { await settle(); await page.evaluate(() => document.activeElement?.blur()); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }) }
await page.goto(`${BASE}/accedi`, { waitUntil: 'networkidle0' })
await page.waitForFunction(() => { const el = document.querySelector('#email'); return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps')) })
await shot('01-accedi')
await page.type('#email', process.env.USER_EMAIL ?? 'admin@demo.local'); await page.type('#password', process.env.DEMO_PASSWORD)
await page.click('button[type=submit]'); await page.waitForSelector('.kpis')
const api = (p) => page.evaluate(async (p) => (await fetch('/api' + p)).json(), p)
const byCode = async (list, code) => (await api(list)).data.find((x) => x.code?.startsWith(code))?.id
const pages = [
  ['02-dashboard', '/'], ['03-ricette', '/ricette'], ['05-ricetta-nuova', '/ricette/nuova'], ['06-ingredienti', '/ingredienti'],
  ['08-strumenti', '/strumenti'], ['09-utenze', '/utenze'], ['10-dipendenti', '/dipendenti'], ['12-importazioni', '/importazioni'],
  ['13-utenti', '/utenti'], ['14-impostazioni', '/impostazioni'],
]
for (const [n, p] of pages) { await page.goto(BASE + p); await shot(n) }
const las = await byCode('/recipes?pageSize=100', 'LAS')
if (las) { await page.goto(`${BASE}/ricette/${las}`); await shot('04-ricetta-lasagna'); await page.goto(`${BASE}/ricette/${las}/modifica`); await shot('04b-ricetta-modifica') }
const ings = (await api('/ingredients?pageSize=5&sort=code')).data
if (ings[0]) { await page.goto(`${BASE}/ingredienti/${ings[0].id}`); await shot('07-ingrediente') }
const emps = (await api('/employees')).data
if (emps[0]) { await page.goto(`${BASE}/dipendenti/${emps[0].id}`); await shot('11-dipendente') }
const eqs = (await api('/equipment')).data
if (eqs[0]) { await page.goto(`${BASE}/strumenti/${eqs[0].id}`); await shot('08b-strumento') }
const tars = (await api('/tariffs')).data
if (tars[0]) { await page.goto(`${BASE}/utenze/${tars[0].id}`); await shot('09b-utenza') }
await page.setViewport({ width: 390, height: 844, isMobile: true })
await page.goto(BASE + '/'); await shot('15-mobile-dashboard')
console.log(JSON.stringify({ errors }))
await b.close()
