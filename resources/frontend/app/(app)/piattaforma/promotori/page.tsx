'use client'

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime, num } from '@/lib/num'
import { useQueryParam } from '@/lib/hooks'
import { PageHead } from '@/components/AppShell'
import { Drawer, Empty, ErrorBox, errorMessage, Field, fieldErrors, Icon, Skeleton, useToast } from '@/components/ui'

/**
 * NUOVO — Promotori (referral): chi presenta nuovi clienti con il proprio codice promo.
 * Classifica per aziende «in uso» (almeno una ricetta), poi attive (invito accettato), poi presentate.
 */
interface LinkedUser {
  id: string
  name: string
  email: string
  companies: string[]
}
interface Promoter {
  id: string
  code: string
  link: string
  name: string
  email: string | null
  phone: string | null
  notes: string | null
  isActive: boolean
  createdAt: string
  user: LinkedUser | null
  companies: number
  active: number
  inUse: number
  lastReferralAt: string | null
}
interface PromoterDetail extends Omit<Promoter, 'companies' | 'active' | 'inUse' | 'lastReferralAt'> {
  referredCompanies: Array<{ id: string; name: string; code: string | null; via: string | null; referredAt: string | null; archived: boolean; active: boolean; inUse: boolean; recipes: number }>
}
interface Totals {
  promoters: number
  referred: number
  inUse: number
  direct: number
}

const VIA: Record<string, string> = { platform: 'inserito da te', invite: 'inserito dal cliente', signup: 'registrazione' }

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export default function PromotersPage() {
  const toast = useToast()
  const openId = useQueryParam('id')
  const [editing, setEditing] = useState<Promoter | 'new' | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [showOff, setShowOff] = useState(false)
  const q = useQuery({ queryKey: ['platform', 'promoters'], queryFn: () => api.get<{ data: Promoter[]; totals: Totals }>('/platform/promoters') })
  useEffect(() => {
    if (openId) setViewing(openId)
  }, [openId])
  const rows = (q.data?.data ?? []).filter((p) => showOff || p.isActive)
  const off = (q.data?.data ?? []).filter((p) => !p.isActive).length

  return (
    <>
      <PageHead
        title="Promotori"
        sub="Chi ti presenta nuovi clienti. Ogni promotore ha un codice promo: il cliente lo indica quando nasce la sua azienda, così sai chi ti ha portato chi."
        actions={
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" /> Nuovo promotore
          </button>
        }
      />
      {q.data ? (
        <div className="kpis">
          <div className="kpi">
            <div className="k-label">Promotori attivi</div>
            <div className="k-value">{num(q.data.totals.promoters)}</div>
          </div>
          <div className="kpi">
            <div className="k-label">Aziende presentate</div>
            <div className="k-value">{num(q.data.totals.referred)}</div>
          </div>
          <div className="kpi">
            <div className="k-label">Di cui in uso</div>
            <div className="k-value">{num(q.data.totals.inUse)}</div>
          </div>
          <div className="kpi">
            <div className="k-label">Aziende dirette</div>
            <div className="k-value">{num(q.data.totals.direct)}</div>
          </div>
        </div>
      ) : null}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Classifica</h2>
          {off ? (
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> mostra disattivati ({off})
            </label>
          ) : null}
        </div>
        {q.error ? (
          <div className="card-body">
            <ErrorBox error={q.error} retry={() => q.refetch()} />
          </div>
        ) : !q.data ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <Empty title="Nessun promotore" action={<button className="btn primary" onClick={() => setEditing('new')}>Crea il primo promotore</button>}>
            Crea un promotore per ogni persona che ti porta clienti: un tuo cliente soddisfatto, un consulente, un fornitore. Puoi collegarlo a un utente del portale oppure no.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Promotore</th>
                  <th>Codice</th>
                  <th className="num" title="Aziende create con il suo codice">Presentate</th>
                  <th className="num" title="L’amministratore ha accettato l’invito">Attive</th>
                  <th className="num" title="Hanno almeno una ricetta: usano davvero il portale">In uso</th>
                  <th>Ultima</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => (
                  <tr key={p.id} style={p.isActive ? undefined : { opacity: 0.6 }}>
                    <td className="num faint">{i + 1}</td>
                    <td>
                      <button type="button" className="link" style={{ fontWeight: 600, background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit' }} onClick={() => setViewing(p.id)}>
                        {p.name}
                      </button>
                      {!p.isActive ? <span className="badge"> disattivato</span> : null}
                      <div className="small faint">
                        {p.user ? `utente del portale${p.user.companies.length ? ` · ${p.user.companies.join(', ')}` : ''}` : 'esterno'}
                        {p.phone ? ` · ${p.phone}` : ''}
                      </div>
                    </td>
                    <td>
                      <span className="badge mono">{p.code}</span>{' '}
                      <button
                        type="button"
                        className="btn ghost sm"
                        title="Copia il codice"
                        onClick={async () => {
                          if (await copyText(p.code)) toast(`Codice ${p.code} copiato.`)
                        }}
                      >
                        <Icon name="copy" />
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        title="Copia il link con il codice già inserito"
                        onClick={async () => {
                          if (await copyText(p.link)) toast('Link copiato: chi lo apre trova la richiesta di attivazione con il codice già compilato.')
                        }}
                      >
                        link
                      </button>
                    </td>
                    <td className="num">{p.companies}</td>
                    <td className="num">{p.active}</td>
                    <td className="num" style={{ fontWeight: 600 }}>
                      {p.inUse}
                    </td>
                    <td className="faint small">{p.lastReferralAt ? dateTime(p.lastReferralAt) : '—'}</td>
                    <td className="num">
                      <button className="btn ghost sm" onClick={() => setEditing(p)}>
                        <Icon name="edit" /> Modifica
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-body small muted">
          <strong>Presentate</strong>: aziende create con il codice. <strong>Attive</strong>: l’amministratore ha accettato l’invito. <strong>In uso</strong>: hanno inserito almeno una ricetta. La classifica premia
          prima chi porta clienti che usano davvero il portale.
        </div>
      </div>
      {editing ? <PromoterEditor promoter={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {viewing ? <PromoterView id={viewing} onClose={() => setViewing(null)} /> : null}
    </>
  )
}

function PromoterView({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['platform', 'promoters', id], queryFn: () => api.get<PromoterDetail>(`/platform/promoters/${id}`) })
  const p = q.data
  return (
    <Drawer title={p ? `${p.name} · ${p.code}` : 'Promotore'} onClose={onClose}>
      {q.error ? <ErrorBox error={q.error} /> : !p ? (
        <Skeleton />
      ) : (
        <div className="stack">
          <div className="small">
            {p.user ? (
              <div>
                Utente del portale: <strong>{p.user.name}</strong> <span className="faint">{p.user.email}</span>
                {p.user.companies.length ? <div className="faint">Membro di: {p.user.companies.join(', ')}</div> : null}
              </div>
            ) : (
              <div>Promotore esterno (senza account)</div>
            )}
            {p.email && p.email !== p.user?.email ? <div>Email: {p.email}</div> : null}
            {p.phone ? <div>Telefono: {p.phone}</div> : null}
            {p.notes ? <div className="muted" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{p.notes}</div> : null}
          </div>
          <div className="section-title">Aziende presentate ({p.referredCompanies.length})</div>
          {p.referredCompanies.length === 0 ? (
            <p className="small muted">Ancora nessuna. Il codice da comunicare è <strong className="mono">{p.code}</strong>.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Azienda</th>
                    <th>Stato</th>
                    <th className="num">Ricette</th>
                    <th>Quando</th>
                  </tr>
                </thead>
                <tbody>
                  {p.referredCompanies.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <div className="small faint">{c.via ? VIA[c.via] ?? c.via : ''}{c.code && c.code !== p.code ? ` · codice ${c.code}` : ''}</div>
                      </td>
                      <td>
                        {c.archived ? <span className="badge">archiviata</span> : c.inUse ? <span className="badge ok">in uso</span> : c.active ? <span className="badge info">attiva</span> : <span className="badge warn">invito in attesa</span>}
                      </td>
                      <td className="num">{c.recipes}</td>
                      <td className="small faint">{c.referredAt ? dateTime(c.referredAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Drawer>
  )
}

function PromoterEditor({ promoter, onClose }: { promoter: Promoter | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [kind, setKind] = useState<'user' | 'external'>(promoter?.user ? 'user' : promoter ? 'external' : 'user')
  const [user, setUser] = useState<LinkedUser | null>(promoter?.user ?? null)
  const [search, setSearch] = useState('')
  const [v, setV] = useState({ name: promoter?.name ?? '', email: promoter?.email ?? '', phone: promoter?.phone ?? '', code: promoter?.code ?? '', notes: promoter?.notes ?? '', isActive: promoter?.isActive ?? true })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const users = useQuery({
    queryKey: ['platform', 'users', search],
    enabled: kind === 'user' && !user,
    queryFn: () => api.get<{ data: Array<LinkedUser & { promoterCode: string | null }> }>(`/platform/users?q=${encodeURIComponent(search)}`),
  })

  const submit = async () => {
    setErrors({})
    setError('')
    if (kind === 'user' && !user) {
      setError('Scegli l’utente del portale da collegare, oppure seleziona «Persona esterna».')
      return
    }
    setBusy(true)
    const body = {
      name: v.name.trim() || null,
      email: v.email.trim() || null,
      phone: v.phone.trim() || null,
      notes: v.notes.trim() || null,
      code: v.code.trim() || null,
      userId: kind === 'user' ? user!.id : null,
      ...(promoter ? { isActive: v.isActive } : {}),
    }
    try {
      if (promoter) {
        await api.patch(`/platform/promoters/${promoter.id}`, body)
        toast('Promotore aggiornato.')
      } else {
        const r = await api.post<{ code: string }>('/platform/promoters', body)
        toast(`Promotore creato: il suo codice è ${r.code}.`)
      }
      qc.invalidateQueries({ queryKey: ['platform'] })
      onClose()
    } catch (e) {
      setErrors(fieldErrors(e))
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title={promoter ? `Modifica ${promoter.name}` : 'Nuovo promotore'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? <span className="spinner" /> : null} {promoter ? 'Salva' : 'Crea promotore'}
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? <div className="alert err">{error}</div> : null}
        <div className="field">
          <span className="label">Chi è</span>
          <div className="seg" role="radiogroup">
            <button type="button" aria-pressed={kind === 'user'} onClick={() => setKind('user')}>
              Utente del portale
            </button>
            <button type="button" aria-pressed={kind === 'external'} onClick={() => setKind('external')}>
              Persona esterna
            </button>
          </div>
        </div>
        {kind === 'user' ? (
          user ? (
            <div className="alert info">
              <div>
                <strong>{user.name}</strong> <span className="faint">{user.email}</span>
                {user.companies.length ? <div className="small faint">{user.companies.join(', ')}</div> : null}
              </div>
              <button type="button" className="btn ghost sm" onClick={() => setUser(null)}>
                Cambia
              </button>
            </div>
          ) : (
            <Field label="Cerca l’utente" htmlFor="pr-search" hint="Nome o email di un utente già registrato nel portale">
              <input id="pr-search" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="es. mario o mario@…" autoFocus />
              <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                {(users.data?.data ?? []).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="btn ghost"
                    style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '8px 10px' }}
                    disabled={!!u.promoterCode && u.id !== promoter?.user?.id}
                    onClick={() => {
                      setUser(u)
                      setV((x) => ({ ...x, name: x.name || u.name, email: x.email || u.email }))
                    }}
                  >
                    <span>
                      <strong>{u.name}</strong> <span className="faint small">{u.email}</span>
                      <span className="small faint" style={{ display: 'block' }}>
                        {u.companies.join(', ') || 'nessuna azienda'}
                        {u.promoterCode ? ` · già promotore (${u.promoterCode})` : ''}
                      </span>
                    </span>
                  </button>
                ))}
                {users.data && users.data.data.length === 0 ? <span className="small muted">Nessun utente trovato.</span> : null}
              </div>
            </Field>
          )
        ) : null}
        <Field label="Nome" htmlFor="pr-name" required={kind === 'external'} error={errors.name}>
          <input id="pr-name" className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={kind === 'user' ? 'Se vuoto, il nome dell’utente' : 'es. Giulia Bianchi'} />
        </Field>
        <div className="grid-2">
          <Field label="Email" htmlFor="pr-email" error={errors.email}>
            <input id="pr-email" type="email" className="input" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
          </Field>
          <Field label="Telefono" htmlFor="pr-phone" error={errors.phone}>
            <input id="pr-phone" type="tel" className="input" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
          </Field>
        </div>
        <Field
          label="Codice promo"
          htmlFor="pr-code"
          error={errors.code}
          hint={promoter ? 'Se lo cambi, il vecchio codice smette di funzionare; le aziende già presentate restano sue.' : 'Lascia vuoto per generarlo dal nome (es. GIULIA24). Da 4 a 24 caratteri: lettere, numeri, trattino.'}
        >
          <input id="pr-code" className="input mono" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} placeholder="automatico" autoCapitalize="characters" />
        </Field>
        <Field label="Note" htmlFor="pr-notes" hint="Solo per te: accordi, premi concordati, come vi siete conosciuti…">
          <textarea id="pr-notes" className="input" rows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </Field>
        {promoter ? (
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} /> Codice attivo (se lo disattivi, nessuno potrà più usarlo; lo storico resta)
          </label>
        ) : null}
      </div>
    </Drawer>
  )
}
