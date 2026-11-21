'use client'

import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { euro, euroPer } from '@/lib/num'
import { useQueryParam } from '@/lib/hooks'
import type { PlatformRecipe } from '@/lib/platform'
import { PageHead } from '@/components/AppShell'
import { CompanySelect, Pager } from '@/components/PlatformBits'
import { CompletenessBadge, Drawer, Empty, ErrorBox, errorMessage, Field, fieldErrors, Icon, Skeleton, StatusBadge, useDebounced } from '@/components/ui'

/** NUOVO: ricette di tutti i ristoratori, in sola lettura, con selezione per un confronto. */
export default function PlatformRecipesPage() {
  const initialCompany = useQueryParam('azienda')
  const [company, setCompany] = useState('')
  const [text, setText] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Map<string, PlatformRecipe>>(new Map())
  const [grouping, setGrouping] = useState(false)
  const q = useDebounced(text, 250)
  useEffect(() => {
    if (initialCompany) setCompany(initialCompany)
  }, [initialCompany])
  useEffect(() => setPage(1), [q, company])
  const list = useQuery({
    queryKey: ['platform', 'recipes', q, company, page],
    queryFn: () => api.get<{ data: PlatformRecipe[]; meta: { total: number; pageSize: number } }>('/platform/recipes', { q: q || undefined, companyId: company || undefined, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  })
  const toggle = (r: PlatformRecipe) =>
    setSelected((s) => {
      const n = new Map(s)
      if (n.has(r.id)) n.delete(r.id)
      else n.set(r.id, r)
      return n
    })

  return (
    <>
      <PageHead
        title="Tutte le ricette"
        sub="Ricette di tutti i ristoratori, con i costi aggiornati a oggi. Seleziona ricette equivalenti (anche con nomi diversi) per confrontarle."
        actions={
          <button className="btn primary" disabled={selected.size < 2} onClick={() => setGrouping(true)}>
            <Icon name="copy" /> Confronta {selected.size ? `(${selected.size})` : ''}
          </button>
        }
      />
      <div className="card">
        <div className="toolbar">
          <input className="input" type="search" placeholder="Cerca per nome, codice o categoria" value={text} onChange={(e) => setText(e.target.value)} aria-label="Cerca" />
          <CompanySelect value={company} onChange={setCompany} />
          {selected.size ? (
            <button className="btn ghost sm" onClick={() => setSelected(new Map())}>
              Deseleziona tutto
            </button>
          ) : null}
        </div>
        {list.error ? (
          <div className="card-body">
            <ErrorBox error={list.error} retry={() => list.refetch()} />
          </div>
        ) : !list.data ? (
          <Skeleton />
        ) : list.data.data.length === 0 ? (
          <Empty title="Nessuna ricetta trovata">Prova a cercare con un’altra parola: lo stesso piatto può avere nomi diversi nelle varie aziende.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="check-col" />
                    <th>Ricetta</th>
                    <th>Azienda</th>
                    <th>Stato</th>
                    <th className="num">Costo totale</th>
                    <th className="num">€/kg</th>
                    <th className="num">€/porzione</th>
                    <th>Completezza</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((r) => (
                    <tr key={r.id} onClick={() => toggle(r)} style={{ cursor: 'pointer' }}>
                      <td>
                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r)} onClick={(e) => e.stopPropagation()} aria-label={`Seleziona ${r.title}`} />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.title}</div>
                        <div className="faint small">
                          {r.code}
                          {r.category ? ` · ${r.category}` : ''}
                        </div>
                      </td>
                      <td>{r.company}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="num">{r.cost ? euro(r.cost.total) : '—'}</td>
                      <td className="num">{r.cost?.costPerKg ? euroPer(r.cost.costPerKg, 'kg') : '—'}</td>
                      <td className="num">{r.cost?.costPerPortion ? euro(r.cost.costPerPortion) : '—'}</td>
                      <td>{r.cost ? <CompletenessBadge complete={r.cost.complete} errors={r.cost.errors} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={50} total={list.data.meta.total} onPage={setPage} />
          </>
        )}
      </div>
      {grouping ? <CreateGroup recipes={[...selected.values()]} onClose={() => setGrouping(false)} /> : null}
    </>
  )
}

function CreateGroup({ recipes, onClose }: { recipes: PlatformRecipe[]; onClose: () => void }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [name, setName] = useState(recipes[0]?.title ?? '')
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  return (
    <Drawer
      title="Nuovo confronto"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              setErrors({})
              setError('')
              try {
                const g = await api.post<{ id: string }>('/platform/comparison-groups', { name, notes: notes || null, recipeIds: recipes.map((r) => r.id) })
                qc.invalidateQueries({ queryKey: ['platform', 'groups'] })
                router.push(`/piattaforma/confronti/${g.id}`)
              } catch (e) {
                setErrors(fieldErrors(e))
                setError(errorMessage(e))
              }
            }}
          >
            Crea confronto
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? <div className="alert err">{error}</div> : null}
        <Field label="Nome del confronto" htmlFor="g-name" required error={errors.name} hint="es. il nome comune del piatto">
          <input id="g-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Note" htmlFor="g-notes" error={errors.notes}>
          <textarea id="g-notes" className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="section-title">Ricette incluse</div>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {recipes.map((r) => (
            <li key={r.id}>
              {r.title} <span className="faint">— {r.company}</span>
            </li>
          ))}
        </ul>
      </div>
    </Drawer>
  )
}
