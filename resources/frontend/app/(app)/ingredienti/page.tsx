'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { date, euro, euroPer, num } from '@/lib/num'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { DataTable, useList, useListState, type Column } from '@/components/DataTable'
import { CreateIngredientDrawer } from '@/components/IngredientForm'
import { Empty, Icon } from '@/components/ui'

interface Row {
  id: string
  code: string
  name: string
  category: string | null
  supplier: string | null
  packageContent: string
  packageUnit: string
  purchaseUnit: string
  edibleYieldPercent: string
  archived: boolean
  price: { status: 'ok' | 'zero' | 'missing'; packagePrice: string | null; validFrom: string | null; unitPrice: string | null; baseUnit: string } | null
}

export default function IngredientsPage() {
  const can = useCan()
  const [state, update] = useListState('ingredients', { sort: 'name' })
  const query = useList<Row>('ingredients', '/ingredients', state)
  const [creating, setCreating] = useState(false)
  const cats = useQuery({ queryKey: ['ingredients', 'categories'], queryFn: () => api.get<{ data: string[] }>('/ingredients/categories'), staleTime: 60_000 })
  const showCosts = can('costs.read')

  const columns: Column<Row>[] = [
    { key: 'code', label: 'Codice', sortable: true, render: (r) => <span className="mono">{r.code}</span> },
    {
      key: 'name',
      label: 'Nome',
      sortable: true,
      render: (r) => (
        <Link href={`/ingredienti/${r.id}`} className="link">
          {r.name}
        </Link>
      ),
    },
    { key: 'category', label: 'Categoria', sortable: true, render: (r) => r.category ?? <span className="faint">—</span> },
    { key: 'supplier', label: 'Fornitore', sortable: true, render: (r) => r.supplier ?? <span className="faint">—</span> },
    { key: 'pack', label: 'Confezione', render: (r) => `${num(r.packageContent)} ${r.packageUnit}` },
    ...(showCosts
      ? ([
          {
            key: 'price',
            label: 'Prezzo confezione',
            num: true,
            render: (r) =>
              r.price?.status === 'missing' ? (
                <span className="badge err">Mancante</span>
              ) : (
                <span title={`Valido dal ${date(r.price?.validFrom)}`}>
                  {euro(r.price?.packagePrice)}
                  {r.price?.status === 'zero' ? <span className="badge warn"> zero</span> : null}
                </span>
              ),
          },
          { key: 'unit', label: 'Prezzo normalizzato', num: true, render: (r) => (r.price?.unitPrice ? euroPer(r.price.unitPrice, r.price.baseUnit, 4) : '—') },
        ] as Column<Row>[])
      : []),
    { key: 'yield', label: 'Resa', num: true, render: (r) => (r.edibleYieldPercent === '100' ? <span className="faint">100%</span> : `${num(r.edibleYieldPercent, 1)}%`) },
  ]

  return (
    <>
      <PageHead
        title="Ingredienti e prodotti"
        sub={showCosts ? 'Prezzi netti IVA, normalizzati per kg, litro o pezzo alla data odierna.' : undefined}
        actions={
          can('ingredients.manage') ? (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Nuovo ingrediente
            </button>
          ) : null
        }
      />
      <datalist id="ingredient-categories">{cats.data?.data.map((c) => <option key={c} value={c} />)}</datalist>
      <DataTable
        columns={columns}
        query={query}
        state={state}
        update={update}
        rowHref={(r) => `/ingredienti/${r.id}`}
        searchPlaceholder="Cerca per nome, codice o fornitore"
        toolbar={
          <>
            <select className="input" value={state.filters.category ?? ''} onChange={(e) => update({ filters: { ...state.filters, category: e.target.value } })} aria-label="Categoria">
              <option value="">Tutte le categorie</option>
              {cats.data?.data.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {showCosts ? (
              <select className="input" value={state.filters.price ?? 'all'} onChange={(e) => update({ filters: { ...state.filters, price: e.target.value } })} aria-label="Stato prezzo">
                <option value="all">Tutti i prezzi</option>
                <option value="missing">Prezzo mancante</option>
                <option value="zero">Prezzo zero</option>
              </select>
            ) : null}
            <select className="input" value={state.filters.archived ?? '0'} onChange={(e) => update({ filters: { ...state.filters, archived: e.target.value } })} aria-label="Archiviati">
              <option value="0">Attivi</option>
              <option value="1">Archiviati</option>
              <option value="all">Tutti</option>
            </select>
          </>
        }
        empty={
          <Empty title="Nessun ingrediente" action={can('ingredients.manage') ? <button className="btn primary" onClick={() => setCreating(true)}>Aggiungi il primo ingrediente</button> : null}>
            Inserisci gli ingredienti uno alla volta o importali da Excel/CSV.
          </Empty>
        }
      />
      {creating ? <CreateIngredientDrawer onClose={() => setCreating(false)} /> : null}
    </>
  )
}
