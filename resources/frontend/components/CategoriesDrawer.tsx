'use client'

/**
 * NUOVO — categorie dei prodotti con l'interruttore «Non alimentare»: per quei prodotti (legna, bicchieri,
 * box, detersivi…) non si chiede il peso del pezzo. Le categorie mai toccate sono riconosciute dal nome.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useCan } from '@/lib/session'
import { Drawer, errorMessage, Skeleton, useToast } from '@/components/ui'
import { useCategorySettings, type CategorySetting } from '@/components/IngredientForm'

export function CategoriesDrawer({ onClose }: { onClose: () => void }) {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const cats = useCategorySettings()
  const [busy, setBusy] = useState<string | null>(null)
  const editable = can('ingredients.manage')
  const toggle = async (c: CategorySetting) => {
    setBusy(c.name)
    try {
      await api.put('/ingredients/category-settings', { name: c.name, nonFood: !c.nonFood })
      await qc.invalidateQueries({ queryKey: ['ingredients'] })
    } catch (e) {
      toast(errorMessage(e), 'err')
    } finally {
      setBusy(null)
    }
  }
  const nonFood = cats.list.filter((c) => c.nonFood)
  return (
    <Drawer title="Categorie dei prodotti" onClose={onClose}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Segna come <strong>non alimentari</strong> le categorie di prodotti che non userai mai a peso nelle ricette (legna, bicchieri, box, detersivi…): per quei prodotti non ti chiederemo quanto pesa un pezzo, nemmeno nelle fatture XML e nelle importazioni. Restano utilizzabili a pezzi (es. il box nel «Calzone da asporto»).
        </p>
        {cats.loading ? (
          <Skeleton rows={6} />
        ) : !cats.list.length ? (
          <p className="small muted">Nessuna categoria: compariranno qui quando avrai inserito dei prodotti.</p>
        ) : (
          <ul className="cat-list">
            {cats.list.map((c) => (
              <li key={c.name}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong>{c.name}</strong>
                  <div className="small faint">
                    {c.count === 1 ? '1 prodotto' : `${c.count} prodotti`}
                    {c.auto && c.nonFood ? ' · riconosciuta dal nome' : ''}
                  </div>
                </div>
                <label className="switch-row">
                  <input type="checkbox" role="switch" checked={c.nonFood} disabled={!editable || busy === c.name} onChange={() => void toggle(c)} />
                  <span className="small">{c.nonFood ? 'Non alimentare' : 'Alimentare'}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {nonFood.length ? <p className="small faint" style={{ margin: 0 }}>Per un singolo prodotto diverso dalla sua categoria usa la casella «Non alimentare» nella sua scheda.</p> : null}
      </div>
    </Drawer>
  )
}
