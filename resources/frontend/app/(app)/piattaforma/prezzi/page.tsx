'use client'

import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { date, euro, euroPer, num } from '@/lib/num'
import type { Stats } from '@/lib/platform'
import { PageHead } from '@/components/AppShell'
import { CompanySelect, STAT_HEAD, StatCells } from '@/components/PlatformBits'
import { Empty, ErrorBox, Field, Skeleton, useDebounced } from '@/components/ui'

/**
 * NUOVO: statistiche sui prezzi pagati, per prodotto, fornitore, agente o combinazioni.
 * Il confronto è sul prezzo normalizzato per unità di base (€/kg, €/l, €/pz) dei prezzi registrati.
 */
interface Point {
  id: string
  date: string
  company: string
  product: string
  supplier: string | null
  agent: string | null
  packagePrice: string
  packageContent: string
  packageUnit: string
  unitPrice: string
  baseUnit: string
}
type Group = Stats & { label: string; baseUnit: string }
interface Result {
  points: Point[]
  summary: Record<'byProduct' | 'bySupplier' | 'byAgent' | 'byCompany' | 'byBaseUnit', Group[]>
  truncated: boolean
}

const GROUPS: Array<[keyof Result['summary'], string]> = [
  ['byAgent', 'Per agente'],
  ['bySupplier', 'Per fornitore'],
  ['byProduct', 'Per prodotto'],
  ['byCompany', 'Per azienda'],
]

export default function PriceStatsPage() {
  const [f, setF] = useState({ product: '', supplier: '', agent: '', from: '', to: '', company: '' })
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    setF((x) => ({ ...x, product: sp.get('prodotto') ?? '', supplier: sp.get('fornitore') ?? '', agent: sp.get('agente') ?? '' }))
  }, [])
  const d = useDebounced(f, 300)
  const ready = !!(d.product || d.supplier || d.agent)
  const q = useQuery({
    queryKey: ['platform', 'price-stats', d],
    queryFn: () =>
      api.get<Result>('/platform/price-stats', {
        product: d.product || undefined,
        supplier: d.supplier || undefined,
        agent: d.agent || undefined,
        from: d.from || undefined,
        to: d.to || undefined,
        companyIds: d.company || undefined,
      }),
    enabled: ready,
    placeholderData: keepPreviousData,
  })
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))

  return (
    <>
      <PageHead title="Statistiche prezzi" sub="Prezzi pagati dai ristoratori, confrontati per unità di base. Utile per verificare gli sconti applicati da fornitori e agenti diversi." />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="grid-3">
            <Field label="Prodotto" htmlFor="ps-prod" hint="parte del nome, es. mozzarella">
              <input id="ps-prod" className="input" type="search" value={f.product} onChange={(e) => set({ product: e.target.value })} />
            </Field>
            <Field label="Fornitore" htmlFor="ps-sup">
              <input id="ps-sup" className="input" type="search" value={f.supplier} onChange={(e) => set({ supplier: e.target.value })} />
            </Field>
            <Field label="Agente" htmlFor="ps-agent">
              <input id="ps-agent" className="input" type="search" value={f.agent} onChange={(e) => set({ agent: e.target.value })} />
            </Field>
          </div>
          <div className="grid-3" style={{ marginTop: 12 }}>
            <Field label="Prezzi validi dal" htmlFor="ps-from">
              <input id="ps-from" className="input" type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
            </Field>
            <Field label="al" htmlFor="ps-to">
              <input id="ps-to" className="input" type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
            </Field>
            <Field label="Azienda" htmlFor="ps-co">
              <CompanySelect value={f.company} onChange={(v) => set({ company: v })} />
            </Field>
          </div>
        </div>
      </div>
      {!ready ? (
        <div className="card">
          <Empty title="Indica un prodotto, un fornitore o un agente">Puoi combinare i filtri: per esempio un prodotto e un fornitore per confrontare gli agenti che lo vendono.</Empty>
        </div>
      ) : q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !q.data ? (
        <div className="card">
          <Skeleton />
        </div>
      ) : q.data.points.length === 0 ? (
        <div className="card">
          <Empty title="Nessun prezzo trovato con questi filtri" />
        </div>
      ) : (
        <div className="stack">
          {q.data.summary.byBaseUnit.length > 1 ? (
            <div className="alert warn">I prezzi trovati sono espressi in unità diverse ({q.data.summary.byBaseUnit.map((g) => g.label).join(', ')}): ogni gruppo è confrontato solo con prezzi della stessa unità.</div>
          ) : null}
          {q.data.truncated ? <div className="alert warn">Sono mostrati i primi 5.000 prezzi: restringi i filtri per un risultato completo.</div> : null}
          {GROUPS.map(([k, title]) => (
            <div className="card" key={k}>
              <div className="card-head">
                <h2>{title}</h2>
              </div>
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>{title.replace('Per ', '').replace(/^./, (c) => c.toUpperCase())}</th>
                      {STAT_HEAD.map((h) => (
                        <th key={h} className="num">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {q.data!.summary[k].map((g) => (
                      <tr key={`${g.label}|${g.baseUnit}`}>
                        <td>{g.label}</td>
                        <StatCells s={g} unit={g.baseUnit} decimals={4} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <div className="card">
            <div className="card-head">
              <h2>Prezzi registrati ({num(q.data.points.length)})</h2>
            </div>
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Dal</th>
                    <th>Prodotto</th>
                    <th>Azienda</th>
                    <th>Fornitore</th>
                    <th>Agente</th>
                    <th className="num">Prezzo confezione</th>
                    <th className="num">Normalizzato</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.points.map((p) => (
                    <tr key={p.id}>
                      <td>{date(p.date)}</td>
                      <td>{p.product}</td>
                      <td>{p.company}</td>
                      <td>{p.supplier ?? '—'}</td>
                      <td>{p.agent ?? '—'}</td>
                      <td className="num">
                        {euro(p.packagePrice)} / {num(p.packageContent)} {p.packageUnit}
                      </td>
                      <td className="num">{euroPer(p.unitPrice, p.baseUnit, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

