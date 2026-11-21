'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { IMPORT_STATUS } from '@/lib/labels'
import { dateTime, num } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { Confirm, ErrorBox, errorMessage, Field, Icon, Skeleton, useToast } from '@/components/ui'

interface FieldDef {
  key: string
  label: string
  required: boolean
  help: string
}
interface Options {
  sheet?: string | null
  delimiter?: string
  encoding?: string
  headerRow: number
  numberFormat: 'it' | 'en' | 'auto'
  onExisting: 'update' | 'skip'
  onNew: 'create' | 'skip'
  generateCodes: boolean
}
interface Imp {
  id: string
  type: 'ingredients' | 'employees'
  status: string
  originalName: string
  fileKind: 'csv' | 'xlsx'
  options: Options
  mapping: Record<string, string | null> | null
  summary: { totalRows: number; create: number; update: number; skip: number; error: number; warnings: number; duplicates: number } | null
  progress: number
  totalRows: number | null
  error: string | null
  createdAt: string
  validatedAt: string | null
  appliedAt: string | null
  lockVersion: number
  fileAvailable: boolean
  fields: FieldDef[]
}
interface Preview {
  sheets: string[]
  detected: { delimiter: string | null; encoding: string | null; sheet: string | null; headerRow: number }
  headers: string[]
  sample: string[][]
}

export default function ImportDetailPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const toast = useToast()
  const imp = useQuery({
    queryKey: ['imports', id],
    queryFn: () => api.get<Imp>(`/imports/${id}`),
    // durante validazione e applicazione si aggiorna l'avanzamento
    refetchInterval: (q) => (['validating', 'applying'].includes(q.state.data?.status ?? '') ? 700 : false),
  })
  const [options, setOptions] = useState<Options | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [filter, setFilter] = useState<'all' | 'create' | 'update' | 'error' | 'warning' | 'skip'>('all')
  const [page, setPage] = useState(1)
  const d = imp.data

  useEffect(() => {
    if (d && !options) {
      setOptions(d.options)
      setMapping(d.mapping ?? {})
    }
  }, [d, options])

  // anteprima del file con le opzioni correnti (foglio, separatore, codifica, intestazione)
  const editable = d && ['uploaded', 'validated', 'failed'].includes(d.status) && d.fileAvailable
  const optKey = options ? JSON.stringify([options.sheet, options.delimiter, options.encoding, options.headerRow]) : ''
  useEffect(() => {
    if (!options || !editable) return
    let cancelled = false
    api
      .post<Preview>(`/imports/${id}/preview`, options)
      .then((p) => {
        if (cancelled) return
        setPreview(p)
        setPreviewError('')
        setMapping((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v && p.headers.includes(v) ? v : null])))
      })
      .catch((e) => !cancelled && setPreviewError(errorMessage(e)))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optKey, editable])

  const rows = useQuery({
    queryKey: ['imports', id, 'rows', filter, page, d?.validatedAt],
    queryFn: () => api.get<{ data: Array<{ row_number: number; normalized: Record<string, unknown> | null; action: string; errors: string[] | null; warnings: string[] | null; raw: Record<string, string> }>; meta: { total: number } }>(`/imports/${id}/rows`, { action: filter, page, pageSize: 50 }),
    enabled: !!d?.summary,
    placeholderData: keepPreviousData,
  })

  if (imp.error) return <ErrorBox error={imp.error} />
  if (!d || !options) return <Skeleton rows={8} />
  const [statusLabel, statusCls] = IMPORT_STATUS[d.status] ?? [d.status, '']
  const set = (p: Partial<Options>) => setOptions((o) => ({ ...o!, ...p }))
  const missing = d.fields.filter((f) => f.required && f.key !== 'code' && !mapping[f.key])

  const startValidation = async () => {
    try {
      await api.post(`/imports/${id}/validate`, { options, mapping })
      await imp.refetch()
    } catch (e) {
      toast(errorMessage(e), 'err')
    }
  }

  return (
    <>
      <PageHead
        title={d.originalName}
        sub={
          <span className="row wrap">
            <span className={`badge ${statusCls}`}>{statusLabel}</span>
            <span>{d.type === 'ingredients' ? 'Ingredienti e prezzi' : 'Dipendenti e costi'}</span>
            <span className="faint small">caricato {dateTime(d.createdAt)}</span>
            <Link className="link small" href="/importazioni">
              Tutte le importazioni
            </Link>
          </span>
        }
        actions={
          editable ? (
            <button
              className="btn ghost"
              onClick={async () => {
                await api.post(`/imports/${id}/cancel`)
                qc.invalidateQueries({ queryKey: ['imports'] })
                imp.refetch()
              }}
            >
              Annulla importazione
            </button>
          ) : null
        }
      />
      <div className="stack loose">
        {d.error ? (
          <div className="alert err">
            <Icon name="alert" />
            <div>{d.error}</div>
          </div>
        ) : null}

        {d.status === 'applied' ? (
          <div className="alert ok">
            <Icon name="check" />
            <div>
              Importazione applicata il {dateTime(d.appliedAt)}: {d.summary?.create ?? 0} nuovi, {d.summary?.update ?? 0} aggiornati, {d.summary?.skip ?? 0} ignorati. Le valorizzazioni delle ricette interessate sono state aggiornate.
            </div>
          </div>
        ) : null}

        {editable ? (
          <>
            <div className="card">
              <div className="card-head">
                <h2>Lettura del file</h2>
              </div>
              <div className="card-body grid-4">
                {d.fileKind === 'xlsx' ? (
                  <Field label="Foglio" htmlFor="o-sheet">
                    <select id="o-sheet" className="input" value={options.sheet ?? ''} onChange={(e) => set({ sheet: e.target.value })}>
                      {preview?.sheets.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <>
                    <Field label="Separatore" htmlFor="o-del">
                      <select id="o-del" className="input" value={options.delimiter ?? ';'} onChange={(e) => set({ delimiter: e.target.value })}>
                        <option value=";">Punto e virgola ( ; )</option>
                        <option value=",">Virgola ( , )</option>
                        <option value={'\t'}>Tabulazione</option>
                      </select>
                    </Field>
                    <Field label="Codifica" htmlFor="o-enc">
                      <select id="o-enc" className="input" value={options.encoding ?? 'utf8'} onChange={(e) => set({ encoding: e.target.value })}>
                        <option value="utf8">UTF-8</option>
                        <option value="latin1">Windows (Excel italiano)</option>
                      </select>
                    </Field>
                  </>
                )}
                <Field label="Riga delle intestazioni" htmlFor="o-head">
                  <input id="o-head" className="input" type="number" min={1} max={50} value={options.headerRow} onChange={(e) => set({ headerRow: Math.max(1, Number(e.target.value) || 1) })} />
                </Field>
                <Field label="Formato dei numeri" htmlFor="o-num">
                  <select id="o-num" className="input" value={options.numberFormat} onChange={(e) => set({ numberFormat: e.target.value as Options['numberFormat'] })}>
                    <option value="it">Italiano (1.234,56)</option>
                    <option value="en">Inglese (1,234.56)</option>
                    <option value="auto">Automatico</option>
                  </select>
                </Field>
              </div>
              {previewError ? <div className="card-body"><div className="alert err">{previewError}</div></div> : null}
              {preview ? (
                <div className="table-wrap" style={{ borderTop: '1px solid var(--border)' }}>
                  <table className="table compact">
                    <thead>
                      <tr>
                        {preview.headers.map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.slice(0, 5).map((r, i) => (
                        <tr key={i}>
                          {preview.headers.map((_, j) => (
                            <td key={j} className="small">
                              {r[j] ?? ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Abbinamento delle colonne</h2>
                <span className="faint small">il codice è la chiave: il nome non basta per aggiornare</span>
              </div>
              <div className="card-body grid-3">
                {d.fields.map((f) => (
                  <Field key={f.key} label={f.label} required={f.required && f.key !== 'code'} hint={f.help} htmlFor={`m-${f.key}`}>
                    <select id={`m-${f.key}`} className="input" value={mapping[f.key] ?? ''} aria-invalid={f.required && f.key !== 'code' && !mapping[f.key]} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || null })}>
                      <option value="">— non importare —</option>
                      {preview?.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Regole</h2>
              </div>
              <div className="card-body grid-3">
                <Field label="Codici già esistenti" htmlFor="p-ex">
                  <select id="p-ex" className="input" value={options.onExisting} onChange={(e) => set({ onExisting: e.target.value as Options['onExisting'] })}>
                    <option value="update">Aggiorna</option>
                    <option value="skip">Ignora la riga</option>
                  </select>
                </Field>
                <Field label="Codici nuovi" htmlFor="p-new">
                  <select id="p-new" className="input" value={options.onNew} onChange={(e) => set({ onNew: e.target.value as Options['onNew'] })}>
                    <option value="create">Crea</option>
                    <option value="skip">Ignora la riga</option>
                  </select>
                </Field>
                <Field label="Righe nuove senza codice" htmlFor="p-gen">
                  <select id="p-gen" className="input" value={options.generateCodes ? '1' : '0'} onChange={(e) => set({ generateCodes: e.target.value === '1' })}>
                    <option value="1">Genera il codice (con avviso)</option>
                    <option value="0">Segnala come errore</option>
                  </select>
                </Field>
              </div>
              <div className="card-body row" style={{ borderTop: '1px solid var(--border)' }}>
                {missing.length ? <span className="small" style={{ color: 'var(--err)' }}>Abbina: {missing.map((f) => f.label).join(', ')}</span> : <span className="faint small">La validazione controlla tutte le righe senza scrivere nulla.</span>}
                <div className="grow" />
                <button className="btn primary" disabled={missing.length > 0} onClick={startValidation}>
                  {d.summary ? 'Valida di nuovo' : 'Valida il file'}
                </button>
              </div>
            </div>
          </>
        ) : null}

        {d.status === 'validating' || d.status === 'applying' ? (
          <div className="card card-body row">
            <span className="spinner" />
            {d.status === 'validating' ? `Validazione in corso: ${num(d.progress)} righe lette…` : 'Applicazione in corso: tutte le righe vengono scritte insieme…'}
          </div>
        ) : null}

        {d.summary && d.status !== 'validating' ? (
          <div className="card">
            <div className="card-head">
              <h2>Riepilogo</h2>
              <a className="btn sm" href={`/api/imports/${id}/report.csv`}>
                <Icon name="download" /> Report errori e avvisi
              </a>
            </div>
            <div className="card-body stack">
              <div className="kpis">
                {(
                  [
                    ['Righe lette', d.summary.totalRows, 'all', ''],
                    ['Nuovi', d.summary.create, 'create', ''],
                    ['Aggiornamenti', d.summary.update, 'update', ''],
                    ['Ignorate', d.summary.skip, 'skip', ''],
                    ['Errori', d.summary.error, 'error', d.summary.error ? 'var(--err)' : 'var(--ok)'],
                    ['Avvisi', d.summary.warnings, 'warning', d.summary.warnings ? 'var(--warn)' : ''],
                  ] as const
                ).map(([label, value, f, color]) => (
                  <button
                    key={label}
                    className="kpi"
                    style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', outline: filter === f ? '2px solid var(--accent)' : undefined }}
                    onClick={() => {
                      setFilter(f)
                      setPage(1)
                    }}
                  >
                    <div className="k-label">{label}</div>
                    <div className="k-value" style={{ color: color || undefined }}>
                      {num(value)}
                    </div>
                  </button>
                ))}
              </div>
              {d.status === 'validated' ? (
                d.summary.error > 0 ? (
                  <div className="alert err">
                    <Icon name="alert" />
                    <div>Ci sono {d.summary.error} righe con errori. L’importazione è atomica: correggi il file (scarica il report) e caricalo di nuovo; nessuna riga verrà applicata finché ci sono errori.</div>
                  </div>
                ) : (
                  <div className="row">
                    <span className="muted">Tutto pronto: {d.summary.create} nuovi e {d.summary.update} aggiornamenti verranno scritti insieme.</span>
                    <div className="grow" />
                    <button className="btn primary" onClick={() => setConfirm(true)}>
                      Conferma importazione
                    </button>
                  </div>
                )
              ) : null}
            </div>
            {rows.data ? (
              <div className="table-wrap" style={{ borderTop: '1px solid var(--border)' }}>
                <table className="table compact">
                  <thead>
                    <tr>
                      <th className="num">Riga</th>
                      <th>Esito</th>
                      {d.fields.filter((f) => mapping[f.key] || ['code', 'usageUnit'].includes(f.key)).map((f) => (
                        <th key={f.key}>{f.label}</th>
                      ))}
                      <th>Segnalazioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.data.data.map((r) => (
                      <tr key={r.row_number}>
                        <td className="num">{r.row_number}</td>
                        <td>
                          <span className={`badge ${r.action === 'error' ? 'err' : r.action === 'create' ? 'ok' : r.action === 'update' ? 'info' : ''}`}>
                            {{ create: 'Nuovo', update: 'Aggiorna', skip: 'Ignorata', error: 'Errore' }[r.action] ?? r.action}
                          </span>
                        </td>
                        {d.fields.filter((f) => mapping[f.key] || ['code', 'usageUnit'].includes(f.key)).map((f) => (
                          <td key={f.key} className="small">
                            {String(r.normalized?.[f.key === 'unitWeightG' ? 'unitWeightKg' : f.key] ?? '')}
                          </td>
                        ))}
                        <td className="small">
                          {r.errors?.map((e) => (
                            <div key={e} style={{ color: 'var(--err)' }}>
                              {e}
                            </div>
                          ))}
                          {r.warnings?.map((w) => (
                            <div key={w} style={{ color: 'var(--warn)' }}>
                              {w}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="table-foot">
                  <span>{num(rows.data.meta.total)} righe · valori normalizzati (numeri col punto, date aaaa-mm-gg)</span>
                  <div className="row">
                    <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      ‹
                    </button>
                    <span>{page}</span>
                    <button className="btn sm" disabled={page * 50 >= rows.data.meta.total} onClick={() => setPage(page + 1)}>
                      ›
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {confirm && d.summary ? (
        <Confirm
          title="Confermare l’importazione?"
          message={`Verranno creati ${d.summary.create} e aggiornati ${d.summary.update} ${d.type === 'ingredients' ? 'ingredienti (con i relativi prezzi a storico)' : 'dipendenti (con le configurazioni di costo)'}. L’operazione è atomica: se qualcosa è cambiato dopo l’anteprima, non viene scritto nulla.`}
          confirmLabel="Importa"
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            try {
              await api.post(`/imports/${id}/confirm`, { lockVersion: d.lockVersion })
              setConfirm(false)
              await imp.refetch()
              qc.invalidateQueries({ queryKey: ['imports'] })
              qc.invalidateQueries({ queryKey: ['ingredients'] })
              qc.invalidateQueries({ queryKey: ['employees'] })
              qc.invalidateQueries({ queryKey: ['recipes'] })
            } catch (e) {
              toast(errorMessage(e), 'err')
              setConfirm(false)
            }
          }}
        />
      ) : null}
    </>
  )
}
