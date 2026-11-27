'use client'

/**
 * NUOVO — prodotti doppi dello stesso fornitore (lo stesso articolo scritto in modi diversi nelle fatture).
 * Per ogni gruppo si sceglie quale tenere: prezzi, ricette, menu e vendite degli altri passano a quello; gli altri
 * vengono archiviati (non cancellati).
 */
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AffectedRecipe } from '@/lib/api'
import { date, euro } from '@/lib/num'
import { Drawer, errorMessage, Skeleton, useToast } from '@/components/ui'

interface Item {
  id: string
  code: string
  name: string
  supplier: string | null
  category: string | null
  pack: string
  prices: number
  lastPrice: string | null
  lastDate: string | null
  recipes: number
}
interface Group {
  key: string
  keepId: string
  items: Item[]
}

export function useDuplicates(enabled = true) {
  return useQuery({ queryKey: ['ingredients', 'duplicates'], queryFn: () => api.get<{ data: Group[] }>('/ingredients/duplicates'), enabled, staleTime: 30_000 })
}

export function DuplicatesDrawer({ onClose }: { onClose: () => void }) {
  const q = useDuplicates()
  const qc = useQueryClient()
  const toast = useToast()
  const [keep, setKeep] = useState<Record<string, string>>({})
  const [on, setOn] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const groups = q.data?.data ?? []
  useEffect(() => {
    setKeep(Object.fromEntries(groups.map((g) => [g.key, g.keepId])))
    setOn(Object.fromEntries(groups.map((g) => [g.key, true])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data])
  const chosen = groups.filter((g) => on[g.key])
  const merge = async (list: Group[]) => {
    setBusy(true)
    try {
      const r = await api.post<{ groups: number; merged: number; prices: number; affectedRecipes: AffectedRecipe[] }>('/ingredients/merge', {
        groups: list.map((g) => ({ keepId: keep[g.key] ?? g.keepId, mergeIds: g.items.map((i) => i.id).filter((id) => id !== (keep[g.key] ?? g.keepId)) })),
      })
      toast(`${r.merged} prodotti doppi uniti in ${r.groups} prodotti; ${r.prices} prezzi spostati nello storico.${r.affectedRecipes.length ? ` Ricalcolate ${r.affectedRecipes.length} ricette.` : ''}`)
      await qc.invalidateQueries({ queryKey: ['ingredients'] })
      await qc.invalidateQueries({ queryKey: ['recipes'] })
    } catch (e) {
      toast(errorMessage(e), 'err')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer
      wide
      title="Prodotti doppi"
      onClose={onClose}
      footer={
        groups.length ? (
          <>
            <button className="btn" onClick={onClose}>
              Chiudi
            </button>
            <button className="btn primary" disabled={busy || !chosen.length} onClick={() => void merge(chosen)}>
              {busy ? <span className="spinner" /> : null} Unisci {chosen.length} {chosen.length === 1 ? 'gruppo' : 'gruppi'}
            </button>
          </>
        ) : undefined
      }
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Lo stesso articolo dello stesso fornitore scritto in modi diversi nelle fatture (es. «FRUTTI DEL CAPPERO in aceto» e «FRUTTI DI CAPPERO in aceto vt1700»). Scegli quale <strong>tenere</strong>: prezzi, ricette, menu e vendite degli altri passano a quello; gli altri vengono <strong>archiviati</strong>, non cancellati. Se nello stesso giorno entrambi hanno un prezzo, resta quello del prodotto tenuto.
        </p>
        {q.isLoading ? (
          <Skeleton rows={6} />
        ) : !groups.length ? (
          <div className="alert ok">Nessun prodotto doppio.</div>
        ) : (
          groups.map((g) => (
            <div key={g.key} className={`card dup-group ${on[g.key] ? '' : 'off'}`}>
              <div className="card-head">
                <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!on[g.key]} onChange={(e) => setOn({ ...on, [g.key]: e.target.checked })} />
                  <strong>{g.items.length} prodotti</strong>
                  <span className="small faint">{g.items[0]?.supplier ?? 'senza fornitore'}</span>
                </label>
              </div>
              <ul className="dup-list">
                {g.items.map((i) => (
                  <li key={i.id}>
                    <label className="row" style={{ gap: 10, cursor: 'pointer', alignItems: 'flex-start' }}>
                      <input type="radio" name={`keep-${g.key}`} checked={(keep[g.key] ?? g.keepId) === i.id} onChange={() => setKeep({ ...keep, [g.key]: i.id })} style={{ marginTop: 3 }} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <strong>{i.name}</strong> <span className="mono small faint">{i.code}</span>
                        {(keep[g.key] ?? g.keepId) === i.id ? <span className="badge ok"> si tiene</span> : <span className="badge"> si unisce</span>}
                        <span className="small faint" style={{ display: 'block' }}>
                          {i.pack} · {i.prices === 1 ? '1 prezzo' : `${i.prices} prezzi`}
                          {i.lastPrice ? ` · ultimo ${euro(i.lastPrice)} del ${date(i.lastDate)}` : ''}
                          {i.recipes ? ` · in ${i.recipes} ${i.recipes === 1 ? 'ricetta' : 'ricette'}` : ''}
                          {i.category ? ` · ${i.category}` : ''}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </Drawer>
  )
}
