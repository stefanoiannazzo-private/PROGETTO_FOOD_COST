import { join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import { d, type NumberFormatMode } from '@foodcost/domain'
import type { DB } from '../../db/types'
import { FIELDS, type ImportType } from './fields'
import { CellError, contributionsMode, date, defaultUsageUnit, number, sameDimension, text, unit } from './normalize'
import { readRows, type Cell } from './reader'

export interface ImportOptions {
  sheet?: string | null
  delimiter?: ';' | ',' | '\t'
  encoding?: 'utf8' | 'latin1'
  headerRow: number
  numberFormat: NumberFormatMode
  onExisting: 'update' | 'skip'
  onNew: 'create' | 'skip'
  generateCodes: boolean
}

export const DEFAULT_OPTIONS: ImportOptions = { headerRow: 1, numberFormat: 'it', onExisting: 'update', onNew: 'create', generateCodes: true }

const BATCH = 500

interface Staged {
  row_number: number
  raw: Record<string, string>
  normalized: Record<string, unknown> | null
  action: 'create' | 'update' | 'skip' | 'error'
  target_id: string | null
  errors: string[]
  warnings: string[]
}

/**
 * Validazione completa prima di qualsiasi scrittura: legge il file a blocchi, normalizza ogni riga
 * in tabella di staging e calcola il riepilogo (nuovi, aggiornamenti, ignorati, errori).
 * Nessun dato anagrafico viene modificato in questa fase.
 */
export async function validateImport(db: Kysely<DB>, storageDir: string, importId: string, maxRows: number, onProgress?: (n: number) => Promise<void>) {
  const imp = await db.selectFrom('imports').selectAll().where('id', '=', importId).executeTakeFirstOrThrow()
  const opts: ImportOptions = { ...DEFAULT_OPTIONS, ...(imp.options as Partial<ImportOptions>) }
  const mapping = (imp.mapping ?? {}) as Record<string, string | null>
  const type = imp.type as ImportType
  const companyId = imp.company_id
  await db.deleteFrom('import_rows').where('import_id', '=', importId).execute()

  // anagrafica esistente indicizzata per codice (chiave di abbinamento); mai per nome
  const existing = new Map<string, { id: string; unit: string | null; name: string }>()
  const existingNames = new Set<string>()
  if (type === 'ingredients') {
    for (const r of await db.selectFrom('ingredients').select(['id', 'code', 'package_unit', 'name']).where('company_id', '=', companyId).execute()) {
      existing.set(r.code.toLowerCase(), { id: r.id, unit: r.package_unit, name: r.name })
      existingNames.add(r.name.toLowerCase())
    }
  } else {
    for (const r of await db.selectFrom('employees').select(['id', 'code', 'first_name', 'last_name']).where('company_id', '=', companyId).execute()) {
      existing.set(r.code.toLowerCase(), { id: r.id, unit: null, name: `${r.first_name} ${r.last_name}` })
      existingNames.add(`${r.first_name} ${r.last_name}`.toLowerCase())
    }
  }

  let headers: string[] | null = null
  let colIndex: Record<string, number> = {}
  const codesInFile = new Map<string, number[]>()
  let count = 0
  let batch: Staged[] = []
  const counters = { create: 0, update: 0, skip: 0, error: 0, warnings: 0 }

  const flush = async () => {
    if (!batch.length) return
    const toCheck = batch.filter((b) => b.action !== 'error' && b.target_id && b.normalized)
    await checkHistoryConflicts(db, type, toCheck)
    for (const b of batch) {
      // una riga ignorata per politica non viene scritta: i suoi eventuali problemi non bloccano l'importazione
      if (b.action === 'skip') b.errors = []
      if (b.errors.length) b.action = 'error'
      counters[b.action]++
      counters.warnings += b.warnings.length
    }
    await db
      .insertInto('import_rows')
      .values(
        batch.map((b) => ({
          import_id: importId,
          company_id: companyId,
          row_number: b.row_number,
          raw: JSON.stringify(b.raw),
          normalized: b.normalized ? JSON.stringify(b.normalized) : null,
          action: b.action,
          target_id: b.target_id,
          errors: b.errors.length ? JSON.stringify(b.errors) : null,
          warnings: b.warnings.length ? JSON.stringify(b.warnings) : null,
        })),
      )
      .execute()
    batch = []
    await onProgress?.(count)
  }

  const fields = FIELDS[type]
  const missingRequired = fields.filter((f) => f.required && f.key !== 'code' && !mapping[f.key])
  if (missingRequired.length) throw new ImportError(`Colonne obbligatorie non abbinate: ${missingRequired.map((f) => f.label).join(', ')}.`)
  if (!mapping.code && !opts.generateCodes) throw new ImportError('Abbina la colonna del codice oppure abilita la generazione dei codici per le righe nuove.')

  const path = join(storageDir, imp.storage_path)
  for await (const row of readRows(path, imp.file_kind, { sheet: opts.sheet, delimiter: opts.delimiter, encoding: opts.encoding })) {
    if (row.rowNumber < opts.headerRow) continue
    if (row.rowNumber === opts.headerRow) {
      headers = row.cells.map((c, i) => (c === null ? `Colonna ${i + 1}` : String(c).trim()))
      colIndex = Object.fromEntries(Object.entries(mapping).filter(([, h]) => h).map(([k, h]) => [k, headers!.indexOf(h!)]))
      for (const [k, i] of Object.entries(colIndex)) if (i < 0) throw new ImportError(`La colonna “${mapping[k]}” non è presente nel file.`)
      continue
    }
    if (!headers) continue
    if (row.cells.every((c) => c === null || String(c).trim() === '')) continue
    count++
    if (count > maxRows) throw new ImportError(`Il file supera il limite di ${maxRows.toLocaleString('it-IT')} righe: dividilo in più file.`)
    const get = (k: string): Cell | undefined => (colIndex[k] === undefined ? undefined : row.cells[colIndex[k]!])
    const raw = Object.fromEntries(headers.map((h, i) => [h, rawText(row.cells[i])]))
    const staged: Staged = { row_number: row.rowNumber, raw, normalized: null, action: 'error', target_id: null, errors: [], warnings: [] }
    batch.push(staged)
    if (type === 'ingredients') normalizeIngredient(staged, get, opts, existing, existingNames)
    else normalizeEmployee(staged, get, opts, existing, existingNames)
    const code = (staged.normalized?.code as string | undefined)?.toLowerCase()
    if (code) codesInFile.set(code, [...(codesInFile.get(code) ?? []), row.rowNumber])
    if (batch.length >= BATCH) await flush()
  }
  await flush()
  if (!headers) throw new ImportError('Il file non contiene la riga di intestazione indicata.')

  // duplicati interni al file: tutte le occorrenze sono in errore (nessuna scelta arbitraria)
  const dups = [...codesInFile.entries()].filter(([, rows]) => rows.length > 1)
  for (const [code, rows] of dups) {
    const msg = `Codice “${code.toUpperCase()}” duplicato nel file (righe ${rows.join(', ')}).`
    const changed = await db
      .updateTable('import_rows')
      .set({ action: 'error', errors: sql`coalesce(errors, '[]'::jsonb) || ${JSON.stringify([msg])}::jsonb` })
      .where('import_id', '=', importId)
      .where('row_number', 'in', rows)
      .returning('action')
      .execute()
    void changed
  }
  const summary = await db
    .selectFrom('import_rows')
    .select(['action', ({ fn }) => fn.countAll<string>().as('n')])
    .where('import_id', '=', importId)
    .groupBy('action')
    .execute()
  const by = Object.fromEntries(summary.map((s) => [s.action, Number(s.n)]))
  return {
    headers,
    totalRows: count,
    create: by.create ?? 0,
    update: by.update ?? 0,
    skip: by.skip ?? 0,
    error: by.error ?? 0,
    warnings: counters.warnings,
    duplicates: dups.length,
  }
}

export class ImportError extends Error {}

function rawText(c: Cell | undefined): string {
  if (c === null || c === undefined) return ''
  if (c instanceof Date) return c.toISOString().slice(0, 10)
  if (typeof c === 'object') return `=${c.formula}`
  return String(c)
}

function field<T>(s: Staged, label: string, fn: () => T): T | null {
  try {
    return fn()
  } catch (e) {
    if (e instanceof CellError) {
      s.errors.push(`${label}: ${e.message}.`)
      return null
    }
    throw e
  }
}

function decideAction(s: Staged, code: string | null, opts: ImportOptions, existing: Map<string, { id: string }>, generated: boolean) {
  const hit = code ? existing.get(code.toLowerCase()) : undefined
  if (hit) {
    s.target_id = hit.id
    s.action = opts.onExisting === 'update' ? 'update' : 'skip'
    if (s.action === 'skip') s.warnings.push('Codice già esistente: riga ignorata secondo la politica scelta.')
  } else {
    s.action = opts.onNew === 'create' ? 'create' : 'skip'
    if (s.action === 'skip') s.warnings.push('Nuovo codice: riga ignorata secondo la politica scelta.')
    if (generated && s.action === 'create') s.warnings.push('Codice mancante: verrà generato automaticamente.')
  }
}

function normalizeIngredient(s: Staged, get: (k: string) => Cell | undefined, o: ImportOptions, existing: Map<string, { id: string; unit: string | null; name: string }>, names: Set<string>) {
  const code = field(s, 'Codice', () => text(get('code')))
  const name = field(s, 'Nome', () => text(get('name')))
  const packagePrice = field(s, 'Prezzo confezione', () => number(get('packagePrice'), o))
  const packageContent = field(s, 'Contenuto confezione', () => number(get('packageContent'), o))
  const packageUnit = field(s, 'Unità contenuto', () => unit(get('packageUnit')))
  const priceDate = field(s, 'Data prezzo', () => date(get('priceDate')))
  const usageUnit = field(s, 'Unità in ricetta', () => unit(get('usageUnit')))
  const yieldPct = field(s, 'Resa edibile', () => number(get('edibleYieldPercent'), o))
  const density = field(s, 'Densità', () => number(get('densityKgPerL'), o))
  const unitWeightG = field(s, 'Peso unitario', () => number(get('unitWeightG'), o))

  const generated = !code && o.generateCodes
  if (!code && !o.generateCodes) s.errors.push('Codice mancante: senza codice non è possibile abbinare la riga.')
  decideAction(s, code, o, existing, generated)
  const hit = code ? existing.get(code.toLowerCase()) : undefined

  if (s.action === 'create') {
    if (!name) s.errors.push('Nome obbligatorio per un nuovo ingrediente.')
    if (!packageContent) s.errors.push('Contenuto della confezione obbligatorio.')
    if (!packageUnit) s.errors.push('Unità del contenuto obbligatoria.')
    if (name && names.has(name.toLowerCase())) s.warnings.push('Esiste già un ingrediente con lo stesso nome ma codice diverso: verrà creato un nuovo articolo (il nome non è usato per abbinare).')
  }
  if (packageContent && !d(packageContent).gt(0)) s.errors.push('Il contenuto della confezione deve essere maggiore di zero.')
  if (packagePrice && d(packagePrice).lt(0)) s.errors.push('Il prezzo non può essere negativo.')
  if (packagePrice && !priceDate) s.errors.push('Data del prezzo obbligatoria: lo storico richiede una validità esplicita.')
  if (packagePrice !== null && d(packagePrice).isZero()) s.warnings.push('Prezzo pari a zero: sarà registrato come prezzo esplicito.')
  if (yieldPct && (!d(yieldPct).gt(0) || d(yieldPct).gt(100))) s.errors.push('La resa edibile deve essere maggiore di 0 e al massimo 100.')
  if (density && !d(density).gt(0)) s.errors.push('La densità deve essere maggiore di zero.')
  if (unitWeightG && !d(unitWeightG).gt(0)) s.errors.push('Il peso unitario deve essere maggiore di zero.')
  if (hit && packageUnit && hit.unit && !sameDimension(packageUnit, hit.unit)) s.errors.push(`L’unità ${packageUnit} non è compatibile con la confezione esistente (${hit.unit}).`)
  if (s.action === 'update' && packagePrice && !packageContent && !hit) s.errors.push('Contenuto della confezione mancante.')
  const effUnit = packageUnit ?? hit?.unit ?? null
  const effUsage = usageUnit ?? (effUnit ? defaultUsageUnit(effUnit) : null)
  if (effUnit && effUsage && !sameDimension(effUnit, effUsage)) {
    const dims = [effUnit, effUsage]
    if (dims.some((u) => ['ml', 'cl', 'l'].includes(u)) && dims.some((u) => ['g', 'kg'].includes(u)) && !density) s.errors.push('Unità in ricetta e confezione di grandezze diverse: serve la densità.')
    if (dims.includes('pz') && !unitWeightG) s.errors.push('Unità in ricetta e confezione di grandezze diverse: serve il peso unitario.')
  }
  s.normalized = {
    code,
    name,
    category: field(s, 'Categoria', () => text(get('category'))),
    supplier: field(s, 'Fornitore', () => text(get('supplier'))),
    packagePrice,
    packageContent,
    packageUnit,
    priceDate,
    usageUnit: effUsage,
    edibleYieldPercent: yieldPct,
    densityKgPerL: density,
    unitWeightKg: unitWeightG ? d(unitWeightG).div(1000).toFixed() : null,
    priceSource: field(s, 'Fonte', () => text(get('priceSource'))),
  }
}

function normalizeEmployee(s: Staged, get: (k: string) => Cell | undefined, o: ImportOptions, existing: Map<string, { id: string }>, names: Set<string>) {
  const code = field(s, 'Codice', () => text(get('code')))
  const firstName = field(s, 'Nome', () => text(get('firstName')))
  const lastName = field(s, 'Cognome', () => text(get('lastName')))
  const gross = field(s, 'Lordo mensile', () => number(get('grossMonthly'), o))
  const hours = field(s, 'Ore produttive', () => number(get('productiveHours'), o))
  const validFrom = field(s, 'Decorrenza', () => date(get('validFrom')))
  let mode = field(s, 'Modalità oneri', () => contributionsMode(get('contributionsMode')))
  const cValue = field(s, 'Oneri', () => number(get('contributionsValue'), o))
  const other = field(s, 'Altri costi', () => number(get('otherMonthlyCosts'), o))
  const statusText = field(s, 'Stato', () => text(get('status'))?.toLowerCase() ?? null)

  const generated = !code && o.generateCodes
  if (!code && !o.generateCodes) s.errors.push('Codice dipendente mancante: senza codice non è possibile abbinare la riga.')
  decideAction(s, code, o, existing, generated)
  if (s.action === 'create') {
    if (!firstName || !lastName) s.errors.push('Nome e cognome obbligatori per un nuovo dipendente.')
    if (firstName && lastName && names.has(`${firstName} ${lastName}`.toLowerCase())) s.warnings.push('Esiste già un dipendente con lo stesso nome ma codice diverso: verrà creato un nuovo dipendente.')
  }
  if (gross === null) s.errors.push('Lordo mensile obbligatorio.')
  else if (d(gross).lt(0)) s.errors.push('Il lordo mensile non può essere negativo.')
  if (hours === null) s.errors.push('Ore produttive mensili obbligatorie.')
  else if (!d(hours).gt(0) || d(hours).gt(744)) s.errors.push('Le ore produttive devono essere maggiori di zero e plausibili (massimo 744).')
  if (!validFrom) s.errors.push('Decorrenza obbligatoria.')
  if (mode === null) mode = cValue ? null : 'none'
  if (mode === null) s.errors.push('Indica la modalità degli oneri (importo o percentuale): non viene dedotta.')
  if (mode === 'none' && cValue && !d(cValue).isZero()) s.errors.push('Modalità “nessuno” con un valore di oneri: dati contraddittori.')
  if ((mode === 'amount' || mode === 'percent') && cValue === null) s.errors.push('Valore degli oneri mancante.')
  if (cValue && d(cValue).lt(0)) s.errors.push('Gli oneri non possono essere negativi.')
  if (mode === 'percent' && cValue && d(cValue).gt(200)) s.errors.push('Percentuale oneri non plausibile (oltre 200%).')
  if (other && d(other).lt(0)) s.errors.push('Gli altri costi non possono essere negativi.')
  let status: 'active' | 'inactive' | null = null
  if (statusText) {
    if (['attivo', 'attiva', 'active', 'si', 'sì'].includes(statusText)) status = 'active'
    else if (['non attivo', 'inattivo', 'inactive', 'no', 'cessato'].includes(statusText)) status = 'inactive'
    else s.errors.push(`Stato “${statusText}” non riconosciuto (attivo / non attivo).`)
  }
  s.normalized = {
    code,
    firstName,
    lastName,
    jobTitle: field(s, 'Mansione', () => text(get('jobTitle'))),
    status,
    grossMonthly: gross,
    productiveHours: hours,
    validFrom,
    contributionsMode: mode,
    contributionsValue: mode === 'none' ? null : cValue,
    otherMonthlyCosts: other,
  }
}

/** Prezzo/configurazione già presente alla stessa data: identico → ignorato; diverso → errore. */
async function checkHistoryConflicts(db: Kysely<DB>, type: ImportType, rows: Staged[]) {
  if (!rows.length) return
  if (type === 'ingredients') {
    const withPrice = rows.filter((r) => r.normalized!.packagePrice !== null && r.normalized!.priceDate)
    if (!withPrice.length) return
    const found = await db
      .selectFrom('ingredient_prices')
      .select(['ingredient_id', 'valid_from', 'package_price', 'package_content', 'package_unit'])
      .where('ingredient_id', 'in', withPrice.map((r) => r.target_id!))
      .execute()
    for (const r of withPrice) {
      const n = r.normalized!
      const same = found.find((f) => f.ingredient_id === r.target_id && f.valid_from === n.priceDate)
      if (!same) continue
      const identical = d(same.package_price).eq(n.packagePrice as string) && (!n.packageContent || d(same.package_content).eq(n.packageContent as string)) && (!n.packageUnit || same.package_unit === n.packageUnit)
      if (identical) {
        n.priceDuplicate = true
        r.warnings.push('Prezzo identico già presente con la stessa data: non verrà duplicato.')
      } else r.errors.push(`Esiste già un prezzo diverso con data ${n.priceDate}: modifica la data o elimina il prezzo esistente.`)
    }
  } else {
    const found = await db
      .selectFrom('employee_cost_configs')
      .select(['employee_id', 'valid_from', 'gross_monthly', 'contributions_mode', 'contributions_value', 'other_monthly_costs', 'productive_hours'])
      .where('employee_id', 'in', rows.map((r) => r.target_id!))
      .execute()
    for (const r of rows) {
      const n = r.normalized!
      const same = found.find((f) => f.employee_id === r.target_id && f.valid_from === n.validFrom)
      if (!same) continue
      const eq = (a: string | null, b: unknown) => (a === null || b === null || b === undefined ? (a ?? '0') === String(b ?? '0') || d(a ?? 0).eq(String(b ?? 0)) : d(a).eq(String(b)))
      const identical =
        eq(same.gross_monthly, n.grossMonthly) &&
        eq(same.productive_hours, n.productiveHours) &&
        same.contributions_mode === n.contributionsMode &&
        eq(same.contributions_value, n.contributionsValue) &&
        eq(same.other_monthly_costs, n.otherMonthlyCosts ?? '0')
      if (identical) {
        n.configDuplicate = true
        r.warnings.push('Configurazione di costo identica già presente con la stessa decorrenza: non verrà duplicata.')
      } else r.errors.push(`Esiste già una configurazione diversa con decorrenza ${n.validFrom}.`)
    }
  }
}
