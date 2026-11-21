'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { date, euro, euroPer, num } from '@/lib/num'
import { useQueryParam } from '@/lib/hooks'
import { PageHead } from '@/components/AppShell'
import { CompanySelect, Pager } from '@/components/PlatformBits'
import { Empty, ErrorBox, Skeleton, useDebounced } from '@/components/ui'

/** NUOVO: prodotti (ingredienti) di tutti i ristoratori, in sola lettura. I doppioni non vengono unificati. */
interface Product {
  id: string
  code: string
  name: string
  category: string | null
  supplier: string | null
  companyId: string
  company: string
  price: { packagePrice: string; packageContent: string; packageUnit: string; validFrom: string; agentName: string | null; unitPrice: string; baseUnit: string } | null
  sameNameSupplierCompanies: number
}

interface Supplier {
  key: string
  name: string
  variants: string[]
  companies: number
  products: number
  agents: string[]
}

export default function PlatformProductsPage() {
  const initialCompany = useQueryParam('azienda')
  const [tab, setTab] = useState<'prodotti' | 'fornitori'>('prodotti')
  const [company, setCompany] = useState('')
  const [text, setText] = useState('')
  const [supplier, setSupplier] = useState('')
  const [page, setPage] = useState(1)
  const q = useDebounced(text, 250)
  const sq = useDebounced(supplier, 250)
  useEffect(() => {
    if (initialCompany) setCompany(initialCompany)
  }, [initialCompany])
  useEffect(() => setPage(1), [q, sq, company])
  const list = useQuery({
    queryKey: ['platform', 'ingredients', q, sq, company, page],
    queryFn: () => api.get<{ data: Product[]; meta: { total: number } }>('/platform/ingredients', { q: q || undefined, supplier: sq || undefined, companyId: company || undefined, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
    enabled: tab === 'prodotti',
  })
  const sup = useQuery({ queryKey: ['platform', 'suppliers'], queryFn: () => api.get<{ data: Supplier[] }>('/platform/suppliers'), enabled: tab === 'fornitori' })

  return (
    <>
      <PageHead title="Tutti i prodotti" sub="Prodotti e fornitori caricati dai ristoratori, con l’ultimo prezzo pagato. I dati dei clienti non vengono modificati da qui." />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'prodotti'} onClick={() => setTab('prodotti')}>
          Prodotti
        </button>
        <button role="tab" aria-selected={tab === 'fornitori'} onClick={() => setTab('fornitori')}>
          Fornitori
        </button>
      </div>
      {tab === 'prodotti' ? (
        <div className="card">
          <div className="toolbar">
            <input className="input" type="search" placeholder="Cerca prodotto o codice" value={text} onChange={(e) => setText(e.target.value)} aria-label="Cerca" />
            <input className="input" type="search" placeholder="Fornitore" value={supplier} onChange={(e) => setSupplier(e.target.value)} aria-label="Fornitore" />
            <CompanySelect value={company} onChange={setCompany} />
          </div>
          {list.error ? (
            <div className="card-body">
              <ErrorBox error={list.error} retry={() => list.refetch()} />
            </div>
          ) : !list.data ? (
            <Skeleton />
          ) : list.data.data.length === 0 ? (
            <Empty title="Nessun prodotto trovato" />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Prodotto</th>
                      <th>Fornitore</th>
                      <th>Azienda</th>
                      <th className="num">Prezzo confezione</th>
                      <th className="num">Normalizzato</th>
                      <th>Dal</th>
                      <th>Agente</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.data.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{p.name}</div>
                          <div className="faint small">
                            {p.code}
                            {p.category ? ` · ${p.category}` : ''}
                          </div>
                        </td>
                        <td>{p.supplier ?? '—'}</td>
                        <td>{p.company}</td>
                        <td className="num">{p.price ? `${euro(p.price.packagePrice)} / ${num(p.price.packageContent)} ${p.price.packageUnit}` : <span className="badge err">Senza prezzo</span>}</td>
                        <td className="num">{p.price ? euroPer(p.price.unitPrice, p.price.baseUnit, 4) : '—'}</td>
                        <td>{p.price ? date(p.price.validFrom) : '—'}</td>
                        <td>{p.price?.agentName ?? '—'}</td>
                        <td className="num">
                          {p.sameNameSupplierCompanies > 1 ? (
                            <span className="badge info" title="Stesso nome e fornitore presso più aziende: restano prodotti distinti">
                              in {p.sameNameSupplierCompanies} aziende
                            </span>
                          ) : null}{' '}
                          <Link className="link small" href={`/piattaforma/prezzi?prodotto=${encodeURIComponent(p.name)}${p.supplier ? `&fornitore=${encodeURIComponent(p.supplier)}` : ''}`}>
                            Statistiche
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={page} pageSize={50} total={list.data.meta.total} onPage={setPage} />
            </>
          )}
        </div>
      ) : (
        <div className="card">
          {sup.error ? (
            <div className="card-body">
              <ErrorBox error={sup.error} retry={() => sup.refetch()} />
            </div>
          ) : !sup.data ? (
            <Skeleton />
          ) : sup.data.data.length === 0 ? (
            <Empty title="Nessun fornitore">I fornitori compaiono quando i ristoratori li indicano sui prodotti.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Fornitore</th>
                  <th className="num">Aziende</th>
                  <th className="num">Prodotti</th>
                  <th>Agenti</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sup.data.data.map((s) => (
                  <tr key={s.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{s.name}</div>
                      {s.variants.length > 1 ? <div className="faint small">scritto anche: {s.variants.filter((v) => v !== s.name).join(', ')}</div> : null}
                    </td>
                    <td className="num">{s.companies}</td>
                    <td className="num">{s.products}</td>
                    <td className="small">{s.agents.length ? s.agents.join(', ') : '—'}</td>
                    <td className="num">
                      <Link className="link small" href={`/piattaforma/prezzi?fornitore=${encodeURIComponent(s.name)}`}>
                        Statistiche
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  )
}
