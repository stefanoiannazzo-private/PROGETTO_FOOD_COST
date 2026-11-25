'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { date, dateTime, euro, num } from '@/lib/num'
import { useCan } from '@/lib/session'
import { IMPORT_STATUS as STATUS_LABEL } from '@/lib/labels'
import { PageHead } from '@/components/AppShell'
import { Empty, errorMessage, Icon, Skeleton } from '@/components/ui'

interface ImportRow {
  id: string
  type: 'ingredients' | 'employees'
  status: string
  original_name: string
  total_rows: number | null
  summary: { create: number; update: number; error: number; skip: number } | null
  created_at: string
  applied_at: string | null
  created_by: string | null
}

/** NUOVO — fatture elettroniche dei fornitori */
interface InvoiceRow {
  id: string
  status: 'draft' | 'applied'
  supplier: string
  number: string
  date: string | null
  total: string | null
  fileName: string
  lineCount: number
  summary: { created: number; prices: number; ignored: number; skipped: number } | null
  createdAt: string
  createdBy: string | null
}

interface InvoiceUpload {
  created: string[]
  duplicates: Array<{ file: string; supplier: string; number: string; date: string | null; id: string }>
  errors: Array<{ file: string; message: string }>
}


export default function ImportsPage() {
  const can = useCan()
  const router = useRouter()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['imports'], queryFn: () => api.get<{ data: ImportRow[] }>('/imports') })
  // NUOVO: ?tipo=fatture (scorciatoia dell'app installata) apre direttamente le fatture XML
  const [type, setType] = useState<'ingredients' | 'employees' | 'invoices'>(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tipo') === 'fatture' ? 'invoices' : 'ingredients',
  )
  const canInvoices = can('imports.manage') && can('ingredients.manage') && can('costs.read')
  const inv = useQuery({ queryKey: ['supplier-invoices'], queryFn: () => api.get<{ data: InvoiceRow[] }>('/supplier-invoices'), enabled: canInvoices })
  const [invResult, setInvResult] = useState<InvoiceUpload | null>(null)
  const invRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const canEmployees = can('employees.manage') && can('salaries.read')

  const upload = async (file: File) => {
    setBusy(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('type', type)
      fd.append('file', file)
      const r = await api.upload<{ id: string }>('/imports', fd)
      qc.invalidateQueries({ queryKey: ['imports'] })
      router.push(`/importazioni/${r.id}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const uploadInvoices = async (files: File[]) => {
    setBusy(true)
    setError('')
    setInvResult(null)
    try {
      const fd = new FormData()
      files.forEach((f) => fd.append('files[]', f))
      const r = await api.upload<InvoiceUpload>('/supplier-invoices', fd)
      qc.invalidateQueries({ queryKey: ['supplier-invoices'] })
      if (r.created.length === 1 && !r.duplicates.length && !r.errors.length) {
        router.push(`/importazioni/fatture/${r.created[0]}`)
        return
      }
      setInvResult(r)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead title="Importazioni" sub="Ingredienti con prezzi e dipendenti con costi da Excel o CSV, oppure le fatture elettroniche dei fornitori (XML). Nulla viene scritto prima della tua conferma." />
      <div className="stack loose">
        <div className="card">
          <div className="card-head">
            <h2>Nuova importazione</h2>
          </div>
          <div className="card-body stack">
            <div className="row wrap" style={{ gap: 16 }}>
              <label className="checkbox">
                <input type="radio" name="t" checked={type === 'ingredients'} onChange={() => setType('ingredients')} /> Ingredienti e prezzi
              </label>
              <label className="checkbox" style={{ opacity: canEmployees ? 1 : 0.5 }}>
                <input type="radio" name="t" checked={type === 'employees'} disabled={!canEmployees} onChange={() => setType('employees')} /> Dipendenti e costi del lavoro
              </label>
              <label className="checkbox" style={{ opacity: canInvoices ? 1 : 0.5 }}>
                <input type="radio" name="t" checked={type === 'invoices'} disabled={!canInvoices} onChange={() => setType('invoices')} /> Fatture dei fornitori (XML)
              </label>
            </div>
            {type === 'invoices' ? (
              <>
                <p className="small muted" style={{ margin: 0 }}>
                  Carica le fatture elettroniche che ricevi dai fornitori: i file <strong>.xml</strong> o <strong>.xml.p7m</strong>, anche più di uno insieme, oppure il <strong>.zip</strong> scaricato dal cassetto fiscale o dal tuo programma di fatturazione. Poi abbini ogni riga a un prodotto: i prezzi vengono registrati alla data della fattura, senza IVA.
                </p>
                <div className="row wrap">
                  <input
                    ref={invRef}
                    type="file"
                    multiple
                    accept=".xml,.p7m,.zip,application/xml,text/xml,application/zip"
                    hidden
                    onChange={(e) => {
                      const f = Array.from(e.target.files ?? [])
                      if (f.length) void uploadInvoices(f)
                      e.target.value = ''
                    }}
                  />
                  <button className="btn primary" disabled={busy} onClick={() => invRef.current?.click()}>
                    {busy ? <span className="spinner" /> : <Icon name="upload" />} Scegli le fatture
                  </button>
                </div>
                {invResult ? (
                  <div className="stack">
                    {invResult.created.length ? <div className="alert ok">{invResult.created.length === 1 ? '1 fattura pronta' : `${invResult.created.length} fatture pronte`} da abbinare: le trovi qui sotto.</div> : null}
                    {invResult.duplicates.length ? (
                      <div className="alert warn">
                        <div>
                          Già importate, saltate:{' '}
                          {invResult.duplicates.map((d) => `${d.supplier} n. ${d.number}${d.date ? ` del ${date(d.date)}` : ''}`).join(' · ')}
                        </div>
                      </div>
                    ) : null}
                    {!invResult.created.length && !invResult.duplicates.length && !invResult.errors.length ? <div className="alert err">Nei file caricati non c’è nessuna fattura elettronica.</div> : null}
                    {invResult.errors.length ? (
                      <div className="alert err">
                        <div>
                          Non lette:{' '}
                          {invResult.errors.map((x) => `${x.file}: ${x.message}`).join(' · ')}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {error ? <div className="alert err">{error}</div> : null}
              </>
            ) : (
            <>
            <div className="row wrap">
              <span className="muted small">1. Scarica il modello:</span>
              <a className="btn sm" href={`/api/imports/templates/${type}.xlsx`}>
                <Icon name="download" /> Modello Excel
              </a>
              <a className="btn sm" href={`/api/imports/templates/${type}.csv`}>
                <Icon name="download" /> Modello CSV
              </a>
            </div>
            <div className="row wrap">
              <span className="muted small">2. Carica il file compilato (.xlsx o .csv):</span>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void upload(f)
                  e.target.value = ''
                }}
              />
              <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
                {busy ? <span className="spinner" /> : <Icon name="upload" />} Scegli file
              </button>
            </div>
            {error ? <div className="alert err">{error}</div> : null}
            <p className="faint small">Poi verificherai colonne, anteprima ed errori; solo dopo la conferma esplicita i dati vengono scritti, tutti insieme o nessuno.</p>
            </>
            )}
          </div>
        </div>

        {canInvoices && inv.data && inv.data.data.length ? (
          <div className="card">
            <div className="card-head">
              <h2>Fatture dei fornitori</h2>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Fornitore</th>
                  <th>Fattura</th>
                  <th>Stato</th>
                  <th className="num">Totale</th>
                  <th>Esito</th>
                </tr>
              </thead>
              <tbody>
                {inv.data.data.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link className="link" href={`/importazioni/fatture/${i.id}`}>
                        {i.supplier}
                      </Link>
                    </td>
                    <td className="small">
                      n. {i.number}
                      {i.date ? ` del ${date(i.date)}` : ''}
                    </td>
                    <td>{i.status === 'draft' ? <span className="badge warn">Da abbinare</span> : <span className="badge ok">Importata</span>}</td>
                    <td className="num">{i.total ? euro(i.total) : '—'}</td>
                    <td className="small">{i.summary ? `${i.summary.created} nuovi · ${i.summary.prices} prezzi · ${i.summary.ignored} ignorate` : `${i.lineCount} righe`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="card">
          <div className="card-head">
            <h2>Storico</h2>
          </div>
          {!q.data ? (
            <Skeleton />
          ) : q.data.data.length === 0 ? (
            <Empty title="Nessuna importazione">Le importazioni eseguite compariranno qui con il loro esito.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Tipo</th>
                  <th>Stato</th>
                  <th className="num">Righe</th>
                  <th>Esito</th>
                  <th>Caricato</th>
                </tr>
              </thead>
              <tbody>
                {q.data.data.map((i) => {
                  const [label, cls] = STATUS_LABEL[i.status] ?? [i.status, '']
                  return (
                    <tr key={i.id}>
                      <td>
                        <Link className="link" href={`/importazioni/${i.id}`}>
                          {i.original_name}
                        </Link>
                      </td>
                      <td>{i.type === 'ingredients' ? 'Ingredienti' : 'Dipendenti'}</td>
                      <td>
                        <span className={`badge ${cls}`}>{label}</span>
                      </td>
                      <td className="num">{i.total_rows !== null ? num(i.total_rows) : '—'}</td>
                      <td className="small">{i.summary ? `${i.summary.create} nuovi · ${i.summary.update} aggiornati · ${i.summary.error} errori` : '—'}</td>
                      <td className="small faint">
                        {dateTime(i.created_at)} {i.created_by ? `· ${i.created_by}` : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  )
}
