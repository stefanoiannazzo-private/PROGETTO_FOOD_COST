'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { RecipeCost } from '@/lib/cost-types'
import { date, dateTime, euro, euroPer, num } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { CostSummary } from '@/components/CostSummary'
import { ErrorBox, Skeleton } from '@/components/ui'

interface Snapshot {
  id: string
  recipe_id: string
  valuation_date: string
  label: string | null
  created_at: string
  created_by: string | null
  revision_number: number
  data: RecipeCost
}

export default function SnapshotPage() {
  const { id, snapshotId } = useParams<{ id: string; snapshotId: string }>()
  const q = useQuery({ queryKey: ['snapshot', snapshotId], queryFn: () => api.get<Snapshot>(`/snapshots/${snapshotId}`), staleTime: Infinity })
  if (q.error) return <ErrorBox error={q.error} />
  if (!q.data) return <Skeleton rows={8} />
  const s = q.data
  const c = s.data
  return (
    <>
      <PageHead
        title={`Snapshot: ${c.title}`}
        sub={
          <>
            {s.label ? `“${s.label}” · ` : ''}salvato il {dateTime(s.created_at)}
            {s.created_by ? ` da ${s.created_by}` : ''} · valorizzazione al {date(s.valuation_date)} · revisione {s.revision_number}.{' '}
            <Link className="link" href={`/ricette/${id}`}>
              Torna alla scheda
            </Link>
          </>
        }
      />
      <div className="alert info" style={{ marginBottom: 16 }}>
        Fotografia immutabile: prezzi, tariffe, costi del lavoro, resa e composizione delle sottoricette sono quelli in vigore al momento del salvataggio.
      </div>
      <div className="editor">
        <div className="card">
          <div className="card-head">
            <h2>Componenti al momento dello snapshot</h2>
          </div>
          <table className="table compact">
            <thead>
              <tr>
                <th>Componente</th>
                <th className="num">Quantità</th>
                <th className="num">Prezzo / costo unitario</th>
                <th className="num">Costo</th>
              </tr>
            </thead>
            <tbody>
              {c.ingredientLines.map((l) => (
                <tr key={l.componentId}>
                  <td>{l.name}</td>
                  <td className="num">
                    {num(l.quantity)} {l.unit}
                  </td>
                  <td className="num">{euroPer(l.unitPrice, l.baseUnit, 4)}</td>
                  <td className="num">{euro(l.cost)}</td>
                </tr>
              ))}
              {c.subrecipeLines.map((l) => (
                <tr key={l.componentId}>
                  <td>
                    <span className="badge accent">Ricetta</span> {l.name} <span className="faint small">rev. {l.sub?.revisionNumber}</span>
                  </td>
                  <td className="num">
                    {num(l.quantity)} {l.unit}
                  </td>
                  <td className="num">{l.unitCost ? `${euro(l.unitCost)}/${l.basis === 'weight' ? 'kg' : (l.sub?.finalUnit ?? '')}` : '—'}</td>
                  <td className="num">{euro(l.cost)}</td>
                </tr>
              ))}
              <tr>
                <td>Energia ({c.equipmentLines.length} usi strumento)</td>
                <td />
                <td />
                <td className="num">{euro(c.energy)}</td>
              </tr>
              <tr>
                <td>Manodopera ({c.laborLines.length} assegnazioni)</td>
                <td />
                <td />
                <td className="num">{euro(c.labor)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <aside className="card summary-panel" style={{ transform: 'none', position: 'sticky' }}>
          <div className="card-body">
            <CostSummary cost={c} />
          </div>
        </aside>
      </div>
    </>
  )
}
