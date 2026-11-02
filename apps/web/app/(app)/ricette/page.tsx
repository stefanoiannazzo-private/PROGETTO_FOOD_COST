'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime, euro, num } from '@/lib/num'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { DataTable, useList, useListState, type Column } from '@/components/DataTable'
import { CompletenessBadge, Empty, Icon, StatusBadge } from '@/components/ui'

interface Row {
  id: string
  code: string
  title: string
  category: string | null
  status: string
  updatedAt: string
  revisionNumber: number | null
  finalWeightKg: string | null
  portions: string | null
  cost: { complete: boolean; total: string; costPerKg: string | null; costPerPortion: string | null; errors: number } | null
}

export default function RecipesPage() {
  const can = useCan()
  const [state, update] = useListState('recipes', { sort: 'title' })
  const query = useList<Row>('recipes', '/recipes', state)
  const cats = useQuery({ queryKey: ['recipes', 'categories'], queryFn: () => api.get<{ data: string[] }>('/recipes/categories'), staleTime: 60_000 })
  const showCosts = can('costs.read')
  const columns: Column<Row>[] = [
    { key: 'code', label: 'Codice', sortable: true, render: (r) => <span className="mono">{r.code}</span> },
    {
      key: 'title',
      label: 'Ricetta',
      sortable: true,
      render: (r) => (
        <Link className="link" href={`/ricette/${r.id}`}>
          {r.title}
        </Link>
      ),
    },
    { key: 'category', label: 'Categoria', sortable: true, render: (r) => r.category ?? <span className="faint">—</span> },
    { key: 'status', label: 'Stato', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'yield',
      label: 'Resa',
      render: (r) =>
        r.finalWeightKg || r.portions ? (
          [r.finalWeightKg ? `${num(r.finalWeightKg)} kg` : null, r.portions ? `${num(r.portions)} porz.` : null].filter(Boolean).join(' · ')
        ) : (
          <span className="faint">—</span>
        ),
    },
    ...(showCosts
      ? ([
          { key: 'total', label: 'Costo lotto', sortable: true, num: true, render: (r) => (r.cost ? euro(r.cost.total) : '—') },
          { key: 'perKg', label: '€/kg', sortable: true, num: true, render: (r) => (r.cost?.costPerKg ? euro(r.cost.costPerKg) : '—') },
          { key: 'perPortion', label: '€/porzione', num: true, render: (r) => (r.cost?.costPerPortion ? euro(r.cost.costPerPortion) : '—') },
          { key: 'complete', label: 'Valorizzazione', render: (r) => (r.cost ? <CompletenessBadge complete={r.cost.complete} errors={r.cost.errors} /> : null) },
        ] as Column<Row>[])
      : []),
    { key: 'updated', label: 'Modificata', sortable: true, render: (r) => <span className="faint small">{dateTime(r.updatedAt)}</span> },
  ]
  return (
    <>
      <PageHead
        title="Ricette"
        sub={showCosts ? 'Valorizzazione corrente alla data odierna; i totali incompleti sono segnalati.' : undefined}
        actions={
          can('recipes.manage') ? (
            <Link className="btn primary" href="/ricette/nuova">
              <Icon name="plus" /> Nuova ricetta
            </Link>
          ) : null
        }
      />
      <DataTable
        columns={columns}
        query={query}
        state={state}
        update={update}
        rowHref={(r) => `/ricette/${r.id}`}
        searchPlaceholder="Cerca per titolo o codice"
        toolbar={
          <>
            <select className="input" value={state.filters.status ?? 'all'} onChange={(e) => update({ filters: { ...state.filters, status: e.target.value } })} aria-label="Stato">
              <option value="all">Bozze e attive</option>
              <option value="active">Attive</option>
              <option value="draft">Bozze</option>
              <option value="archived">Archiviate</option>
            </select>
            <select className="input" value={state.filters.category ?? ''} onChange={(e) => update({ filters: { ...state.filters, category: e.target.value } })} aria-label="Categoria">
              <option value="">Tutte le categorie</option>
              {cats.data?.data.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {showCosts ? (
              <select className="input" value={state.filters.completeness ?? 'all'} onChange={(e) => update({ filters: { ...state.filters, completeness: e.target.value } })} aria-label="Completezza">
                <option value="all">Qualsiasi completezza</option>
                <option value="complete">Valorizzazione completa</option>
                <option value="incomplete">Valorizzazione incompleta</option>
              </select>
            ) : null}
          </>
        }
        empty={
          <Empty title="Nessuna ricetta" action={can('recipes.manage') ? <Link className="btn primary" href="/ricette/nuova">Crea la prima ricetta</Link> : null}>
            Le ricette possono contenere altre ricette come semilavorati (es. il ragù dentro la lasagna).
          </Empty>
        }
      />
    </>
  )
}
