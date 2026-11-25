'use client'

/** NUOVO — Console del supporto: una richiesta, con i dati del cliente, risposta e stato. */
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/num'
import { useSwitchCompany } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { ReplyBox, STATUS, Thread, formatPhone, useSupportInfo, type Ticket } from '@/components/Support'
import { ErrorBox, Icon, Skeleton, errorMessage, useToast } from '@/components/ui'

export default function PlatformTicketPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const info = useSupportInfo()
  const switchCompany = useSwitchCompany()
  const q = useQuery({ queryKey: ['support', 'platform-ticket', id], queryFn: () => api.get<Ticket>(`/platform/support/${id}`) })
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data) return <Skeleton rows={6} />
  const t = q.data
  const refresh = () => qc.invalidateQueries({ queryKey: ['support'] })
  const setStatus = async (status: Ticket['status']) => {
    await api.post(`/platform/support/${t.id}/status`, { status })
    toast('Stato aggiornato')
    refresh()
  }
  return (
    <>
      <PageHead
        title={`#${t.number} · ${t.subject}`}
        sub={
          <>
            {t.company} · {t.areaLabel} · {t.kindLabel} <span className={`badge ${STATUS[t.status].cls}`}>{t.status === 'open' ? 'Da rispondere' : STATUS[t.status].label}</span>
          </>
        }
        actions={
          <Link className="btn" href="/piattaforma/assistenza">
            ← Tutte le richieste
          </Link>
        }
      />
      <div className="support-detail">
        <section className="card">
          <div className="card-body stack">
            <Thread messages={t.messages ?? []} />
            <ReplyBox
              endpoint={`/platform/support/${t.id}/messages`}
              maxBytes={info.data?.maxBytes ?? 8 * 1048576}
              placeholder="Rispondi al cliente: riceverà un’email con il link alla risposta"
              onSent={() => {
                toast('Risposta inviata al cliente')
                refresh()
              }}
            />
          </div>
        </section>
        <aside className="stack">
          <div className="card">
            <div className="card-body stack tight">
              <div className="faint small">Cliente</div>
              <strong>{t.userName}</strong>
              <a className="link small" href={`mailto:${t.userEmail}`}>
                {t.userEmail}
              </a>
              {t.contactPhone ? (
                <a className="link small" href={`tel:${t.contactPhone.replace(/[^\d+]/g, '')}`}>
                  <Icon name="phone" size={14} /> {formatPhone(t.contactPhone)} (chiede di essere richiamato)
                </a>
              ) : null}
              <div className="faint small" style={{ marginTop: 8 }}>
                Azienda
              </div>
              <strong>{t.company}</strong>
              {t.companyId ? (
                <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={async () => {
                    try {
                      await switchCompany(t.companyId!)
                      router.push('/')
                    } catch (e) {
                      toast(errorMessage(e), 'err')
                    }
                  }}>
                  <Icon name="eye" size={14} /> Assisti (entra nell’azienda)
                </button>
              ) : null}
              <div className="faint small" style={{ marginTop: 8 }}>
                Dettagli tecnici
              </div>
              <div className="small">Aperta il {dateTime(t.createdAt)}</div>
              {t.pageUrl ? <div className="small">Pagina precedente: {t.pageUrl}</div> : null}
              {t.userAgent ? <div className="small faint" style={{ wordBreak: 'break-word' }}>{t.userAgent}</div> : null}
            </div>
          </div>
          <div className="card">
            <div className="card-body stack tight">
              <div className="faint small">Stato</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {t.status !== 'closed' ? (
                  <button className="btn sm" onClick={() => void setStatus('closed')}>
                    Chiudi
                  </button>
                ) : (
                  <button className="btn sm" onClick={() => void setStatus('open')}>
                    Riapri
                  </button>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </>
  )
}
