'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { dateTime, num } from '@/lib/num'
import { useSwitchCompany } from '@/lib/session'
import type { Company } from '@/lib/platform'
import { PageHead } from '@/components/AppShell'
import { Drawer, Empty, ErrorBox, errorMessage, Field, fieldErrors, Icon, Skeleton, useToast } from '@/components/ui'

/** NUOVO: console del superadmin — aziende clienti (tenant), creazione e assistenza. */
interface Overview {
  companies: number
  activeCompanies: number
  users: number
  recipes: number
  ingredients: number
  prices: number
  suppliers: number
  agents: number
  comparisonGroups: number
}

export default function PlatformPage() {
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const switchCompany = useSwitchCompany()
  const [creating, setCreating] = useState(false)
  const [archived, setArchived] = useState(false)
  const ov = useQuery({ queryKey: ['platform', 'overview'], queryFn: () => api.get<Overview>('/platform/overview') })
  const q = useQuery({ queryKey: ['platform', 'companies'], queryFn: () => api.get<{ data: Company[] }>('/platform/companies') })
  const rows = (q.data?.data ?? []).filter((c) => c.archived === archived)

  return (
    <>
      <PageHead
        title="Aziende clienti"
        sub="Ogni azienda è un ambiente separato con i propri dati. Da qui crei nuovi clienti e, se un cliente lo chiede, entri nella sua azienda per assisterlo."
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Nuova azienda
          </button>
        }
      />
      {ov.data ? (
        <div className="kpis">
          <div className="kpi">
            <div className="k-label">Aziende attive</div>
            <div className="k-value">{num(ov.data.activeCompanies)}</div>
          </div>
          <div className="kpi">
            <div className="k-label">Utenti</div>
            <div className="k-value">{num(ov.data.users)}</div>
          </div>
          <div className="kpi">
            <div className="k-label">Ricette</div>
            <div className="k-value">{num(ov.data.recipes)}</div>
          </div>
          <div className="kpi">
            <div className="k-label">Prodotti · prezzi</div>
            <div className="k-value">
              {num(ov.data.ingredients)} · {num(ov.data.prices)}
            </div>
          </div>
          <div className="kpi">
            <div className="k-label">Fornitori · agenti</div>
            <div className="k-value">
              {num(ov.data.suppliers)} · {num(ov.data.agents)}
            </div>
          </div>
        </div>
      ) : null}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="toolbar">
          <select className="input" value={archived ? '1' : '0'} onChange={(e) => setArchived(e.target.value === '1')} aria-label="Stato">
            <option value="0">Attive</option>
            <option value="1">Archiviate</option>
          </select>
        </div>
        {q.error ? (
          <div className="card-body">
            <ErrorBox error={q.error} retry={() => q.refetch()} />
          </div>
        ) : !q.data ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <Empty title={archived ? 'Nessuna azienda archiviata' : 'Nessuna azienda'} action={!archived ? <button className="btn primary" onClick={() => setCreating(true)}>Crea la prima azienda</button> : null}>
            Crea un’azienda e invita il suo amministratore: riceverà un link per impostare la password.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Azienda</th>
                  <th>Amministratori</th>
                  <th className="num">Utenti</th>
                  <th className="num">Ricette</th>
                  <th className="num">Prodotti</th>
                  <th>Creata</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td className="small">
                      {c.admins.map((a) => (
                        <div key={a.email}>
                          {a.name} <span className="faint">{a.email}</span>
                        </div>
                      ))}
                      {c.pendingAdminInvitations.map((i) => (
                        <div key={i.email}>
                          <span className={`badge ${i.expired ? 'err' : 'info'}`}>{i.expired ? 'invito scaduto' : 'invito in attesa'}</span> <span className="faint">{i.email}</span>
                        </div>
                      ))}
                      {c.admins.length + c.pendingAdminInvitations.length === 0 ? <span className="badge warn">nessun amministratore</span> : null}
                    </td>
                    <td className="num">{c.users}</td>
                    <td className="num">
                      <Link className="link" href={`/piattaforma/ricette?azienda=${c.id}`}>
                        {c.recipes}
                      </Link>
                    </td>
                    <td className="num">
                      <Link className="link" href={`/piattaforma/prodotti?azienda=${c.id}`}>
                        {c.ingredients}
                      </Link>
                    </td>
                    <td className="faint small">{dateTime(c.createdAt)}</td>
                    <td className="num">
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {!c.archived ? (
                          <button
                            className="btn sm"
                            title="Entra nell’azienda come amministratore per assistere il cliente (registrato nel registro attività)"
                            onClick={async () => {
                              try {
                                await switchCompany(c.id)
                                router.push('/')
                              } catch (e) {
                                toast(errorMessage(e), 'err')
                              }
                            }}
                          >
                            Assisti
                          </button>
                        ) : null}
                        <button
                          className="btn ghost sm"
                          onClick={async () => {
                            if (!c.archived && !window.confirm(`Archiviare ${c.name}? I suoi utenti non potranno più accedere; i dati restano conservati.`)) return
                            try {
                              await api.patch(`/platform/companies/${c.id}`, { archived: !c.archived })
                              qc.invalidateQueries({ queryKey: ['platform'] })
                            } catch (e) {
                              toast(errorMessage(e), 'err')
                            }
                          }}
                        >
                          <Icon name="archive" /> {c.archived ? 'Ripristina' : 'Archivia'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating ? <CreateCompany onClose={() => setCreating(false)} /> : null}
    </>
  )
}

function CreateCompany({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ name: '', adminName: '', adminEmail: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ name: string; invitation: { mail: string; inviteLink?: string } } | null>(null)
  return (
    <Drawer
      title="Nuova azienda"
      onClose={onClose}
      footer={
        done ? (
          <button className="btn primary" onClick={onClose}>
            Chiudi
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Annulla
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setErrors({})
                setError('')
                setBusy(true)
                try {
                  const r = await api.post<{ name: string; invitation: { mail: string; inviteLink?: string } }>('/platform/companies', v)
                  qc.invalidateQueries({ queryKey: ['platform'] })
                  setDone(r)
                } catch (e) {
                  setErrors(fieldErrors(e))
                  setError(errorMessage(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? <span className="spinner" /> : null} Crea e invita
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="stack">
          <div className="alert ok">
            Azienda <strong>{done.name}</strong> creata. {done.invitation.mail === 'sent' ? 'L’invito è stato inviato per email.' : 'L’email non è configurata: invia tu il link all’amministratore.'}
          </div>
          {done.invitation.inviteLink ? (
            <Field label="Link di invito" htmlFor="inv-link" hint="Valido per un periodo limitato, utilizzabile una sola volta">
              <input id="inv-link" className="input" readOnly value={done.invitation.inviteLink} onFocus={(e) => e.target.select()} />
            </Field>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          {error ? <div className="alert err">{error}</div> : null}
          <Field label="Nome dell’azienda" htmlFor="co-name" required error={errors.name}>
            <input id="co-name" className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="es. Trattoria da Mario" autoFocus />
          </Field>
          <div className="section-title">Amministratore dell’azienda</div>
          <p className="small muted">Riceve un invito per impostare la password e gestire utenti, ricette e costi della propria azienda.</p>
          <div className="grid-2">
            <Field label="Nome e cognome" htmlFor="co-admin" required error={errors.adminName}>
              <input id="co-admin" className="input" value={v.adminName} onChange={(e) => setV({ ...v, adminName: e.target.value })} />
            </Field>
            <Field label="Email" htmlFor="co-email" required error={errors.adminEmail}>
              <input id="co-email" type="email" className="input" value={v.adminEmail} onChange={(e) => setV({ ...v, adminEmail: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
    </Drawer>
  )
}
