'use client'

import Link from 'next/link'
import { Fragment, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { date, euro, euroPer, num, percent, unitLabel } from '@/lib/num'
import type { CostSummaryLite, Stats } from '@/lib/platform'
import { PageHead } from '@/components/AppShell'
import { STAT_HEAD, StatCells } from '@/components/PlatformBits'
import { CompletenessBadge, ErrorBox, errorMessage, Icon, Skeleton, StatusBadge, useToast } from '@/components/ui'

/** NUOVO: confronto tra ricette equivalenti: costi correnti, ripartizione, resa e ingredienti. */
interface Row {
  id: string
  code: string
  title: string
  category: string | null
  status: string
  companyId: string
  company: string
  cost: CostSummaryLite | null
  breakdown: { ingredients: string; energy: string; labor: string; ingredientsPercent: string | null; energyPercent: string | null; laborPercent: string | null } | null
  yield: { finalWeightKg: string | null; portions: string | null; portionWeightKg: string | null } | null
  ingredients: Array<{ name: string; quantity: string | null; unit: string; unitPrice: string | null; baseUnit: string | null; cost: string | null }>
}
interface Group {
  id: string
  name: string
  notes: string | null
  date: string
  recipes: Row[]
  stats: { costPerKg: Stats; costPerPortion: Stats; total: Stats }
}

export default function ComparisonPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['platform', 'group', id], queryFn: () => api.get<Group>(`/platform/comparison-groups/${id}`) })
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data) return <Skeleton rows={8} />
  const g = q.data
  const save = async (recipeIds: string[], name = g.name) => {
    try {
      await api.patch(`/platform/comparison-groups/${g.id}`, { name, notes: g.notes, recipeIds })
      qc.invalidateQueries({ queryKey: ['platform'] })
    } catch (e) {
      toast(errorMessage(e), 'err')
    }
  }
  const minPerKg = g.stats.costPerKg.min

  return (
    <>
      <PageHead
        title={g.name}
        sub={
          <>
            {g.recipes.length} ricette · costi aggiornati al {date(g.date)}
            {g.notes ? ` · ${g.notes}` : ''}
          </>
        }
        actions={
          <>
            <button
              className="btn"
              onClick={() => {
                const name = window.prompt('Nome del confronto', g.name)
                if (name && name.trim() && name !== g.name) save(g.recipes.map((r) => r.id), name.trim())
              }}
            >
              <Icon name="edit" /> Rinomina
            </button>
            <Link className="btn" href="/piattaforma/ricette">
              <Icon name="plus" /> Aggiungi ricette
            </Link>
            <button
              className="btn ghost"
              onClick={async () => {
                if (!window.confirm('Eliminare questo confronto? Le ricette dei ristoratori non vengono toccate.')) return
                await api.del(`/platform/comparison-groups/${g.id}`)
                qc.invalidateQueries({ queryKey: ['platform', 'groups'] })
                router.push('/piattaforma/confronti')
              }}
            >
              <Icon name="trash" /> Elimina
            </button>
          </>
        }
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Statistiche</h2>
        </div>
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Indicatore</th>
                {STAT_HEAD.map((h) => (
                  <th key={h} className="num">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Costo al kg</td>
                <StatCells s={g.stats.costPerKg} unit="kg" />
              </tr>
              <tr>
                <td>Costo a porzione</td>
                <StatCells s={g.stats.costPerPortion} />
              </tr>
              <tr>
                <td>Costo totale ricetta</td>
                <StatCells s={g.stats.total} />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Ricetta</th>
                <th>Azienda</th>
                <th className="num">€/kg</th>
                <th className="num">€/porzione</th>
                <th className="num">Totale</th>
                <th className="num">Resa</th>
                <th className="num">Ingredienti</th>
                <th className="num">Energia</th>
                <th className="num">Manodopera</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {g.recipes.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.title}</div>
                      <div className="faint small">
                        {r.code} <StatusBadge status={r.status} /> {r.cost ? <CompletenessBadge complete={r.cost.complete} errors={r.cost.errors} /> : null}
                      </div>
                    </td>
                    <td>{r.company}</td>
                    <td className="num">
                      {r.cost?.costPerKg ? euroPer(r.cost.costPerKg, 'kg') : '—'}
                      {r.cost?.costPerKg && minPerKg && r.cost.costPerKg === minPerKg && g.recipes.length > 1 ? (
                        <div>
                          <span className="badge ok">più bassa</span>
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{r.cost?.costPerPortion ? euro(r.cost.costPerPortion) : '—'}</td>
                    <td className="num">{r.cost ? euro(r.cost.total) : '—'}</td>
                    <td className="num small">
                      {r.yield?.finalWeightKg ? `${num(r.yield.finalWeightKg)} kg` : '—'}
                      {r.yield?.portions ? ` · ${num(r.yield.portions)} porz.` : ''}
                    </td>
                    <td className="num">{r.breakdown ? percent(r.breakdown.ingredientsPercent) : '—'}</td>
                    <td className="num">{r.breakdown ? percent(r.breakdown.energyPercent) : '—'}</td>
                    <td className="num">{r.breakdown ? percent(r.breakdown.laborPercent) : '—'}</td>
                    <td className="num">
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn ghost sm" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                          <Icon name={open === r.id ? 'up' : 'down'} /> Ingredienti
                        </button>
                        <button className="btn ghost icon sm" aria-label={`Togli ${r.title} dal confronto`} onClick={() => save(g.recipes.filter((x) => x.id !== r.id).map((x) => x.id))}>
                          <Icon name="x" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {open === r.id ? (
                    <tr>
                      <td colSpan={10} style={{ background: 'var(--surface-2)' }}>
                        {r.ingredients.length === 0 ? (
                          <span className="muted small">Nessun ingrediente diretto.</span>
                        ) : (
                          <table className="table compact">
                            <thead>
                              <tr>
                                <th>Ingrediente</th>
                                <th className="num">Quantità</th>
                                <th className="num">Prezzo unitario</th>
                                <th className="num">Costo</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.ingredients.map((l, i) => (
                                <tr key={i}>
                                  <td>{l.name}</td>
                                  <td className="num">
                                    {num(l.quantity)} {unitLabel(l.unit)}
                                  </td>
                                  <td className="num">{l.unitPrice ? euroPer(l.unitPrice, l.baseUnit, 4) : '—'}</td>
                                  <td className="num">{l.cost ? euro(l.cost) : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
