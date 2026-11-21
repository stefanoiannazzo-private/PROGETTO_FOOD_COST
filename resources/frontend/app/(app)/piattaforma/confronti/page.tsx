'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { Empty, ErrorBox, Icon, Skeleton } from '@/components/ui'

/** NUOVO: gruppi di confronto tra ricette equivalenti di aziende diverse. */
interface GroupRow {
  id: string
  name: string
  notes: string | null
  recipes: number
  updatedAt: string
}

export default function ComparisonsPage() {
  const q = useQuery({ queryKey: ['platform', 'groups'], queryFn: () => api.get<{ data: GroupRow[] }>('/platform/comparison-groups') })
  return (
    <>
      <PageHead
        title="Confronti ricette"
        sub="Lo stesso piatto può avere nomi diversi presso ristoratori diversi: raggruppalo qui per confrontarne costi e composizione."
        actions={
          <Link className="btn primary" href="/piattaforma/ricette">
            <Icon name="plus" /> Nuovo confronto
          </Link>
        }
      />
      <div className="card">
        {q.error ? (
          <div className="card-body">
            <ErrorBox error={q.error} retry={() => q.refetch()} />
          </div>
        ) : !q.data ? (
          <Skeleton />
        ) : q.data.data.length === 0 ? (
          <Empty
            title="Nessun confronto"
            action={
              <Link className="btn primary" href="/piattaforma/ricette">
                Scegli le ricette da confrontare
              </Link>
            }
          >
            Seleziona due o più ricette equivalenti dall’elenco di tutte le ricette.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Confronto</th>
                <th className="num">Ricette</th>
                <th>Aggiornato</th>
              </tr>
            </thead>
            <tbody>
              {q.data.data.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Link className="link" href={`/piattaforma/confronti/${g.id}`}>
                      {g.name}
                    </Link>
                    {g.notes ? <div className="faint small">{g.notes}</div> : null}
                  </td>
                  <td className="num">{g.recipes}</td>
                  <td className="faint small">{dateTime(g.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
