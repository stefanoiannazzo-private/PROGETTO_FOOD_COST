'use client'

/** NUOVO — Console del supporto: tutte le richieste dei ristoratori, con stato e azienda. */
import Link from 'next/link'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { FilterBar } from '@/components/FilterBar'
import { STATUS, type Ticket } from '@/components/Support'
import { Empty, ErrorBox, Skeleton } from '@/components/ui'

export default function PlatformSupportPage() {
  const [status, setStatus] = useState('active')
  const q = useQuery({
    queryKey: ['support', 'platform', status],
    queryFn: () => api.get<{ data: Ticket[]; counts: { open: number; answered: number; closed: number } }>(`/platform/support?status=${status}`),
    refetchInterval: 60_000,
  })
  const c = q.data?.counts
  return (
    <>
      <PageHead
        title="Assistenza clienti"
        sub={c ? `${c.open} in attesa di risposta · ${c.answered} risposte inviate · ${c.closed} chiuse` : 'Richieste dei ristoratori'}
      />
      <div className="card">
        <FilterBar>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Stato" style={{ width: 'auto' }}>
            <option value="active">Da gestire (aperte e con risposta)</option>
            <option value="open">In attesa di risposta</option>
            <option value="answered">Risposte inviate</option>
            <option value="closed">Chiuse</option>
            <option value="all">Tutte</option>
          </select>
        </FilterBar>
        {q.error ? (
          <ErrorBox error={q.error} retry={() => q.refetch()} />
        ) : !q.data ? (
          <div className="card-body">
            <Skeleton rows={4} />
          </div>
        ) : !q.data.data.length ? (
          <Empty title="Nessuna richiesta">Qui compaiono le richieste inviate dai ristoratori dal pannello Assistenza.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Richiesta</th>
                  <th>Cliente</th>
                  <th>Pagina</th>
                  <th>Stato</th>
                  <th>Aggiornata</th>
                </tr>
              </thead>
              <tbody>
                {q.data.data.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link className="link" href={`/piattaforma/assistenza/${t.id}`}>
                        #{t.number} · {t.subject}
                      </Link>
                      <div className="small faint">
                        {t.kindLabel} · {t.messageCount} {t.messageCount === 1 ? 'messaggio' : 'messaggi'}
                      </div>
                    </td>
                    <td className="small">
                      {t.company}
                      <div className="faint">{t.userName}</div>
                    </td>
                    <td className="small">{t.areaLabel}</td>
                    <td>
                      <span className={`badge ${STATUS[t.status].cls}`}>{t.status === 'open' ? 'Da rispondere' : STATUS[t.status].label}</span>
                    </td>
                    <td className="small faint">{dateTime(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
