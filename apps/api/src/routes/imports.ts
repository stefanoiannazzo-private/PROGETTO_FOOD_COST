import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import ExcelJS from 'exceljs'
import { sql } from 'kysely'
import { z } from 'zod'
import { can, parse, requireCompany } from '../http/context'
import { badRequest, conflict, forbidden, notFound } from '../http/errors'
import { audit } from '../services/audit'
import { enqueue } from '../services/jobs'
import { FIELDS, suggestMapping, type ImportType } from '../services/imports/fields'
import { cellText, detectDelimiter, detectEncoding, listSheets, readRows } from '../services/imports/reader'
import { DEFAULT_OPTIONS, type ImportOptions } from '../services/imports/validate'

const typeParam = z.enum(['ingredients', 'employees'])
const optionsSchema = z.object({
  sheet: z.string().max(120).nullable().optional(),
  delimiter: z.enum([';', ',', '\t']).optional(),
  encoding: z.enum(['utf8', 'latin1']).optional(),
  headerRow: z.coerce.number().int().min(1).max(50).default(1),
  numberFormat: z.enum(['it', 'en', 'auto']).default('it'),
  onExisting: z.enum(['update', 'skip']).default('update'),
  onNew: z.enum(['create', 'skip']).default('create'),
  generateCodes: z.boolean().default(true),
})

/** Neutralizza le celle che un foglio di calcolo interpreterebbe come formule (CSV/formula injection). */
export function safeCsvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function importRoutes(app: FastifyInstance) {
  const db = app.database.db
  const cfg = app.cfg

  /** Permessi richiesti: le importazioni dipendenti scrivono dati retributivi. */
  function ctxFor(req: FastifyRequest, type: ImportType) {
    const ctx = requireCompany(req, 'imports.manage')
    if (type === 'ingredients' && !can(ctx, 'ingredients.manage')) throw forbidden()
    if (type === 'employees' && (!can(ctx, 'employees.manage') || !can(ctx, 'salaries.read'))) throw forbidden('Per importare i dipendenti servono la gestione dipendenti e la lettura delle retribuzioni.')
    return ctx
  }

  async function loadImport(req: FastifyRequest) {
    const ctx = requireCompany(req, 'imports.manage')
    const { id } = parse(z.object({ id: z.uuid() }), req.params)
    const imp = await db.selectFrom('imports').selectAll().where('id', '=', id).where('company_id', '=', ctx.companyId).executeTakeFirst()
    if (!imp) throw notFound('Importazione')
    ctxFor(req, imp.type)
    return { ctx, imp }
  }

  async function previewFile(path: string, kind: 'csv' | 'xlsx', opts: Partial<ImportOptions>, type: ImportType) {
    const sheets = kind === 'xlsx' ? await listSheets(path) : []
    let delimiter = opts.delimiter
    let encoding = opts.encoding
    if (kind === 'csv') {
      const fh = await open(path, 'r')
      const buf = Buffer.alloc(64 * 1024)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      await fh.close()
      const sample = buf.subarray(0, bytesRead)
      encoding ??= detectEncoding(sample)
      delimiter ??= detectDelimiter(new TextDecoder(encoding === 'latin1' ? 'windows-1252' : 'utf-8').decode(sample))
    }
    const headerRow = opts.headerRow ?? 1
    const rows: string[][] = []
    for await (const r of readRows(path, kind, { sheet: opts.sheet ?? null, delimiter, encoding })) {
      rows.push(r.cells.map((c) => cellText(c)))
      if (rows.length >= headerRow + 8) break
    }
    const headers = (rows[headerRow - 1] ?? []).map((h, i) => h || `Colonna ${i + 1}`)
    return {
      sheets,
      detected: { delimiter: delimiter ?? null, encoding: encoding ?? null, sheet: opts.sheet ?? sheets[0] ?? null, headerRow },
      headers,
      sample: rows.slice(headerRow, headerRow + 8),
      firstRows: rows.slice(0, Math.min(rows.length, headerRow + 2)),
      suggestedMapping: suggestMapping(type, headers),
    }
  }

  app.get('/imports/fields/:type', async (req) => {
    const { type } = parse(z.object({ type: typeParam }), req.params)
    ctxFor(req, type)
    return { data: FIELDS[type], limits: { maxBytes: cfg.importMaxBytes, maxRows: cfg.importMaxRows, retentionDays: cfg.importRetentionDays } }
  })

  /** Modello scaricabile con colonne, esempio e spiegazioni (foglio “Istruzioni”). */
  app.get('/imports/templates/:file', async (req, reply) => {
    const { file } = parse(z.object({ file: z.string().regex(/^(ingredients|employees)\.(csv|xlsx)$/) }), req.params)
    const [type, ext] = file.split('.') as [ImportType, 'csv' | 'xlsx']
    ctxFor(req, type)
    const fields = FIELDS[type]
    const name = type === 'ingredients' ? 'modello-ingredienti' : 'modello-dipendenti'
    if (ext === 'csv') {
      const lines = [fields.map((f) => f.label).join(';'), fields.map((f) => safeCsvCell(f.example)).join(';')]
      reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}.csv"`)
      return `﻿${lines.join('\r\n')}\r\n`
    }
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Dati')
    ws.addRow(fields.map((f) => f.label)).font = { bold: true }
    ws.addRow(fields.map((f) => f.example))
    fields.forEach((f, i) => (ws.getColumn(i + 1).width = Math.max(14, f.label.length + 4)))
    const help = wb.addWorksheet('Istruzioni')
    help.addRow(['Colonna', 'Obbligatoria', 'Descrizione', 'Esempio']).font = { bold: true }
    for (const f of fields) help.addRow([f.label, f.required ? 'sì' : 'no', f.help, f.example])
    help.addRow([])
    help.addRow(['Note', '', 'Importi netti IVA. Numeri con la virgola decimale (1.234,56). Date gg/mm/aaaa. Inserire valori, non formule. Il codice è la chiave di abbinamento: il nome non basta per aggiornare.'])
    help.getColumn(1).width = 26
    help.getColumn(3).width = 90
    help.getColumn(4).width = 18
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="${name}.xlsx"`)
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()))
  })

  app.get('/imports', async (req) => {
    const ctx = requireCompany(req, 'imports.manage')
    const rows = await db
      .selectFrom('imports as i')
      .leftJoin('users as u', 'u.id', 'i.created_by')
      .select(['i.id', 'i.type', 'i.status', 'i.original_name', 'i.file_kind', 'i.total_rows', 'i.summary', 'i.created_at', 'i.applied_at', 'i.error', 'u.name as created_by'])
      .where('i.company_id', '=', ctx.companyId)
      .orderBy('i.created_at', 'desc')
      .limit(50)
      .execute()
    return { data: rows.filter((r) => r.type === 'ingredients' || can(ctx, 'salaries.read')) }
  })

  /** Caricamento in storage privato (fuori dalla cartella pubblica), con limiti di dimensione e tipo. */
  app.post('/imports', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req) => {
    const ctx = requireCompany(req, 'imports.manage')
    const file = await req.file()
    if (!file) throw badRequest('no_file', 'Nessun file caricato.')
    const type = parse(typeParam, (file.fields.type as { value?: string } | undefined)?.value)
    ctxFor(req, type)
    const lower = file.filename.toLowerCase()
    const kind = lower.endsWith('.xlsx') ? 'xlsx' : lower.endsWith('.csv') ? 'csv' : null
    if (!kind) {
      file.file.resume()
      throw badRequest('unsupported_type', lower.endsWith('.xls') ? 'Il formato .xls non è supportato: salva il file come .xlsx o .csv.' : 'Formato non supportato: usa .xlsx o .csv.')
    }
    const id = randomUUID()
    const rel = join('imports', ctx.companyId, `${id}.${kind}`)
    const abs = join(cfg.storageDir, rel)
    await mkdir(join(cfg.storageDir, 'imports', ctx.companyId), { recursive: true, mode: 0o700 })
    await pipeline(file.file, createWriteStream(abs, { mode: 0o600 }))
    if (file.file.truncated) {
      await rm(abs, { force: true })
      throw badRequest('file_too_large', `File troppo grande (massimo ${Math.round(cfg.importMaxBytes / 1048576)} MB).`)
    }
    const size = (await stat(abs)).size
    // controllo del contenuto reale: un .xlsx è un archivio ZIP, un CSV non contiene byte nulli
    const fh = await open(abs, 'r')
    const head = Buffer.alloc(4096)
    const { bytesRead } = await fh.read(head, 0, head.length, 0)
    await fh.close()
    const ok = kind === 'xlsx' ? head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) : !head.subarray(0, bytesRead).includes(0)
    if (!ok || size === 0) {
      await rm(abs, { force: true })
      throw badRequest('invalid_file', 'Il contenuto del file non corrisponde al formato indicato.')
    }
    let preview
    try {
      preview = await previewFile(abs, kind, {}, type)
    } catch {
      await rm(abs, { force: true })
      throw badRequest('unreadable', 'Il file non può essere letto: verifica che non sia protetto da password o danneggiato.')
    }
    const options: ImportOptions = { ...DEFAULT_OPTIONS, sheet: preview.detected.sheet, delimiter: (preview.detected.delimiter ?? undefined) as ImportOptions['delimiter'], encoding: (preview.detected.encoding ?? undefined) as ImportOptions['encoding'] }
    await db
      .insertInto('imports')
      .values({
        id,
        company_id: ctx.companyId,
        type,
        original_name: file.filename.slice(0, 200),
        storage_path: rel,
        file_size: size,
        file_kind: kind,
        options: JSON.stringify(options),
        mapping: JSON.stringify(preview.suggestedMapping),
        created_by: ctx.user.id,
      })
      .execute()
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'import', entityId: id, action: 'uploaded', details: { type, file: file.filename, size } })
    return { id, options, ...preview }
  })

  app.get('/imports/:id', async (req) => {
    const { imp } = await loadImport(req)
    return {
      id: imp.id,
      type: imp.type,
      status: imp.status,
      originalName: imp.original_name,
      fileKind: imp.file_kind,
      fileSize: imp.file_size,
      options: imp.options,
      mapping: imp.mapping,
      summary: imp.summary,
      progress: imp.progress,
      totalRows: imp.total_rows,
      error: imp.error,
      createdAt: imp.created_at,
      validatedAt: imp.validated_at,
      appliedAt: imp.applied_at,
      lockVersion: imp.lock_version,
      fileAvailable: imp.storage_path !== '',
      fields: FIELDS[imp.type],
    }
  })

  /** Anteprima del file con opzioni diverse (foglio, separatore, codifica, riga di intestazione). */
  app.post('/imports/:id/preview', async (req) => {
    const { imp } = await loadImport(req)
    if (!imp.storage_path) throw conflict('expired', 'Il file non è più disponibile (periodo di conservazione scaduto).')
    const opts = parse(optionsSchema, req.body)
    return previewFile(join(cfg.storageDir, imp.storage_path), imp.file_kind, opts, imp.type)
  })

  /** Salva opzioni e abbinamento colonne e avvia la validazione completa (asincrona). */
  app.post('/imports/:id/validate', async (req) => {
    const { ctx, imp } = await loadImport(req)
    if (['applying', 'applied'].includes(imp.status)) throw conflict('locked', 'L’importazione è già stata applicata o è in corso.')
    if (!imp.storage_path) throw conflict('expired', 'Il file non è più disponibile.')
    const body = parse(z.object({ options: optionsSchema, mapping: z.record(z.string(), z.string().nullable()) }), req.body)
    // le opzioni non indicate (es. codifica e separatore rilevati al caricamento) restano quelle salvate
    const options = { ...(imp.options as object), ...Object.fromEntries(Object.entries(body.options).filter(([, v]) => v !== undefined)) }
    const allowed = new Set(FIELDS[imp.type].map((f) => f.key))
    const mapping = Object.fromEntries(Object.entries(body.mapping).filter(([k]) => allowed.has(k)))
    const used = Object.values(mapping).filter(Boolean)
    if (new Set(used).size !== used.length) throw badRequest('validation_failed', 'La stessa colonna è abbinata a più campi.')
    await db
      .updateTable('imports')
      .set({ options: JSON.stringify(options), mapping: JSON.stringify(mapping), status: 'validating', progress: 0, summary: null, error: null, validated_at: null, lock_version: sql`lock_version + 1` })
      .where('id', '=', imp.id)
      .execute()
    await enqueue(db, 'import.validate', { importId: imp.id }, `validate:${imp.id}:${imp.lock_version + 1}`)
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'import', entityId: imp.id, action: 'validation_requested' })
    return { ok: true, status: 'validating' }
  })

  /** Righe validate con valori normalizzati, filtrabili per esito. */
  app.get('/imports/:id/rows', async (req) => {
    const { imp } = await loadImport(req)
    const q = parse(z.object({ action: z.enum(['all', 'create', 'update', 'skip', 'error', 'warning']).default('all'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }), req.query)
    let query = db.selectFrom('import_rows').where('import_id', '=', imp.id)
    if (q.action === 'warning') query = query.where('warnings', 'is not', null)
    else if (q.action !== 'all') query = query.where('action', '=', q.action)
    const rows = await query
      .select(['row_number', 'raw', 'normalized', 'action', 'errors', 'warnings', sql<string>`count(*) over()`.as('total_count')])
      .orderBy('row_number')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .execute()
    return { data: rows.map(({ total_count: _t, ...r }) => r), meta: { page: q.page, pageSize: q.pageSize, total: Number(rows[0]?.total_count ?? 0) } }
  })

  /** Conferma esplicita: una seconda conferma non produce effetti duplicati. */
  app.post('/imports/:id/confirm', async (req) => {
    const { ctx, imp } = await loadImport(req)
    const body = parse(z.object({ lockVersion: z.number().int() }), req.body)
    if (imp.status === 'applying' || imp.status === 'applied') return { ok: true, status: imp.status, alreadyConfirmed: true }
    if (imp.status !== 'validated') throw conflict('not_validated', 'Valida il file prima di confermare.')
    if (imp.lock_version !== body.lockVersion) throw conflict('stale', 'Le opzioni dell’importazione sono cambiate: rivedi il riepilogo prima di confermare.')
    const summary = imp.summary as { error?: number }
    if ((summary?.error ?? 0) > 0) throw conflict('has_errors', 'Ci sono righe con errori: correggi il file e caricalo di nuovo. In modalità atomica nessuna riga viene applicata.')
    const upd = await db
      .updateTable('imports')
      .set({ status: 'applying', confirmed_at: new Date() })
      .where('id', '=', imp.id)
      .where('status', '=', 'validated')
      .where('lock_version', '=', body.lockVersion)
      .executeTakeFirst()
    if (!upd.numUpdatedRows) return { ok: true, status: 'applying', alreadyConfirmed: true }
    await enqueue(db, 'import.apply', { importId: imp.id }, `apply:${imp.id}:${body.lockVersion}`)
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'import', entityId: imp.id, action: 'confirmed' })
    return { ok: true, status: 'applying' }
  })

  app.post('/imports/:id/cancel', async (req) => {
    const { ctx, imp } = await loadImport(req)
    if (['applying', 'applied'].includes(imp.status)) throw conflict('locked', 'Un’importazione applicata o in corso non può essere annullata.')
    await db.updateTable('imports').set({ status: 'cancelled' }).where('id', '=', imp.id).execute()
    if (imp.storage_path) await rm(join(cfg.storageDir, imp.storage_path), { force: true })
    await db.updateTable('imports').set({ storage_path: '' }).where('id', '=', imp.id).execute()
    await db.deleteFrom('import_rows').where('import_id', '=', imp.id).execute()
    await audit(db, { companyId: ctx.companyId, userId: ctx.user.id, entityType: 'import', entityId: imp.id, action: 'cancelled' })
    return { ok: true }
  })

  /** Report scaricabile delle righe (errori e avvisi), protetto da formula injection. */
  app.get('/imports/:id/report.csv', async (req, reply) => {
    const { imp } = await loadImport(req)
    const q = parse(z.object({ only: z.enum(['errors', 'all']).default('errors') }), req.query)
    const label: Record<string, string> = { create: 'Nuovo', update: 'Aggiornamento', skip: 'Ignorata', error: 'Errore' }
    // l'ordine delle colonne originali è salvato nel riepilogo (il JSON del database non lo conserva)
    let headers: string[] | null = ((imp.summary as { headers?: string[] } | null)?.headers ?? null)
    const lines: string[] = []
    let offset = 0
    for (;;) {
      let query = db.selectFrom('import_rows').select(['row_number', 'raw', 'action', 'errors', 'warnings']).where('import_id', '=', imp.id)
      if (q.only === 'errors') query = query.where((eb) => eb.or([eb('action', '=', 'error'), eb('warnings', 'is not', null)]))
      const rows = await query.orderBy('row_number').limit(1000).offset(offset).execute()
      if (!rows.length) break
      offset += rows.length
      for (const r of rows) {
        const raw = r.raw as Record<string, string>
        headers ??= Object.keys(raw)
        lines.push([r.row_number, label[r.action ?? ''] ?? '', ((r.errors as string[]) ?? []).join(' | '), ((r.warnings as string[]) ?? []).join(' | '), ...headers.map((h) => raw[h])].map(safeCsvCell).join(';'))
      }
    }
    const head = ['Riga', 'Esito', 'Errori', 'Avvisi', ...(headers ?? [])].map(safeCsvCell).join(';')
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="report-importazione-${imp.id.slice(0, 8)}.csv"`)
    return `﻿${[head, ...lines].join('\r\n')}\r\n`
  })
}
