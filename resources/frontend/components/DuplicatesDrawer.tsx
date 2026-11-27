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
  /** stessa descrizione del prodotto proposto da tenere (a meno di sv, di/del, singolare/plurale) */
  same: boolean
  /** parole della descrizione ridotte alla radice */
  key: string
}
interface Group {
  key: string
  keepId: string
  /** tutte con la stessa descrizione; altrimenti ci sono descrizioni solo simili da verificare */
  sure: boolean
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
  // NUOVO: per prodotto, se unirlo a quello tenuto (proposti solo quelli con la stessa descrizione)
  const [sel, setSel] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState<Record<string, boolean>>({})
  const all = q.data?.data ?? []
  const groups = all.filter((g) => !hidden[g.key])
  // NUOVO: quando l'elenco si ricarica (es. dopo «Non sono doppi») le scelte già fatte sugli altri gruppi restano;
  // si impostano i valori proposti solo per i gruppi e i prodotti nuovi
  useEffect(() => {
    setKeep((k) => ({ ...Object.fromEntries(groups.map((g) => [g.key, g.keepId])), ...k }))
    // i gruppi con descrizioni solo simili non partono spuntati: vanno guardati
    setOn((o) => ({ ...Object.fromEntries(groups.map((g) => [g.key, g.sure])), ...o }))
    setSel((x) => ({ ...Object.fromEntries(groups.flatMap((g) => g.items.map((i) => [i.id, i.same && i.id !== g.keepId]))), ...x }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data])

  const keepOf = (g: Group) => keep[g.key] ?? g.keepId
  const mergeIds = (g: Group) => g.items.filter((i) => i.id !== keepOf(g) && sel[i.id]).map((i) => i.id)
  const separateIds = (g: Group) => g.items.filter((i) => i.id !== keepOf(g) && !sel[i.id]).map((i) => i.id)
  const chosen = groups.filter((g) => on[g.key])
  const notDup = async (g: Group) => {
    try {
      await api.post('/ingredients/duplicates/ignore', { ids: g.items.map((i) => i.id) })
      // il gruppo sparisce subito; le scelte sugli altri gruppi restano come le hai lasciate
      setHidden((h) => ({ ...h, [g.key]: true }))
      toast('Segnati come prodotti diversi: non verranno più proposti.')
    } catch (e) {
      toast(errorMessage(e), 'err')
    }
  }
  const choose = (g: Group, id: string) => {
    setKeep({ ...keep, [g.key]: id })
    const k = g.items.find((i) => i.id === id)?.key
    setSel({ ...sel, ...Object.fromEntries(g.items.map((i) => [i.id, i.id !== id && i.key === k])) })
  }
  const merge = async (list: Group[]) => {
    setBusy(true)
    try {
      const r = await api.post<{ groups: number; merged: number; prices: number; affectedRecipes: AffectedRecipe[] }>('/ingredients/merge', {
        groups: list.map((g) => ({ keepId: keepOf(g), mergeIds: mergeIds(g), separateIds: separateIds(g) })),
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
          Lo stesso articolo dello stesso fornitore scritto in modi diversi nelle fatture (es. «COSCE DI POLLO», «COSCE DI POLLO SV», «Coscia pollo»). Sono già spuntati i gruppi con la <strong>stessa descrizione</strong>; quelli con descrizioni solo <strong>simili</strong> (es. «ali di pollo» e «ALI DI POLLO bbq») spuntali tu dopo averli guardati. Chi lasci su «resta separato» in un gruppo spuntato non ti verrà più proposto; «Non sono doppi» li separa tutti. Scegli quale <strong>tenere</strong>: prezzi, ricette, menu e vendite degli altri passano a quello; gli altri vengono <strong>archiviati</strong>, non cancellati. Se nello stesso giorno entrambi hanno un prezzo, resta quello del prodotto tenuto.
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
                  {g.sure ? <span className="badge ok">stessa descrizione</span> : <span className="badge warn">descrizioni simili: verifica</span>}
                </label>
                <button className="btn sm ghost" onClick={() => void notDup(g)}>
                  Non sono doppi
                </button>
              </div>
              <ul className="dup-list">
                {g.items.map((i) => {
                  const kept = keepOf(g) === i.id
                  return (
                    <li key={i.id} className={kept || sel[i.id] ? '' : 'dup-skip'}>
                      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                        <label className="dup-keep" title="Tieni questo">
                          <input type="radio" name={`keep-${g.key}`} checked={kept} onChange={() => choose(g, i.id)} />
                          <span className="small">tieni</span>
                        </label>
                        <label className="dup-keep" title="Uniscilo a quello tenuto">
                          <input type="checkbox" disabled={kept} checked={kept || !!sel[i.id]} onChange={(e) => setSel({ ...sel, [i.id]: e.target.checked })} />
                          <span className="small">unisci</span>
                        </label>
                        <span className="grow" style={{ minWidth: 0 }}>
                          <strong>{i.name}</strong> <span className="mono small faint">{i.code}</span>
                          {kept ? <span className="badge ok"> si tiene</span> : sel[i.id] ? <span className="badge"> si unisce</span> : <span className="badge"> resta separato</span>}
                          <span className="small faint" style={{ display: 'block' }}>
                            {i.pack} · {i.prices === 1 ? '1 prezzo' : `${i.prices} prezzi`}
                            {i.lastPrice ? ` · ultimo ${euro(i.lastPrice)} del ${date(i.lastDate)}` : ''}
                            {i.recipes ? ` · in ${i.recipes} ${i.recipes === 1 ? 'ricetta' : 'ricette'}` : ''}
                            {i.category ? ` · ${i.category}` : ''}
                          </span>
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </Drawer>
  )
}
