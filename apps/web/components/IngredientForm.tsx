'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { todayIso } from '@/lib/num'
import { useCan } from '@/lib/session'
import { Drawer, errorMessage, Field, fieldErrors, NumberInput, useToast } from './ui'

export const UNITS = [
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
  { value: 'ml', label: 'ml' },
  { value: 'cl', label: 'cl' },
  { value: 'l', label: 'l' },
  { value: 'pz', label: 'pz' },
]

export interface IngredientFormValue {
  code: string
  name: string
  category: string
  supplier: string
  notes: string
  purchaseUnit: string
  packageContent: string | null
  packageUnit: string
  usageUnit: string
  edibleYieldPercent: string | null
  densityKgPerL: string | null
  unitWeightKg: string | null
}

export const emptyIngredient = (name = ''): IngredientFormValue => ({
  code: '',
  name,
  category: '',
  supplier: '',
  notes: '',
  purchaseUnit: 'confezione',
  packageContent: null,
  packageUnit: 'kg',
  usageUnit: 'g',
  edibleYieldPercent: '100',
  densityKgPerL: null,
  unitWeightKg: null,
})

const dim = (u: string) => (['g', 'kg'].includes(u) ? 'mass' : ['ml', 'cl', 'l'].includes(u) ? 'volume' : 'count')

/** Campi anagrafici dell'ingrediente, condivisi tra creazione, modifica e creazione rapida dall'editor ricetta. */
export function IngredientFields({ v, set, errors, isNew }: { v: IngredientFormValue; set: (p: Partial<IngredientFormValue>) => void; errors: Record<string, string>; isNew?: boolean }) {
  const needDensity = dim(v.packageUnit) !== dim(v.usageUnit) && [dim(v.packageUnit), dim(v.usageUnit)].includes('volume')
  const needUnitWeight = dim(v.packageUnit) !== dim(v.usageUnit) && [dim(v.packageUnit), dim(v.usageUnit)].includes('count')
  return (
    <div className="stack">
      <div className="grid-2">
        <Field label="Nome" htmlFor="ing-name" required error={errors.name}>
          <input id="ing-name" className="input" value={v.name} onChange={(e) => set({ name: e.target.value })} autoFocus={isNew} />
        </Field>
        <Field label="Codice articolo" htmlFor="ing-code" hint={isNew ? 'Lascia vuoto per generarlo' : undefined} error={errors.code}>
          <input id="ing-code" className="input mono" value={v.code} onChange={(e) => set({ code: e.target.value })} />
        </Field>
        <Field label="Categoria" htmlFor="ing-cat">
          <input id="ing-cat" className="input" value={v.category} onChange={(e) => set({ category: e.target.value })} list="ingredient-categories" />
        </Field>
        <Field label="Fornitore" htmlFor="ing-sup">
          <input id="ing-sup" className="input" value={v.supplier} onChange={(e) => set({ supplier: e.target.value })} />
        </Field>
      </div>
      <div className="section-title">Confezione di acquisto</div>
      <div className="grid-3">
        <Field label="Acquistato in" htmlFor="ing-pu" hint="es. sacco, bottiglia, confezione">
          <input id="ing-pu" className="input" value={v.purchaseUnit} onChange={(e) => set({ purchaseUnit: e.target.value })} />
        </Field>
        <Field label="Contenuto" htmlFor="ing-pc" required error={errors.packageContent}>
          <NumberInput
            id="ing-pc"
            value={v.packageContent}
            onChange={(x) => set({ packageContent: x })}
            invalid={!!errors.packageContent}
            suffix={
              <select className="addon" value={v.packageUnit} onChange={(e) => set({ packageUnit: e.target.value })} aria-label="Unità del contenuto">
                {UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            }
          />
        </Field>
        <Field label="Unità in ricetta" htmlFor="ing-uu" hint="Unità proposta quando lo dosi">
          <select id="ing-uu" className="input" value={v.usageUnit} onChange={(e) => set({ usageUnit: e.target.value })}>
            {UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid-3">
        <Field label="Resa edibile" htmlFor="ing-yield" hint="100% se non ci sono scarti" error={errors.edibleYieldPercent}>
          <NumberInput id="ing-yield" value={v.edibleYieldPercent} onChange={(x) => set({ edibleYieldPercent: x })} suffix="%" invalid={!!errors.edibleYieldPercent} />
        </Field>
        <Field label="Densità" htmlFor="ing-dens" hint={needDensity ? 'Necessaria per convertire volume e peso' : 'Facoltativa'} error={errors.densityKgPerL}>
          <NumberInput id="ing-dens" value={v.densityKgPerL} onChange={(x) => set({ densityKgPerL: x })} suffix="kg/l" invalid={!!errors.densityKgPerL || (needDensity && !v.densityKgPerL)} />
        </Field>
        <Field label="Peso medio unitario" htmlFor="ing-uw" hint={needUnitWeight ? 'Necessario per convertire pezzi e peso' : 'Facoltativo'} error={errors.unitWeightKg}>
          <NumberInput
            id="ing-uw"
            value={v.unitWeightKg ? String(Number(v.unitWeightKg) * 1000) : null}
            onChange={(x) => set({ unitWeightKg: x ? String(Number(x) / 1000) : null })}
            suffix="g/pz"
            invalid={!!errors.unitWeightKg || (needUnitWeight && !v.unitWeightKg)}
          />
        </Field>
      </div>
      <Field label="Note" htmlFor="ing-notes">
        <textarea id="ing-notes" className="input" rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </div>
  )
}

export function ingredientPayload(v: IngredientFormValue) {
  return {
    code: v.code || null,
    name: v.name,
    category: v.category || null,
    supplier: v.supplier || null,
    notes: v.notes || null,
    purchaseUnit: v.purchaseUnit || 'confezione',
    packageContent: v.packageContent ?? '',
    packageUnit: v.packageUnit,
    usageUnit: v.usageUnit,
    edibleYieldPercent: v.edibleYieldPercent ?? '100',
    densityKgPerL: v.densityKgPerL,
    unitWeightKg: v.unitWeightKg,
  }
}

/**
 * Creazione di un ingrediente in un pannello laterale.
 * Dall'editor ricetta non si perde la ricetta in compilazione: al salvataggio l'ingrediente viene restituito e inserito.
 */
export function CreateIngredientDrawer({ initialName = '', onClose, onCreated }: { initialName?: string; onClose: () => void; onCreated?: (ing: { id: string; code: string; name: string; usageUnit: string; packageUnit: string }) => void }) {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState<IngredientFormValue>(emptyIngredient(initialName))
  const [price, setPrice] = useState<{ packagePrice: string | null; validFrom: string; source: string }>({ packagePrice: null, validFrom: todayIso(), source: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (p: Partial<IngredientFormValue>) => setV((x) => ({ ...x, ...p }))

  const save = async () => {
    setBusy(true)
    setError('')
    setErrors({})
    try {
      const body = { ...ingredientPayload(v), ...(can('costs.read') && price.packagePrice !== null ? { initialPrice: { packagePrice: price.packagePrice, validFrom: price.validFrom, source: price.source || null } } : {}) }
      const created = await api.post<{ id: string; code: string; name: string; usageUnit: string; packageUnit: string }>('/ingredients', body)
      await qc.invalidateQueries({ queryKey: ['ingredients'] })
      toast(`Ingrediente “${created.name}” creato.`)
      onCreated?.(created)
      onClose()
    } catch (e) {
      setErrors(fieldErrors(e))
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title="Nuovo ingrediente"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : null} {onCreated ? 'Salva e inserisci' : 'Salva'}
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {error ? <div className="alert err">{error}</div> : null}
        <IngredientFields v={v} set={set} errors={errors} isNew />
        {can('costs.read') ? (
          <>
            <div className="section-title">Prezzo di acquisto (netto IVA)</div>
            <div className="grid-3">
              <Field label="Prezzo della confezione" htmlFor="ing-price" error={errors['initialPrice.packagePrice']} hint="Lascia vuoto se non lo conosci ancora">
                <NumberInput id="ing-price" value={price.packagePrice} onChange={(x) => setPrice((p) => ({ ...p, packagePrice: x }))} suffix="€" />
              </Field>
              <Field label="Valido dal" htmlFor="ing-vf">
                <input id="ing-vf" type="date" className="input" value={price.validFrom} onChange={(e) => setPrice((p) => ({ ...p, validFrom: e.target.value }))} />
              </Field>
              <Field label="Fonte" htmlFor="ing-src" hint="es. fattura, listino">
                <input id="ing-src" className="input" value={price.source} onChange={(e) => setPrice((p) => ({ ...p, source: e.target.value }))} />
              </Field>
            </div>
          </>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Drawer>
  )
}
