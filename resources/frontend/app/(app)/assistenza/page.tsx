'use client'

/**
 * NUOVO — Pannello Assistenza: chiamata (solo da smartphone), nuova richiesta per pagina dell'app con
 * risposte frequenti pertinenti, elenco delle proprie richieste.
 */
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/num'
import { useMe } from '@/lib/session'
import { AREA_TO_FAQ, FAQ, areaFromPath } from '@/lib/faq'
import { previousPath } from '@/lib/nav-history'
import { PageHead } from '@/components/AppShell'
import { AttachmentInput, CallSupport, STATUS, useSupportInfo, type Ticket } from '@/components/Support'
import { Empty, Field, Icon, Skeleton, errorMessage, fieldErrors, useToast } from '@/components/ui'

export default function SupportPage() {
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const { data: me } = useMe()
  const info = useSupportInfo()
  const list = useQuery({ queryKey: ['support', 'tickets'], queryFn: () => api.get<{ data: Ticket[] }>('/support/tickets') })

  const [area, setArea] = useState('altro')
  const [from, setFrom] = useState('')
  const [kind, setKind] = useState('question')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [phone, setPhone] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  // pagina di provenienza: ?pagina=ricette oppure la pagina da cui si è arrivati
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('pagina')
    const before = previousPath(window.location.pathname)
    const prev = before.startsWith('/assistenza') ? '' : before
    setFrom(prev)
    setArea(p ?? (prev ? areaFromPath(prev) : 'altro'))
  }, [])

  const related = useMemo(() => {
    const keys = AREA_TO_FAQ[area] ?? []
    return FAQ.filter((f) => keys.includes(f.area)).slice(0, 4)
  }, [area])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErrors({})
    setError('')
    try {
      const fd = new FormData()
      fd.append('area', area)
      fd.append('kind', kind)
      fd.append('subject', subject)
      fd.append('message', message)
      if (phone.trim()) fd.append('contactPhone', phone)
      if (from) fd.append('pageUrl', from)
      if (file) fd.append('attachment', file)
      const r = await api.upload<{ id: string; number: number }>('/support/tickets', fd)
      qc.invalidateQueries({ queryKey: ['support', 'tickets'] })
      toast(`Richiesta #${r.number} inviata: ti risponderemo qui e via email`)
      router.push(`/assistenza/${r.id}`)
    } catch (err) {
      setErrors(fieldErrors(err))
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead title="Assistenza" sub="Scrivici dalla pagina in cui ti serve aiuto oppure chiamaci. Le risposte arrivano qui e per email." />

      <div className="support-top">
        <div className="card">
          <div className="card-body stack">
            <h2 className="support-h">
              <Icon name="phone" /> Chiamaci
            </h2>
            {info.data ? <CallSupport phone={info.data.phone} hours={info.data.hours} /> : <Skeleton rows={1} />}
          </div>
        </div>
        <div className="card">
          <div className="card-body stack">
            <h2 className="support-h">
              <Icon name="help" /> Domande frequenti
            </h2>
            <p className="small muted" style={{ margin: 0 }}>
              Prezzi e IVA, peso delle ricette, fatture XML, bollette, app sul telefono e molto altro.
            </p>
            <Link className="btn" href="/assistenza/faq" style={{ alignSelf: 'flex-start' }}>
              Leggi le risposte
            </Link>
          </div>
        </div>
      </div>

      <form className="card" onSubmit={submit} style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Nuova richiesta</h2>
        </div>
        <div className="card-body stack">
          <div className="grid-2">
            <Field label="In quale pagina ti serve aiuto?" htmlFor="s-area" required error={errors.area}>
              <select id="s-area" className="input" value={area} onChange={(e) => setArea(e.target.value)}>
                {Object.entries(info.data?.areas ?? { altro: 'Altro' }).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <div className="field">
              <label>Di cosa si tratta?</label>
              <div className="seg" role="group" aria-label="Tipo di richiesta">
                {Object.entries(info.data?.kinds ?? { question: 'Domanda', problem: 'Problema', suggestion: 'Suggerimento' }).map(([k, l]) => (
                  <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {related.length ? (
            <details className="faq-hint">
              <summary>
                <Icon name="help" size={14} /> Forse la risposta è già qui ({related.length})
              </summary>
              <div className="faq-list">
                {related.map((f) => (
                  <details key={f.id} className="faq">
                    <summary>{f.q}</summary>
                    {f.a.map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </details>
                ))}
              </div>
            </details>
          ) : null}

          <Field label="Oggetto" htmlFor="s-subj" required error={errors.subject}>
            <input id="s-subj" className="input" value={subject} maxLength={160} onChange={(e) => setSubject(e.target.value)} placeholder="es. Il costo della pizza margherita non torna" />
          </Field>
          <Field label="Messaggio" htmlFor="s-msg" required error={errors.message} hint="Descrivi cosa stavi facendo e cosa ti aspettavi: ci aiuta a risponderti subito.">
            <textarea id="s-msg" className="input" rows={6} value={message} maxLength={5000} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <div className="grid-2">
            <Field label="Allegato" error={errors.attachment}>
              <AttachmentInput file={file} onChange={setFile} maxBytes={info.data?.maxBytes ?? 8 * 1048576} />
            </Field>
            <Field label="Telefono per richiamarti" htmlFor="s-tel" hint="Facoltativo, se preferisci essere richiamato">
              <input id="s-tel" className="input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="es. 333 123 4567" />
            </Field>
          </div>
          {error ? <div className="alert err">{error}</div> : null}
          <div className="row wrap" style={{ alignItems: 'center', gap: 12 }}>
            <button className="btn primary" disabled={busy || !subject.trim() || !message.trim() || !!me?.assist}>
              {busy ? <span className="spinner" /> : <Icon name="send" />} Invia richiesta
            </button>
            <span className="small faint">{me?.assist ? 'In modalità assistenza non puoi aprire richieste a nome del cliente.' : `Ti risponderemo all’indirizzo ${me?.user?.email ?? ''}.`}</span>
          </div>
        </div>
      </form>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>{me?.role === 'admin' ? 'Richieste della tua azienda' : 'Le tue richieste'}</h2>
        </div>
        {list.isLoading ? (
          <div className="card-body">
            <Skeleton rows={3} />
          </div>
        ) : !list.data?.data.length ? (
          <Empty title="Nessuna richiesta">Le richieste che invii compariranno qui, con le risposte dell’assistenza.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Richiesta</th>
                  <th>Pagina</th>
                  <th>Stato</th>
                  <th>Aggiornata</th>
                </tr>
              </thead>
              <tbody>
                {list.data.data.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link className="link" href={`/assistenza/${t.id}`}>
                        #{t.number} · {t.subject}
                      </Link>
                      {t.unread ? <span className="badge ok" style={{ marginLeft: 6 }}>Nuova risposta</span> : null}
                      {me?.role === 'admin' ? <div className="small faint">{t.userName}</div> : null}
                    </td>
                    <td className="small">{t.areaLabel}</td>
                    <td>
                      <span className={`badge ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span>
                    </td>
                    <td className="small faint">{dateTime(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
