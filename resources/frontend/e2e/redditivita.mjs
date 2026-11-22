/** Verifica E2E del coefficiente di redditività: calcolo, giorni di chiusura, costi fissi, prezzi, accesso negato al responsabile. */
import puppeteer from 'puppeteer-core'
const BASE = process.env.BASE_URL ?? 'http://localhost:8000', PW = process.env.DEMO_PASSWORD
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--no-proxy-server'] })
const page = await b.newPage(); await page.setViewport({ width: 1366, height: 900 })
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && !m.text().includes('403') && errors.push(m.text().slice(0, 200)))
const settle = async () => { await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {}); await new Promise((r) => setTimeout(r, 500)) }
const login = async (email) => {
  await page.goto(`${BASE}/accedi`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => { const el = document.querySelector('#email'); return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps')) })
  await page.type('#email', email); await page.type('#password', PW); await page.click('button[type=submit]'); await page.waitForSelector('.kpis')
}
const clickText = (sel, t) => page.evaluate((s, t) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(t)); if (!el) throw new Error('non trovato: ' + t); el.click() }, sel, t)
await login('admin@demo.local')
await clickText('.nav a', 'Redditività'); await page.waitForSelector('.kpis'); await settle()
const kpi = await page.$$eval('.kpi', (k) => k.map((x) => x.innerText.replace(/\n+/g, ' | ')))
console.log('KPI:', kpi.join('  //  '))
await page.screenshot({ path: (process.env.OUT_DIR ?? '/tmp') + '/redditivita.png', fullPage: true })
// chiudo anche la domenica: 5 giorni → stesso totale settimanale, più piatti al giorno
await clickText('button', 'Dom'); await settle()
console.log('dopo chiusura domenica:', await page.$$eval('.kpi', (k) => k.slice(0, 2).map((x) => x.innerText.replace(/\n+/g, ' | ')).join(' // ')))
await clickText('button', 'Dom'); await settle()
// nuova voce: finanziamento 300 €/mese
await clickText('button', 'Nuova voce'); await page.waitForSelector('#fc-name')
await page.type('#fc-name', 'Finanziamento ristrutturazione'); await page.select('#fc-cat', 'loan'); await page.type('#fc-amount', '300')
await clickText('.drawer button', 'Salva'); await settle()
console.log('con finanziamento:', await page.$$eval('.kpi', (k) => k[0].innerText.replace(/\n+/g, ' | ')))
// prezzo: lasagna a 15 €
await page.evaluate(() => { const i = document.querySelector('input[aria-label="Prezzo di Lasagna alla bolognese"]'); i.focus() })
await page.click('input[aria-label="Prezzo di Lasagna alla bolognese"]'); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.type('15')
await page.evaluate(() => { const tr = document.querySelector('input[aria-label="Prezzo di Lasagna alla bolognese"]').closest('tr'); [...tr.querySelectorAll('button')].find((x) => x.textContent.includes('Salva')).click() }); await settle()
console.log('lasagna a 15 €:', await page.$$eval('.kpi', (k) => k[0].innerText.replace(/\n+/g, ' | ')))
await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'foodcost' } }))
await login('responsabile@demo.local')
console.log('menu responsabile:', (await page.$$eval('.nav a', (a) => a.map((x) => x.textContent.trim()))).includes('Redditività') ? 'VEDE la voce (errore)' : 'voce assente')
await page.goto(`${BASE}/redditivita`); await settle()
console.log('responsabile su /redditivita:', (await page.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText)).slice(0, 120).replace(/\n/g, ' '))
console.log(JSON.stringify({ errors }))
await b.close()
