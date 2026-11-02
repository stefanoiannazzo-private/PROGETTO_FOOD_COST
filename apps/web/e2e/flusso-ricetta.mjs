/**
 * Verifica end-to-end del flusso essenziale nell'interfaccia:
 * nuova ricetta → ingrediente creato al volo e inserito → semilavorato → riepilogo costi → salvataggio → scheda.
 *
 * Prerequisiti: API e web avviati, dati dimostrativi caricati (npm run seed:demo).
 * Uso: CHROME_PATH=/percorso/chrome DEMO_PASSWORD=... node apps/web/e2e/flusso-ricetta.mjs
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--no-proxy-server'] })
const page = await browser.newPage()
await page.setViewport({ width: 1366, height: 900 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const step = (m) => console.log(`✓ ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clickText = (sel, text) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t)); if (!el) throw new Error(`non trovato: ${t}`); el.click() }, sel, text)
/** Attende che React abbia preso il controllo della pagina (idratazione) prima di digitare. */
const hydrated = (sel) => page.waitForFunction((s) => { const el = document.querySelector(s); return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps')) }, {}, sel)
const typeNumber = async (selector, value) => { await page.click(selector, { clickCount: 3 }); await page.type(selector, value) }

try {
  await page.goto(`${BASE}/accedi`, { waitUntil: 'networkidle0' })
  await hydrated('#email')
  await page.type('#email', 'admin@demo.local')
  await page.type('#password', process.env.DEMO_PASSWORD ?? 'Demo-locale-2026')
  await page.click('button[type=submit]')
  await page.waitForSelector('.kpis')
  step('accesso')

  await page.goto(`${BASE}/ricette/nuova`, { waitUntil: 'networkidle0' })
  await hydrated('#r-title')
  await page.type('#r-title', 'Pasticcio di prova E2E')
  await typeNumber('#r-fw', '1,5')
  await typeNumber('#r-por', '6')
  step('dati e resa')

  // ingrediente nuovo creato dal pannello laterale, senza perdere la ricetta
  await page.type('input[aria-label="Aggiungi ingrediente"]', 'Ricotta E2E')
  await page.waitForSelector('.picker-list')
  await sleep(400)
  await clickText('.picker-item', 'Crea nuovo ingrediente')
  await page.waitForSelector('.drawer #ing-name')
  await typeNumber('#ing-pc', '1,5')
  await page.select('select[aria-label="Unità del contenuto"]', 'kg')
  await typeNumber('#ing-price', '9,00')
  await clickText('.drawer-foot button', 'Salva e inserisci')
  await page.waitForFunction(() => [...document.querySelectorAll('.comp-row strong')].some((e) => e.textContent.includes('Ricotta E2E')))
  const title = await page.$eval('#r-title', (e) => e.value)
  if (title !== 'Pasticcio di prova E2E') throw new Error('la ricetta in compilazione è andata persa')
  await page.type('input[aria-label="Quantità di Ricotta E2E"]', '500')
  step('ingrediente creato al volo e inserito (ricetta intatta)')

  // semilavorato
  await page.type('input[aria-label="Aggiungi semilavorato"]', 'Ragù')
  await page.waitForFunction(() => [...document.querySelectorAll('.picker-item')].some((e) => e.textContent.includes('Ragù alla bolognese')))
  await clickText('.picker-item', 'Ragù alla bolognese')
  await page.type('input[aria-label="Quantità di Ragù alla bolognese"]', '600')
  step('semilavorato inserito')

  // riepilogo aggiornato dal backend: 500 g × 6 €/kg = 3 € + 600 g di ragù
  await page.waitForFunction(() => {
    const t = document.querySelector('.summary-panel')?.textContent ?? ''
    return t.includes('Semilavorati') && t.includes('3,00 €')
  }, { timeout: 10000 })
  const total = await page.$eval('.summary-panel .big-number', (e) => e.textContent)
  step(`riepilogo costi in tempo reale: ${total}`)

  await clickText('button', 'Crea ricetta')
  await page.waitForFunction(() => location.pathname.match(/^\/ricette\/[0-9a-f-]{36}$/))
  await page.waitForSelector('.summary-panel .big-number')
  const saved = await page.$eval('.summary-panel .big-number', (e) => e.textContent)
  if (saved !== total) throw new Error(`totale salvato ${saved} diverso dall'anteprima ${total}`)
  step(`ricetta salvata, scheda con lo stesso totale: ${saved}`)

  if (errors.length) throw new Error(`errori JavaScript: ${errors.join('; ')}`)
  console.log('\nFlusso UI verificato.')
} catch (e) {
  await page.screenshot({ path: 'e2e-errore.png', fullPage: true })
  console.error(`✗ ${e.message} (schermata in e2e-errore.png)`)
  process.exitCode = 1
} finally {
  await browser.close()
}
