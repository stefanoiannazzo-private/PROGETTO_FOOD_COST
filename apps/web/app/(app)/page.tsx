'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { date, dateTime, euro } from '@/lib/num'
import { useCan, useMe } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { ErrorBox, Icon, Skeleton, StatusBadge } from '@/components/ui'

interface Dashboard {
  date: string
  counts: { ingredients: number; equipment: number; employees: number | null; recipes: Record<string, number> }
  costs: {
    incompleteCount: number
    incomplete: Array<{ id: string; code: string; title: string; status: string; total: string; errorCount: number; issues: Array<{ message: string; path: string[] }> }>
    missingPrices: number
    recentPrices: Array<{ id: string; name: string; package_price: string; valid_from: string; created_at: string }>
  } | null
  recentRecipes: Array<{ id: string; code: string; title: string; status: string; updated_at: string }>
}

export default function DashboardPage() {
  const { data: me } = useMe()
  const can = useCan()
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/dashboard') })
  const d = q.data
  const recipesTotal = d ? (d.counts.recipes.active ?? 0) + (d.counts.recipes.draft ?? 0) : 0

  return (
    <>
      <PageHead
        title="Dashboard"
        sub={`${me?.company?.name ?? ''} · valori al ${date(d?.date)}`}
        actions={
          can('recipes.manage') ? (
            <Link className="btn primary" href="/ricette/nuova">
              <Icon name="plus" /> Nuova ricetta
            </Link>
          ) : null
        }
      />
      {q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : null}
      {!d ? (
        <Skeleton rows={6} />
      ) : (
        <div className="stack loose">
          <div className="kpis">
            <Link className="kpi" href="/ricette">
              <div className="k-label">Ricette</div>
              <div className="k-value">{recipesTotal}</div>
              <div className="k-sub">
                {d.counts.recipes.active ?? 0} attive · {d.counts.recipes.draft ?? 0} bozze
              </div>
            </Link>
            <Link className="kpi" href="/ingredienti">
              <div className="k-label">Ingredienti</div>
              <div className="k-value">{d.counts.ingredients}</div>
              {d.costs ? <div className="k-sub">{d.costs.missingPrices} senza prezzo</div> : null}
            </Link>
            <Link className="kpi" href="/strumenti">
              <div className="k-label">Strumenti</div>
              <div className="k-value">{d.counts.equipment}</div>
            </Link>
            {d.counts.employees !== null ? (
              <Link className="kpi" href="/dipendenti">
                <div className="k-label">Dipendenti</div>
                <div className="k-value">{d.counts.employees}</div>
              </Link>
            ) : null}
            {d.costs ? (
              <Link className="kpi" href="/ricette" onClick={() => sessionStorage.setItem('list:recipes', JSON.stringify({ filters: { completeness: 'incomplete' } }))}>
                <div className="k-label">Valorizzazioni incomplete</div>
                <div className="k-value" style={{ color: d.costs.incompleteCount ? 'var(--err)' : 'var(--ok)' }}>
                  {d.costs.incompleteCount}
                </div>
                <div className="k-sub">ricette con dati mancanti</div>
              </Link>
            ) : null}
          </div>

          <div className="grid-2" style={{ alignItems: 'start' }}>
            {d.costs ? (
              <div className="card">
                <div className="card-head">
                  <h2>Da completare</h2>
                  <span className="faint small">dati mancanti che impediscono un costo definitivo</span>
                </div>
                {d.costs.incomplete.length === 0 ? (
                  <div className="card-body muted">Tutte le ricette hanno una valorizzazione completa.</div>
                ) : (
                  <table className="table compact">
                    <tbody>
                      {d.costs.incomplete.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <Link className="link" href={`/ricette/${r.id}`} prefetch={false}>
                              {r.title}
                            </Link>
                            <div className="faint small">{r.issues[0]?.message}</div>
                          </td>
                          <td className="num">
                            <span className="badge err">{r.errorCount}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : null}

            <div className="card">
              <div className="card-head">
                <h2>Ricette modificate di recente</h2>
              </div>
              {d.recentRecipes.length === 0 ? (
                <div className="card-body muted">Nessuna ricetta ancora. {can('recipes.manage') ? 'Inizia creando la prima.' : ''}</div>
              ) : (
                <table className="table compact">
                  <tbody>
                    {d.recentRecipes.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link className="link" href={`/ricette/${r.id}`} prefetch={false}>
                            {r.title}
                          </Link>{' '}
                          <span className="faint small mono">{r.code}</span>
                        </td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="num faint small">{dateTime(r.updated_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {d.costs && d.costs.recentPrices.length ? (
              <div className="card">
                <div className="card-head">
                  <h2>Ultimi prezzi inseriti</h2>
                </div>
                <table className="table compact">
                  <tbody>
                    {d.costs.recentPrices.map((p, i) => (
                      <tr key={`${p.id}-${i}`}>
                        <td>
                          <Link className="link" href={`/ingredienti/${p.id}`} prefetch={false}>
                            {p.name}
                          </Link>
                        </td>
                        <td className="num">{euro(p.package_price)}</td>
                        <td className="num faint small">dal {date(p.valid_from)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  )
}
