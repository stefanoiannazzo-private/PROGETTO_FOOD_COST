'use client'

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { api, type Paged } from '@/lib/api'
import { Empty, ErrorBox, Icon, Skeleton, useDebounced } from './ui'

export interface Column<T> {
  key: string
  label: ReactNode
  sortable?: boolean
  num?: boolean
  render: (row: T) => ReactNode
  className?: string
}

export interface ListState {
  q: string
  page: number
  pageSize: number
  sort: string
  dir: 'asc' | 'desc'
  filters: Record<string, string>
}

/** Stato della lista conservato nella sessione: tornando alla pagina ritrovi ricerca, filtri e pagina. */
export function useListState(id: string, initial: Partial<ListState> = {}) {
  const defaults: ListState = { q: '', page: 1, pageSize: 25, sort: '', dir: 'asc', filters: {}, ...initial }
  const [state, setState] = useState<ListState>(defaults)
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(`list:${id}`)
      if (saved) setState({ ...defaults, ...JSON.parse(saved) })
    } catch {
      /* storage non disponibile */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  const update = (patch: Partial<ListState>) =>
    setState((s) => {
      const next = { ...s, ...patch, page: patch.page ?? (patch.q !== undefined || patch.filters || patch.sort ? 1 : s.page) }
      try {
        sessionStorage.setItem(`list:${id}`, JSON.stringify(next))
      } catch {
        /* ignora */
      }
      return next
    })
  return [state, update] as const
}

export function useList<T>(queryKey: string, path: string, state: ListState, extra: Record<string, string | undefined> = {}) {
  const q = useDebounced(state.q, 200)
  const params = { q, page: state.page, pageSize: state.pageSize, sort: state.sort || undefined, dir: state.dir, ...state.filters, ...extra }
  return useQuery({
    queryKey: [queryKey, params],
    queryFn: ({ signal }) => api.get<Paged<T> & { meta: Record<string, unknown> }>(path, params, signal),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
}

export function DataTable<T extends { id: string }>({
  columns,
  query,
  state,
  update,
  onRowClick,
  rowHref,
  empty,
  toolbar,
  searchPlaceholder = 'Cerca…',
}: {
  columns: Column<T>[]
  query: ReturnType<typeof useList<T>>
  state: ListState
  update: (p: Partial<ListState>) => void
  onRowClick?: (row: T) => void
  rowHref?: (row: T) => string
  empty?: ReactNode
  toolbar?: ReactNode
  searchPlaceholder?: string
}) {
  const { data, isLoading, isFetching, error, refetch } = query
  const total = data?.meta.total ?? 0
  const pages = Math.max(1, Math.ceil(total / state.pageSize))
  return (
    <div className="card">
      <div className="toolbar">
        <div className="input-group" style={{ maxWidth: 300, flex: '1 1 220px' }}>
          <input className="input" type="search" placeholder={searchPlaceholder} value={state.q} onChange={(e) => update({ q: e.target.value })} aria-label="Cerca" />
          <span className="addon">{isFetching ? <span className="spinner" aria-label="Aggiornamento" /> : <Icon name="search" size={14} />}</span>
        </div>
        {toolbar}
      </div>
      {error ? (
        <div style={{ padding: 12 }}>
          <ErrorBox error={error} retry={() => refetch()} />
        </div>
      ) : isLoading ? (
        <Skeleton rows={6} />
      ) : data && data.data.length === 0 ? (
        (empty ?? <Empty title="Nessun risultato">Modifica la ricerca o i filtri.</Empty>)
      ) : (
        <div className="table-wrap" style={{ opacity: isFetching ? 0.75 : 1, transition: 'opacity .1s' }}>
          <table className="table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={c.num ? 'num' : undefined} aria-sort={state.sort === c.key ? (state.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sortable ? (
                      <button onClick={() => update({ sort: c.key, dir: state.sort === c.key && state.dir === 'asc' ? 'desc' : 'asc' })}>
                        {c.label}
                        {state.sort === c.key ? <Icon name={state.dir === 'asc' ? 'up' : 'down'} size={12} /> : null}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.data.map((row) => (
                <tr
                  key={row.id}
                  className={onRowClick || rowHref ? 'clickable' : undefined}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a,button,input,select')) return
                    if (rowHref) {
                      const href = rowHref(row)
                      if (e.metaKey || e.ctrlKey) window.open(href, '_blank')
                      else window.dispatchEvent(new CustomEvent('foodcost:navigate', { detail: href }))
                    } else onRowClick?.(row)
                  }}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={[c.num ? 'num' : '', c.className ?? ''].join(' ')}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-foot">
        <span>
          {total.toLocaleString('it-IT')} {total === 1 ? 'elemento' : 'elementi'}
        </span>
        <div className="row">
          <select className="input" style={{ width: 'auto', height: 28 }} value={state.pageSize} onChange={(e) => update({ pageSize: Number(e.target.value), page: 1 })} aria-label="Righe per pagina">
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} per pagina
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={state.page <= 1} onClick={() => update({ page: state.page - 1 })} aria-label="Pagina precedente">
            ‹
          </button>
          <span>
            {state.page} / {pages}
          </span>
          <button className="btn sm" disabled={state.page >= pages} onClick={() => update({ page: state.page + 1 })} aria-label="Pagina successiva">
            ›
          </button>
        </div>
      </div>
    </div>
  )
}
