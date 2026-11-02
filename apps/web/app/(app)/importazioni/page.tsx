'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime, num } from '@/lib/num'
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


export default function ImportsPage() {
  const can = useCan()
  const router = useRouter()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['imports'], queryFn: () => api.get<{ data: ImportRow[] }>('/imports') })
  const [type, setType] = useState<'ingredients' | 'employees'>('ingredients')
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

  return (
    <>
      <PageHead title="Importazioni" sub="Ingredienti con prezzi e dipendenti con costi, da file Excel (.xlsx) o CSV. Nulla viene scritto prima della tua conferma." />
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
            </div>
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
          </div>
        </div>

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
