'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { Empty, ErrorBox, errorMessage, Icon, Skeleton, useToast } from '@/components/ui'

/**
 * NUOVO — «Invita un collega»: codice promo e link da inoltrare. Il collega che apre il link trova la richiesta
 * di attivazione con il codice già compilato. Dei colleghi si vede solo lo stato: i loro dati restano privati.
 */
type Status = 'requested' | 'invited' | 'active' | 'declined' | 'closed'
interface Referral {
  canCreate: boolean
  promoter: { code: string; link: string; isActive: boolean } | null
  referrals: Array<{ name: string; date: string | null; status: Status }>
}

const STATUS: Record<Status, { label: string; cls: string }> = {
  requested: { label: 'Richiesta inviata', cls: 'warn' },
  invited: { label: 'In attivazione', cls: 'info' },
  active: { label: 'Account attivato', cls: 'ok' },
  declined: { label: 'Non attivata', cls: '' },
  closed: { label: 'Chiuso', cls: '' },
}

export default function InviteColleaguePage() {
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const q = useQuery({ queryKey: ['referral'], queryFn: () => api.get<Referral>('/referral') })
  const p = q.data?.promoter
  const text = p ? `Ciao! Per calcolare il food cost delle ricette uso Ricetta Quadra. Provalo da qui, il mio codice è già inserito: ${p.link}` : ''

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast(`${what} copiato.`)
    } catch {
      toast('Copia non riuscita: tieni premuto sul testo per copiarlo.')
    }
  }
  const share = async () => {
    if (!p) return
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Ricetta Quadra', text: text.replace(p.link, '').trim(), url: p.link })
        return
      } catch {
        return // annullata dall'utente
      }
    }
    void copy(text, 'Messaggio')
  }
  const create = async () => {
    setBusy(true)
    try {
      qc.setQueryData(['referral'], await api.post<Referral>('/referral', {}))
    } catch (e) {
      toast(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead title="Invita un collega" sub="Consiglia Ricetta Quadra ad altri ristoratori: con il tuo link troveranno il tuo codice già inserito, e noi sapremo che sono arrivati grazie a te." />
      {q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton />
      ) : !p ? (
        <div className="card">
          {q.data.canCreate ? (
            <Empty
              title="Crea il tuo link personale"
              action={
                <button className="btn primary" disabled={busy} onClick={() => void create()}>
                  {busy ? <span className="spinner" /> : <Icon name="gift" />} Crea il mio link
                </button>
              }
            >
              Ti diamo un codice promo e un link da mandare ai colleghi su WhatsApp, email o dove preferisci. Quando un collega lo apre, trova la richiesta di attivazione con il tuo codice già compilato.
            </Empty>
          ) : (
            <Empty title="Il link lo crea il titolare">Il codice promo è personale: chiedi all’amministratore del locale di creare il suo link e di condividerlo.</Empty>
          )}
        </div>
      ) : (
        <>
          {!p.isActive ? <div className="alert warn">Il tuo codice è sospeso: per riattivarlo scrivi all’assistenza.</div> : null}
          <div className="card referral-card">
            <div className="card-body stack">
              <div className="referral-code">
                <span className="small muted">Il tuo codice</span>
                <strong className="mono">{p.code}</strong>
                <button className="btn ghost sm" onClick={() => void copy(p.code, 'Codice')}>
                  <Icon name="copy" /> Copia
                </button>
              </div>
              <div className="field">
                <label className="label" htmlFor="ref-link">
                  Il tuo link
                </label>
                <div className="input-group">
                  <input id="ref-link" className="input mono" readOnly value={p.link} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn" onClick={() => void copy(p.link, 'Link')}>
                    <Icon name="copy" /> Copia
                  </button>
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn primary" onClick={() => void share()}>
                  <Icon name="upload" /> Condividi
                </button>
                <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">
                  WhatsApp
                </a>
                <a className="btn" href={`mailto:?subject=${encodeURIComponent('Ti consiglio Ricetta Quadra')}&body=${encodeURIComponent(text)}`}>
                  Email
                </a>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head">
              <h2>Colleghi che hai invitato</h2>
              <span className="small muted">{q.data.referrals.filter((r) => r.status === 'active').length} attivi</span>
            </div>
            {q.data.referrals.length === 0 ? (
              <div className="card-body muted">Ancora nessuno. Manda il link a un collega: qui vedrai quando invia la richiesta e quando attiva l’account.</div>
            ) : (
              <ul className="referral-list">
                {q.data.referrals.map((r, i) => (
                  <li key={i}>
                    <span>
                      <strong>{r.name}</strong>
                      <span className="small faint">{r.date ? dateTime(r.date) : ''}</span>
                    </span>
                    <span className={`badge ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="card-body small muted">Vedi solo se il collega ha attivato l’account: le sue ricette, i prodotti e i prezzi restano privati.</div>
          </div>
        </>
      )}
    </>
  )
}
