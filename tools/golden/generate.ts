/**
 * Genera i casi "golden": scenari casuali calcolati con il motore TypeScript ORIGINALE.
 * I test PHP (tests/Unit/Domain/GoldenParityTest.php) ricalcolano gli stessi scenari e confrontano
 * il risultato serializzato campo per campo.
 *
 * Uso (dalla cartella del repository originale, che contiene decimal.js e tsx):
 *   npx tsx <percorso>/tools/golden/generate.ts <percorso>/packages/domain/src/index.ts <cartella-output>
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [domainPath, outDir] = process.argv.slice(2)
const D = await import(pathToFileURL(domainPath).href)
const { Dec, serialize, valueRecipe, parseItalianNumber, findCycle, dependentsOf, descendantsOf } = D

let seed = 20261121
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!
const chance = (p: number) => rnd() < p
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1))
const num = (max: number, decimals: number) => (rnd() * max).toFixed(decimals).replace(/\.?0+$/, '') || '0'
const pos = (max: number, decimals: number) => { const v = num(max, decimals); return v === '0' ? '1' : v }
const odd = () => pick(['3', '7', '0.3', '1.7', '13', '0.07', '2.9', '11.11', '0.333', '6'])

// Valori decimali marcati: {"$d": "..."}; il PHP li converte in Dec, il TS in Decimal.
const md = (s: string | null) => (s === null ? null : { $d: s })
const toDec = (v: any): any => {
  if (v && typeof v === 'object' && '$d' in v) return new Dec(v.$d)
  if (Array.isArray(v)) return v.map(toDec)
  if (v && typeof v === 'object') { const o: any = {}; for (const [k, x] of Object.entries(v)) o[k] = toDec(x); return o }
  return v
}
const UNITS = ['g', 'kg', 'ml', 'cl', 'l', 'pz']

function makeContext(n: number) {
  const ingredients: Record<string, any> = {}
  const ni = int(3, 9)
  for (let i = 0; i < ni; i++) {
    const unit = pick(UNITS)
    ingredients[`ing${i}`] = {
      id: `ing${i}`, code: `ING-${i}`, name: `Ingrediente ${i}`,
      packageUnit: unit, packageContent: md(chance(0.5) ? pos(10, 3) : odd()),
      packagePrice: chance(0.12) ? null : chance(0.08) ? md('0') : md(chance(0.5) ? pos(50, 2) : odd()),
      priceId: `p${i}`, priceValidFrom: '2026-01-01',
      edibleYield: md(chance(0.6) ? '1' : pick(['0.9', '0.75', '0.333', '0.5', '0.07', '1'])),
      densityKgPerL: chance(0.5) ? md(pick(['1', '0.92', '1.03', '0.7', '1.3'])) : null,
      unitWeightKg: chance(0.5) ? md(pick(['0.06', '0.2', '1', '0.333', '0.015'])) : null,
    }
  }
  const tariffs: Record<string, any> = {
    tel: { id: 'tel', name: 'Luce', kind: 'electricity', unit: 'kwh', pricePerUnit: md(pick(['0.3', '0.25', '0.2873', '0.333'])), versionId: 'v1', validFrom: '2026-01-01', m3ToSmc: null, smcToKwh: null },
    tgas: { id: 'tgas', name: 'Gas', kind: 'gas', unit: pick(['m3', 'smc', 'kwh']), pricePerUnit: md(pick(['1.2', '0.95', '1.07', '0.11'])), versionId: 'v2', validFrom: '2026-01-01',
      m3ToSmc: chance(0.6) ? md(pick(['1.02', '0.98', '1'])) : null, smcToKwh: chance(0.6) ? md(pick(['10.57', '10.7', '9.6'])) : null },
    twat: { id: 'twat', name: 'Acqua', kind: 'water', unit: 'm3', pricePerUnit: md('2.1'), versionId: 'v3', validFrom: '2026-01-01', m3ToSmc: null, smcToKwh: null },
  }
  const equipment: Record<string, any> = {}
  const ne = int(1, 5)
  for (let i = 0; i < ne; i++) {
    const powerType = pick(['electric', 'gas', 'mixed', 'manual'])
    const electric = (powerType === 'electric' || powerType === 'mixed') && chance(0.9) ? {
      powerKw: chance(0.9) ? md(pos(12, 2)) : null,
      usageCoefficient: chance(0.9) ? md(pick(['0.6', '1', '0.333', '0.75', '1.2'])) : null,
      preheatCoefficient: chance(0.4) ? md(pick(['1', '0.9'])) : null,
      holdCoefficient: chance(0.4) ? md(pick(['0.3', '0.25'])) : null,
      tariffId: chance(0.85) ? pick(['tel', 'tel', 'tgas', 'missing']) : null,
    } : null
    const gas = (powerType === 'gas' || powerType === 'mixed') && chance(0.9) ? (chance(0.5)
      ? { mode: 'flow', flowPerHour: chance(0.9) ? md(pos(3, 3)) : null, flowUnit: chance(0.9) ? pick(['m3', 'smc']) : null, powerKw: null, loadFactor: chance(0.5) ? md(pick(['0.7', '0.5'])) : null, tariffId: chance(0.85) ? pick(['tgas', 'tgas', 'tel']) : null }
      : { mode: 'energy', flowPerHour: null, flowUnit: null, powerKw: chance(0.9) ? md(pos(20, 1)) : null, loadFactor: chance(0.5) ? md(pick(['0.7', '0.5'])) : null, tariffId: chance(0.85) ? 'tgas' : null }) : null
    equipment[`eq${i}`] = { id: `eq${i}`, code: `STR-${i}`, name: `Strumento ${i}`, powerType, electric, gas }
  }
  const employees: Record<string, any> = {}
  const nm = int(1, 4)
  for (let i = 0; i < nm; i++) {
    const mode = pick(['none', 'amount', 'percent'])
    employees[`emp${i}`] = {
      employeeId: `emp${i}`, code: `DIP-${i}`, name: `Dipendente ${i}`, configId: `c${i}`,
      grossMonthly: md(pick(['2400', '1850.5', '2000', '1333.33', '0'])),
      contributionsMode: mode, contributionsValue: mode === 'none' ? null : md(mode === 'amount' ? pick(['600', '512.4']) : pick(['30', '32.5', '28'])),
      otherMonthlyCosts: chance(0.5) ? md(pick(['0', '120', '75.5'])) : null,
      productiveHours: md(pick(['160', '168', '173.33', '150', '0'])),
    }
  }
  const nr = int(2, 7)
  const recipes: Record<string, any> = {}
  for (let r = 0; r < nr; r++) {
    const components: any[] = []
    for (let k = 0, nc = int(0, 5); k < nc; k++) {
      const sub = r < nr - 1 && chance(0.35)
      const cyc = chance(0.04) && r > 0
      const target = cyc ? `r${int(0, r)}` : sub ? `r${int(r + 1, nr - 1)}` : null
      const bad = chance(0.03)
      components.push({
        id: `r${r}c${k}`, kind: target ? 'recipe' : 'ingredient',
        ingredientId: target ? (bad ? 'ing0' : null) : (chance(0.04) ? 'ingX' : `ing${int(0, ni - 1)}`),
        recipeId: target, quantity: md(chance(0.05) ? '0' : chance(0.5) ? pos(2000, 1) : odd()), unit: pick(UNITS), note: null,
      })
    }
    const equipmentUses: any[] = []
    for (let k = 0, nu = int(0, 3); k < nu; k++) {
      equipmentUses.push({
        id: `r${r}u${k}`, equipmentId: chance(0.05) ? 'eqX' : `eq${int(0, ne - 1)}`, phaseId: null,
        segment: pick(['preheat', 'work', 'hold']), minutes: md(chance(0.04) ? '0' : pos(240, 1)),
        share: md(pick(['1', '1', '0.5', '0.333', '1.5', '0.25'])),
        sources: chance(0.4) ? pick([['electric'], ['gas'], ['electric', 'gas']]) : null,
        measuredElectricKwh: chance(0.15) ? md(pos(5, 3)) : null,
        measuredGasQuantity: chance(0.15) ? md(pos(2, 3)) : null,
        measuredGasUnit: chance(0.7) ? pick(['m3', 'smc', 'kwh']) : null,
      })
    }
    const laborAssignments: any[] = []
    for (let k = 0, nl = int(0, 3); k < nl; k++) {
      laborAssignments.push({ id: `r${r}l${k}`, employeeId: chance(0.07) ? 'empX' : `emp${int(0, nm - 1)}`, phaseId: null,
        activeMinutes: md(chance(0.04) ? '0' : pos(180, 1)), share: md(pick(['1', '0.5', '0.333', '1'])) })
    }
    const finalUnit = chance(0.85) ? pick(UNITS) : null
    recipes[`r${r}`] = {
      id: `r${r}`, revisionId: `rev${r}`, revisionNumber: int(1, 4), code: `RIC-${r}`, title: `Ricetta ${n}-${r}`,
      finalQuantity: finalUnit && chance(0.9) ? md(pos(20, 2)) : null, finalUnit,
      finalWeightKg: chance(0.7) ? md(chance(0.5) ? pos(15, 3) : odd()) : null,
      portions: chance(0.7) ? md(String(int(1, 24))) : null,
      declaredDurationMinutes: chance(0.5) ? md(pos(300, 0)) : null,
      phases: [], components, equipmentUses, laborAssignments,
    }
  }
  return { date: '2026-11-21', recipes, ingredients, equipment, tariffs, employees }
}

const asMaps = (ctx: any) => ({
  ...ctx,
  recipes: new Map(Object.entries(ctx.recipes)), ingredients: new Map(Object.entries(ctx.ingredients)),
  equipment: new Map(Object.entries(ctx.equipment)), tariffs: new Map(Object.entries(ctx.tariffs)), employees: new Map(Object.entries(ctx.employees)),
})

const cases: any[] = []
for (let n = 0; n < 250; n++) {
  const raw = makeContext(n)
  const ctx = asMaps(toDec(raw))
  const results: Record<string, any> = {}
  for (const id of Object.keys(raw.recipes)) {
    try { results[id] = JSON.parse(JSON.stringify(serialize(valueRecipe(ctx, id)))) }
    catch (e: any) { results[id] = { error: e.code ?? 'exception', message: e.message } }
  }
  cases.push({ context: raw, results })
}
writeFileSync(`${outDir}/engine.json`, JSON.stringify(cases))

// Aritmetica: operazioni a 40 cifre significative.
const ops: any[] = []
const operands = ['1', '3', '7', '0.1', '2.5', '1e-7', '123456789.123456789', '0.000333', '99999999999999999999.99', '-2.75', '6', '9.87654321', '1234567890123456789012345678901234567890.5', '0.5', '-0.000001']
for (const a of operands) for (const b of operands) {
  const A = new Dec(a), B = new Dec(b)
  ops.push({ a, b, plus: A.plus(B).toFixed(), minus: A.minus(B).toFixed(), times: A.times(B).toFixed(), div: B.isZero() ? null : A.div(B).toFixed(),
    dp2: A.div(B).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(), dp4: A.div(B).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed() })
}
for (let i = 0; i < 400; i++) {
  const a = (chance(0.5) ? '-' : '') + num(10 ** int(0, 8), int(0, 12)), b = pos(10 ** int(0, 6), int(0, 10))
  const A = new Dec(a), B = new Dec(b)
  ops.push({ a, b, plus: A.plus(B).toFixed(), minus: A.minus(B).toFixed(), times: A.times(B).toFixed(), div: A.div(B).toFixed(),
    dp2: A.div(B).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(), dp4: A.div(B).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed() })
}
writeFileSync(`${outDir}/decimal.json`, JSON.stringify(ops))

// Numeri all'italiana
const inputs = ['1.234,56', '0,9', '12', '1234.56', '1.234', '1.234.567', '12.5', '1,234.56', '1,2,3', '€ 3,50', ' 7 ', '-1.000,5', '+2,25', 'abc', '', '1.23.4', '1 234,5', '0,0001', '1.000.000,00', '12,', ',5', '1e5']
const parse: any[] = []
for (const s of inputs) for (const mode of ['auto', 'it', 'en']) {
  const v = parseItalianNumber(s, mode)
  parse.push({ input: s, mode, out: v === null ? null : v.toFixed() })
}
writeFileSync(`${outDir}/parse.json`, JSON.stringify(parse))

// Grafo
const graph: any[] = []
for (let g = 0; g < 120; g++) {
  const n = int(2, 9); const edges: Record<string, string[]> = {}
  for (let i = 0; i < n; i++) { edges[`n${i}`] = []; for (let k = 0; k < int(0, 3); k++) edges[`n${i}`]!.push(`n${int(0, n - 1)}`) }
  const node = `n${int(0, n - 1)}`; const children = Array.from({ length: int(0, 3) }, () => `n${int(0, n - 1)}`)
  const m = new Map(Object.entries(edges))
  graph.push({ edges, node, children, cycle: findCycle(m, node, children), dependents: [...dependentsOf(m, [node])].sort(), descendants: [...descendantsOf(m, [node])].sort() })
}
writeFileSync(`${outDir}/graph.json`, JSON.stringify(graph))
console.log(`casi motore: ${cases.length}, operazioni: ${ops.length}, numeri: ${parse.length}, grafi: ${graph.length}`)
