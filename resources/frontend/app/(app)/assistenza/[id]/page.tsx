'use client'

/** NUOVO — Una richiesta di assistenza: conversazione, risposta con allegato, chiusura. */
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { CallSupport, ReplyBox, STATUS, Thread, useSupportInfo, type Ticket } from '@/components/Support'
import { ErrorBox, Icon, Skeleton, useToast } from '@/components/ui'

export default function TicketPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const toast = useToast()
  const info = useSupportInfo()
  const q = useQuery({ queryKey: ['support', 'ticket', id], queryFn: () => api.get<Ticket>(`/support/tickets/${id}`), refetchInterval: 60_000 })
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data) return <Skeleton rows={6} />
  const t = q.data
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['support'] })
  }
  return (
    <>
      <PageHead
        title={`#${t.number} · ${t.subject}`}
        sub={
          <>
            {t.areaLabel} · {t.kindLabel} · aperta il {dateTime(t.createdAt)} <span className={`badge ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span>
          </>
        }
        actions={
          <Link className="btn" href="/assistenza">
            ← Assistenza
          </Link>
        }
      />
      <div className="support-detail">
        <section className="card">
          <div className="card-body stack">
            <Thread messages={t.messages ?? []} />
            {t.status === 'closed' ? <div className="alert info">Richiesta chiusa. Se scrivi un nuovo messaggio si riapre.</div> : null}
            <ReplyBox
              endpoint={`/support/tickets/${t.id}/messages`}
              maxBytes={info.data?.maxBytes ?? 8 * 1048576}
              placeholder={t.status === 'answered' ? 'Rispondi all’assistenza…' : 'Aggiungi dettagli…'}
              onSent={() => {
                toast('Messaggio inviato')
                refresh()
              }}
            />
          </div>
        </section>
        <aside className="stack">
          <div className="card">
            <div className="card-body stack">
              <h2 className="support-h">
                <Icon name="phone" /> Serve una risposta veloce?
              </h2>
              {info.data ? <CallSupport phone={info.data.phone} hours={info.data.hours} /> : null}
              <span className="small faint">Indica il numero della richiesta: #{t.number}</span>
            </div>
          </div>
          {t.status !== 'closed' ? (
            <button
              className="btn ghost"
              onClick={async () => {
                await api.post(`/support/tickets/${t.id}/close`)
                toast('Richiesta chiusa')
                refresh()
              }}
            >
              <Icon name="check" /> Problema risolto, chiudi la richiesta
            </button>
          ) : null}
        </aside>
      </div>
    </>
  )
}
