'use client'

import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { euro, todayIso } from '@/lib/num'
import { useCan } from '@/lib/session'
import { sizeFromName } from '@/lib/sizes'
import { Drawer, errorMessage, Field, fieldErrors, Icon, NumberInput, useToast } from './ui'

export const UNITS = [
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
  { value: 'ml', label: 'ml' },
  { value: 'cl', label: 'cl' },
  { value: 'l', label: 'l' },
  { value: 'pz', label: 'pz' },
]

/** NUOVO — come il ristoratore paga il prodotto: al kg, al litro, al pezzo (con il suo peso) o a confezione. */
export type BuyMode = 'kg' | 'l' | 'pz' | 'conf'

const MODES: Array<{ value: BuyMode; title: string; ex: string }> = [
  { value: 'kg', title: 'Al kg', ex: 'carne, pesce, formaggi al taglio, frutta e verdura' },
  { value: 'l', title: 'Al litro', ex: 'latte sfuso, olio o vino alla spina' },
  { value: 'pz', title: 'Al pezzo', ex: 'un girello intero, una forma di formaggio, un’anguria' },
  { value: 'conf', title: 'A confezione', ex: 'cartone, bottiglia, sacco, barattolo, vaschetta' },
]

const PACK_TYPES = ['confezione', 'cartone', 'bottiglia', 'sacco', 'barattolo', 'vaschetta', 'latta', 'busta', 'scatola', 'tanica', 'fusto', 'cassetta', 'vasetto']

export interface IngredientFormValue {
  code: string
  name: string
  category: string
  supplier: string
  notes: string
  /** NUOVO: modalità di acquisto (ricavata da purchaseUnit/packageContent/packageUnit per i prodotti esistenti) */
  mode: BuyMode | null
  purchaseUnit: string
  packageContent: string | null
  packageUnit: string
  usageUnit: string
  edibleYieldPercent: string | null
  densityKgPerL: string | null
  unitWeightKg: string | null
  /** NUOVO: eccezione «non alimentare» sul prodotto (null = come la categoria) */
  nonFood?: boolean | null
}

/* NUOVO — prodotti non alimentari: la categoria decide (riconosciuta dal nome finché il titolare non la imposta). */
const NON_FOOD_WORDS = ['materiale', 'consumo', 'combustib', 'legna', 'pellet', 'carbone', 'pulizia', 'pulizie', 'detersiv', 'detergent', 'igien', 'sanific', 'imball', 'packaging', 'monouso', 'usa e getta', 'cancelleria', 'stoviglie', 'attrezz', 'utensil', 'manutenzion', 'ricambi', 'divise', 'abbigliamento', 'non alimentar', 'carta e plastica', 'plastica', 'sacchi']
export const guessNonFood = (category: string) => {
  const c = category.trim().toLowerCase()
  return !!c && NON_FOOD_WORDS.some((w) => c.includes(w))
}
export interface CategorySetting {
  name: string
  count: number
  nonFood: boolean
  auto: boolean
}
export function useCategorySettings() {
  const q = useQuery({ queryKey: ['ingredients', 'category-settings'], queryFn: () => api.get<{ data: CategorySetting[] }>('/ingredients/category-settings'), staleTime: 60_000 })
  const list = q.data?.data ?? []
  const map = new Map(list.map((c) => [c.name.trim().toLowerCase(), c.nonFood]))
  const categoryNonFood = (category: string) => {
    const k = category.trim().toLowerCase()
    return map.has(k) ? !!map.get(k) : guessNonFood(category)
  }
  return { list, categoryNonFood, loading: q.isLoading }
}

export const emptyIngredient = (name = ''): IngredientFormValue => ({
  code: '',
  name,
  category: '',
  supplier: '',
  notes: '',
  mode: null,
  purchaseUnit: 'confezione',
  packageContent: null,
  packageUnit: 'kg',
  usageUnit: 'g',
  edibleYieldPercent: '100',
  densityKgPerL: null,
  unitWeightKg: null,
  nonFood: null,
})

const dim = (u: string) => (['g', 'kg'].includes(u) ? 'mass' : ['ml', 'cl', 'l'].includes(u) ? 'volume' : 'count')
const toBase: Record<string, number> = { g: 0.001, kg: 1, ml: 0.001, cl: 0.01, l: 1, pz: 1 }
const baseLabel = (u: string) => (dim(u) === 'mass' ? 'kg' : dim(u) === 'volume' ? 'l' : 'pz')

/** Modalità di un prodotto già registrato, dai campi che esistono nel database. */
export function inferMode(purchaseUnit: string | null | undefined, content: string | number | null | undefined, unit: string): BuyMode {
  const pu = (purchaseUnit ?? '').trim().toLowerCase()
  // NUOVO: «1 kg» / «1 l» senza un tipo di confezione vero = prezzo al kg / al litro
  const generic = ['kg', '', 'confezione', 'conf', 'cf'].includes(pu)
  if (Number(content) === 1 && unit === 'kg' && generic) return 'kg'
  if (Number(content) === 1 && unit === 'l' && (pu === 'litro' || pu === 'l' || generic)) return 'l'
  if (pu === 'pezzo' && dim(unit) === 'mass') return 'pz'
  return 'conf'
}

/** Confezione equivalente alla modalità scelta. */
export function packageOf(mode: BuyMode, v: { purchaseUnit: string; packageContent: string | null; packageUnit: string }) {
  if (mode === 'kg') return { purchaseUnit: 'kg', packageContent: '1', packageUnit: 'kg' }
  if (mode === 'l') return { purchaseUnit: 'litro', packageContent: '1', packageUnit: 'l' }
  if (mode === 'pz') return { purchaseUnit: 'pezzo', packageContent: v.packageContent, packageUnit: dim(v.packageUnit) === 'mass' ? v.packageUnit : 'kg' }
  return { purchaseUnit: v.purchaseUnit && !['kg', 'litro', 'pezzo'].includes(v.purchaseUnit) ? v.purchaseUnit : 'confezione', packageContent: v.packageContent, packageUnit: v.packageUnit }
}

/** Prezzo al kg / litro / pezzo, solo per mostrarlo mentre si scrive (il calcolo vero lo fa il server). */
export function unitPricePreview(price: string | null, mode: BuyMode | null, content: string | null, unit: string): string | null {
  if (!price || !mode) return null
  const p = Number(price)
  if (!Number.isFinite(p) || p <= 0) return null
  if (mode === 'kg' || mode === 'l') return null
  const c = Number(content) * (toBase[unit] ?? 1)
  if (!Number.isFinite(c) || c <= 0) return null
  return `= ${euro(String(p / c), 2)} al ${baseLabel(unit) === 'pz' ? 'pezzo' : baseLabel(unit)}`
}

const defaultUsage = (mode: BuyMode, unit: string) => (mode === 'l' ? 'ml' : mode === 'kg' || mode === 'pz' ? 'g' : dim(unit) === 'volume' ? 'ml' : dim(unit) === 'count' ? 'pz' : 'g')

/** Blocco "Come lo paghi?": modalità, prezzo (facoltativo nel blocco) e peso/contenuto. Usato da creazione, modifica e nuovo prezzo. */
export function BuyBlock({
  mode,
  purchaseUnit,
  content,
  unit,
  onChange,
  price,
  onPrice,
  errors,
  idPrefix = 'buy',
  lockDimension,
}: {
  mode: BuyMode | null
  purchaseUnit: string
  content: string | null
  unit: string
  onChange: (p: { mode?: BuyMode; purchaseUnit?: string; packageContent?: string | null; packageUnit?: string }) => void
  price?: string | null
  onPrice?: (x: string | null) => void
  errors: Record<string, string>
  idPrefix?: string
  /** con prezzi già registrati la grandezza (peso, volume, pezzi) non può cambiare */
  lockDimension?: 'mass' | 'volume' | 'count'
}) {
  const allowed = (m: BuyMode) => !lockDimension || (m === 'kg' || m === 'pz' ? lockDimension === 'mass' : m === 'l' ? lockDimension === 'volume' : true)
  const units = UNITS.filter((u) => !lockDimension || dim(u.value) === lockDimension)
  const preview = price !== undefined ? unitPricePreview(price, mode, content, unit) : null
  const priceLabel = mode === 'kg' ? 'Prezzo al kg' : mode === 'l' ? 'Prezzo al litro' : mode === 'pz' ? 'Prezzo del pezzo' : 'Prezzo della confezione'
  return (
    <div className="stack">
      <div className="field">
        <label>
          Come lo paghi?<span aria-hidden="true"> *</span>
        </label>
        <div className="buy-modes" role="group" aria-label="Come lo paghi">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className="buy-mode"
              aria-pressed={mode === m.value}
              disabled={!allowed(m.value)}
              style={!allowed(m.value) ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              title={!allowed(m.value) ? 'Non compatibile con i prezzi già registrati (peso, volume o pezzi)' : undefined}
              onClick={() => {
                const next = packageOf(m.value, { purchaseUnit, packageContent: m.value === mode ? content : m.value === 'pz' || m.value === 'conf' ? (mode === 'pz' || mode === 'conf' ? content : null) : null, packageUnit: m.value === 'conf' && lockDimension ? (units[0]?.value ?? unit) : m.value === 'pz' ? 'kg' : unit })
                onChange({ mode: m.value, ...next })
              }}
            >
              <span className="bm-title">{m.title}</span>
              <span className="bm-ex">{m.ex}</span>
            </button>
          ))}
        </div>
        {errors.mode ? (
          <span className="error" role="alert">
            {errors.mode}
          </span>
        ) : null}
      </div>
      {mode ? (
        <div className="grid-3">
          {onPrice ? (
            <Field label={`${priceLabel} (senza IVA)`} htmlFor={`${idPrefix}-price`} required error={errors.packagePrice ?? errors['initialPrice.packagePrice']} hint={preview ? <span className="price-preview">{preview}</span> : 'L’imponibile della fattura, IVA esclusa'}>
              <NumberInput id={`${idPrefix}-price`} value={price ?? null} onChange={onPrice} suffix="€" invalid={!!(errors.packagePrice ?? errors['initialPrice.packagePrice'])} />
            </Field>
          ) : null}
          {mode === 'pz' ? (
            <Field label="Quanto pesa un pezzo (circa)?" htmlFor={`${idPrefix}-cont`} required error={errors.packageContent} hint="es. girello 3,2 kg · forma di parmigiano 38 kg">
              <NumberInput
                id={`${idPrefix}-cont`}
                value={content}
                onChange={(x) => onChange({ packageContent: x })}
                invalid={!!errors.packageContent}
                suffix={
                  <select className="addon" value={dim(unit) === 'mass' ? unit : 'kg'} onChange={(e) => onChange({ packageUnit: e.target.value })} aria-label="Unità del peso">
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                  </select>
                }
              />
            </Field>
          ) : null}
          {mode === 'conf' ? (
            <>
              <Field label="Che confezione è?" htmlFor={`${idPrefix}-pu`} hint="es. cartone, bottiglia, sacco">
                <input id={`${idPrefix}-pu`} className="input" value={purchaseUnit} onChange={(e) => onChange({ purchaseUnit: e.target.value })} list={`${idPrefix}-pack-types`} />
                <datalist id={`${idPrefix}-pack-types`}>
                  {PACK_TYPES.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </Field>
              <Field label="Quanto contiene?" htmlFor={`${idPrefix}-cont`} required error={errors.packageContent} hint="es. sacco 25 kg · bottiglia 0,25 l · cartone 6 bottiglie da 0,75 l → 4,5 l · 90 uova → 90 pz (poi ti chiediamo il peso di un uovo)">
                <NumberInput
                  id={`${idPrefix}-cont`}
                  value={content}
                  onChange={(x) => onChange({ packageContent: x })}
                  invalid={!!errors.packageContent}
                  suffix={
                    <select className="addon" value={unit} onChange={(e) => onChange({ packageUnit: e.target.value })} aria-label="Unità del contenuto">
                      {units.map((u) => (
                        <option key={u.value} value={u.value}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                  }
                />
              </Field>
            </>
          ) : null}
        </div>
      ) : (
        <div className="faint small">Scegli come lo paghi: poi ti chiediamo solo i dati che servono.</div>
      )}
    </div>
  )
}

/** Suggerimenti di categorie e fornitori già usati. */
function useSuggestions() {
  const cats = useQuery({ queryKey: ['ingredients', 'categories'], queryFn: () => api.get<{ data: string[] }>('/ingredients/categories'), staleTime: 60_000 })
  const sups = useQuery({ queryKey: ['ingredients', 'suppliers'], queryFn: () => api.get<{ data: string[] }>('/ingredients/suppliers'), staleTime: 60_000 })
  return { categories: cats.data?.data ?? [], suppliers: sups.data?.data ?? [] }
}

/** Agente: tendina con quelli già usati (prima quelli del fornitore) più "nuovo agente". */
export function AgentSelect({ id, supplier, value, onChange }: { id: string; supplier: string; value: string; onChange: (x: string) => void }) {
  const q = useQuery({ queryKey: ['ingredients', 'agents'], queryFn: () => api.get<{ data: Array<{ name: string; supplier: string | null }> }>('/ingredients/agents'), staleTime: 60_000 })
  const all = q.data?.data ?? []
  const sup = supplier.trim().toLowerCase()
  const mine = [...new Set(all.filter((a) => sup && (a.supplier ?? '').trim().toLowerCase() === sup).map((a) => a.name))]
  const others = [...new Set(all.map((a) => a.name))].filter((n) => !mine.includes(n))
  const known = mine.includes(value) || others.includes(value)
  const [adding, setAdding] = useState(false)
  if (adding || (value !== '' && !known)) {
    return (
      <div className="row" style={{ gap: 6 }}>
        <input id={id} className="input grow" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Nome e cognome dell’agente" autoFocus={adding} />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label="Scegli dall’elenco"
          title="Scegli dall’elenco"
          onClick={() => {
            setAdding(false)
            onChange('')
          }}
        >
          <Icon name="x" />
        </button>
      </div>
    )
  }
  return (
    <select
      id={id}
      className="input"
      value={value}
      onChange={(e) => {
        if (e.target.value === '__new__') {
          setAdding(true)
          onChange('')
        } else onChange(e.target.value)
      }}
    >
      <option value="">— nessun agente —</option>
      {mine.length ? (
        <optgroup label={`Agenti di ${supplier.trim()}`}>
          {mine.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </optgroup>
      ) : null}
      {others.length ? (
        <optgroup label={mine.length ? 'Altri agenti' : 'Agenti già inseriti'}>
          {others.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </optgroup>
      ) : null}
      <option value="__new__">+ Nuovo agente…</option>
    </select>
  )
}

/** Controlli del modulo prima dell'invio: categoria e fornitore obbligatori, come lo paghi e peso/contenuto. */
export function validateIngredient(v: IngredientFormValue, nonFood = false): Record<string, string> {
  const e: Record<string, string> = {}
  if (!v.name.trim()) e.name = 'Inserisci il nome del prodotto.'
  if (!v.category.trim()) e.category = 'Scegli o scrivi la categoria.'
  if (!v.supplier.trim()) e.supplier = 'Scegli o scrivi il fornitore.'
  if (!v.mode) e.mode = 'Scegli come lo paghi.'
  if ((v.mode === 'pz' || v.mode === 'conf') && !(Number(v.packageContent) > 0)) e.packageContent = v.mode === 'pz' ? 'Indica il peso del pezzo.' : 'Indica quanto contiene la confezione.'
  // NUOVO: confezione «a pezzi» → serve sapere quanto pesa o contiene un pezzo, altrimenti in ricetta si dosa solo a pezzi
  if (!nonFood && v.mode === 'conf' && dim(v.packageUnit) === 'count' && !(Number(v.unitWeightKg) > 0)) e.unitWeightKg = 'Indica quanto pesa o contiene un pezzo: senza, nelle ricette potrai usarlo solo a pezzi.'
  return e
}

/**
 * Campi dell'ingrediente, condivisi tra creazione, modifica e creazione rapida dall'editor ricetta.
 * NUOVO: impostati sul modo di ragionare del ristoratore ("come lo paghi?"); i campi tecnici sono in "Altri dettagli".
 */
export function IngredientFields({
  v,
  set,
  errors,
  isNew,
  price,
  agent,
  moreDetails,
  lockDimension,
}: {
  v: IngredientFormValue
  set: (p: Partial<IngredientFormValue>) => void
  errors: Record<string, string>
  isNew?: boolean
  price?: { value: string | null; onChange: (x: string | null) => void }
  agent?: { value: string; onChange: (x: string) => void }
  moreDetails?: ReactNode
  lockDimension?: 'mass' | 'volume' | 'count'
}) {
  const s = useSuggestions()
  const cats = useCategorySettings()
  const catNonFood = cats.categoryNonFood(v.category)
  const nonFood = v.nonFood ?? catNonFood
  const [usageTouched, setUsageTouched] = useState(!isNew)
  const needDensity = dim(v.packageUnit) !== dim(v.usageUnit) && [dim(v.packageUnit), dim(v.usageUnit)].includes('volume')
  const needUnitWeight = dim(v.packageUnit) !== dim(v.usageUnit) && [dim(v.packageUnit), dim(v.usageUnit)].includes('count') && v.mode !== 'pz'
  return (
    <div className="stack">
      {isNew ? (
        <div className="alert info small">
          <Icon name="book" />
          <div>
            Inserisci il prodotto <strong>come lo trovi in fattura</strong>: il nome, come lo paghi (al kg, al litro, al pezzo o a confezione) e il prezzo senza IVA. Se lo compri a confezione ti chiediamo quanto contiene: il prezzo al kg lo calcoliamo noi.
          </div>
        </div>
      ) : null}
      <Field label="Nome del prodotto" htmlFor="ing-name" required error={errors.name} hint="es. Girello di vitello, Passata di pomodoro, Uova fresche">
        <input id="ing-name" className="input" value={v.name} onChange={(e) => set({ name: e.target.value })} autoFocus={isNew} />
      </Field>
      <BuyBlock
        mode={v.mode}
        purchaseUnit={v.purchaseUnit}
        content={v.packageContent}
        unit={v.packageUnit}
        errors={errors}
        idPrefix="ing"
        lockDimension={lockDimension}
        price={price?.value}
        onPrice={price?.onChange}
        onChange={(p) => {
          const next: Partial<IngredientFormValue> = { ...p }
          if (!usageTouched && (p.mode || p.packageUnit)) next.usageUnit = defaultUsage(p.mode ?? v.mode ?? 'conf', p.packageUnit ?? v.packageUnit)
          set(next)
        }}
      />
      {v.mode === 'conf' ? <PackHelpers v={v} set={set} errors={errors} lockDimension={lockDimension} nonFood={nonFood} onUsage={(u) => !usageTouched && set({ usageUnit: u })} /> : null}
      {!isNew && v.mode ? <div className="faint small">Se correggi la confezione, sotto ti proponiamo di correggerla anche nei prezzi già registrati (l’importo pagato resta uguale).</div> : null}
      <div className="grid-3">
        <Field label="Resa" htmlFor="ing-yield" hint="Facoltativa. Su 10 kg te ne restano 8 dopo la pulizia? Scrivi 80%" error={errors.edibleYieldPercent}>
          <NumberInput id="ing-yield" value={v.edibleYieldPercent} onChange={(x) => set({ edibleYieldPercent: x })} suffix="%" invalid={!!errors.edibleYieldPercent} />
        </Field>
        <Field label="Categoria" htmlFor="ing-cat" required error={errors.category} hint="Scrivi e scegli tra quelle già usate, es. Carne, Latticini">
          <input id="ing-cat" className="input" value={v.category} onChange={(e) => set({ category: e.target.value })} list="ing-cat-list" autoComplete="off" />
          <datalist id="ing-cat-list">
            {s.categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <label className="row small nonfood-check" style={{ gap: 6, marginTop: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={nonFood} onChange={(e) => set({ nonFood: e.target.checked === catNonFood ? null : e.target.checked })} />
            <span>
              Non alimentare <span className="faint">(legna, bicchieri, box…: non serve il peso{v.nonFood != null && v.category.trim() ? ', eccezione rispetto alla categoria' : ''})</span>
            </span>
          </label>
        </Field>
        <Field label="Unità in ricetta" htmlFor="ing-uu" hint="Unità proposta quando lo dosi">
          <select
            id="ing-uu"
            className="input"
            value={v.usageUnit}
            onChange={(e) => {
              setUsageTouched(true)
              set({ usageUnit: e.target.value })
            }}
          >
            {UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid-2">
        <Field label="Fornitore" htmlFor="ing-sup" required error={errors.supplier} hint="Scrivi e scegli tra quelli già usati">
          <input id="ing-sup" className="input" value={v.supplier} onChange={(e) => set({ supplier: e.target.value })} list="ing-sup-list" autoComplete="off" />
          <datalist id="ing-sup-list">
            {s.suppliers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        {agent ? (
          <Field label="Agente" htmlFor="ing-agent" hint="Facoltativo: prima quelli di questo fornitore">
            <AgentSelect id="ing-agent" supplier={v.supplier} value={agent.value} onChange={agent.onChange} />
          </Field>
        ) : null}
      </div>
      <Field label="Note" htmlFor="ing-notes">
        <textarea id="ing-notes" className="input" rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      <details className="more" open={!!(errors.code || errors.densityKgPerL || errors.unitWeightKg || needDensity || (needUnitWeight && !v.unitWeightKg))}>
        <summary>Altri dettagli (facoltativi)</summary>
        <div className="stack">
          <div className="grid-3">
            <Field label="Codice articolo" htmlFor="ing-code" hint={isNew ? 'Lascia vuoto per generarlo' : undefined} error={errors.code}>
              <input id="ing-code" className="input mono" value={v.code} onChange={(e) => set({ code: e.target.value })} />
            </Field>
            <Field label="Densità" htmlFor="ing-dens" hint={needDensity ? 'Necessaria per passare da litri a grammi' : 'es. olio 0,92 kg/l'} error={errors.densityKgPerL}>
              <NumberInput id="ing-dens" value={v.densityKgPerL} onChange={(x) => set({ densityKgPerL: x })} suffix="kg/l" invalid={!!errors.densityKgPerL || (needDensity && !v.densityKgPerL)} />
            </Field>
            {v.mode === 'conf' && dim(v.packageUnit) === 'count' ? null : (
            <Field label="Peso medio di un pezzo" htmlFor="ing-uw" hint={needUnitWeight ? 'Necessario per passare da pezzi a grammi' : 'es. un uovo 60 g'} error={errors.unitWeightKg}>
              <NumberInput
                id="ing-uw"
                value={v.unitWeightKg ? String(Number(v.unitWeightKg) * 1000) : null}
                onChange={(x) => set({ unitWeightKg: x ? String(Number(x) / 1000) : null })}
                suffix="g/pz"
                invalid={!!errors.unitWeightKg || (needUnitWeight && !v.unitWeightKg)}
              />
            </Field>
            )}
          </div>
          {moreDetails}
        </div>
      </details>
    </div>
  )
}

/**
 * NUOVO — aiuti per la confezione: (1) il formato letto dal nome («tanica3L» → 3 l) da usare con un clic;
 * (2) se la confezione contiene pezzi, quanto pesa o contiene un pezzo (g o ml), obbligatorio.
 */
function PackHelpers({
  v,
  set,
  errors,
  lockDimension,
  nonFood,
  onUsage,
}: {
  v: IngredientFormValue
  set: (p: Partial<IngredientFormValue>) => void
  errors: Record<string, string>
  lockDimension?: 'mass' | 'volume' | 'count'
  nonFood?: boolean
  onUsage: (u: string) => void
}) {
  const [pieceUnit, setPieceUnit] = useState<'g' | 'ml'>(v.densityKgPerL && Number(v.densityKgPerL) === 1 && dim(v.usageUnit) === 'volume' ? 'ml' : 'g')
  const sz = sizeFromName(v.name)
  const same = sz && Number(v.packageContent) === Number(sz.qty) && v.packageUnit === sz.unit
  const canUse = sz && !same && (!lockDimension || lockDimension === dim(sz.unit))
  const counted = dim(v.packageUnit) === 'count' && !nonFood
  const density = Number(v.densityKgPerL) > 0 ? Number(v.densityKgPerL) : 1
  const shown = v.unitWeightKg ? String(Math.round((Number(v.unitWeightKg) * 1000 * (pieceUnit === 'ml' ? 1 / density : 1)) * 1000) / 1000) : null
  const setPiece = (x: string | null, unit = pieceUnit) => {
    if (!x) return set({ unitWeightKg: null })
    const d = unit === 'ml' ? (Number(v.densityKgPerL) > 0 ? Number(v.densityKgPerL) : 1) : 1
    set({ unitWeightKg: String((Number(x) / 1000) * d), ...(unit === 'ml' && !(Number(v.densityKgPerL) > 0) ? { densityKgPerL: '1' } : {}) })
  }
  return (
    <>
      {canUse ? (
        <div className="alert info small">
          <Icon name="book" />
          <div className="grow">
            Dal nome sembra una confezione da <strong>{sz.qty.replace('.', ',')} {sz.unit}</strong>.
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              set({ packageContent: sz.qty, packageUnit: sz.unit, unitWeightKg: null })
              onUsage(dim(sz.unit) === 'volume' ? 'ml' : 'g')
            }}
          >
            Usa {sz.qty.replace('.', ',')} {sz.unit}
          </button>
        </div>
      ) : null}
      {counted ? (
        <div className="grid-3">
          <Field
            label="Quanto pesa o contiene un pezzo?"
            htmlFor="ing-piece"
            required
            error={errors.unitWeightKg}
            hint={Number(v.packageContent) === 1 ? 'es. bottiglietta 250 ml · barattolo 400 g. Se la confezione è un solo pezzo puoi anche scrivere il contenuto qui sopra.' : 'es. bustina 12 g · uovo 60 g · bottiglietta 250 ml'}
          >
            <NumberInput
              id="ing-piece"
              value={shown}
              onChange={(x) => setPiece(x)}
              invalid={!!errors.unitWeightKg}
              suffix={
                <select
                  className="addon"
                  value={pieceUnit}
                  aria-label="Unità del pezzo"
                  onChange={(e) => {
                    const u = e.target.value as 'g' | 'ml'
                    setPieceUnit(u)
                    setPiece(shown, u)
                  }}
                >
                  <option value="g">g</option>
                  <option value="ml">ml</option>
                </select>
              }
            />
          </Field>
          <div className="small muted" style={{ alignSelf: 'center', gridColumn: 'span 2' }}>
            Così nelle ricette potrai usarlo anche a {pieceUnit === 'ml' ? 'ml o litri' : 'grammi'}, non solo a pezzi{pieceUnit === 'ml' && !(Number(v.densityKgPerL) > 0) ? ' (per i liquidi contiamo 1 ml ≈ 1 g; puoi correggere la densità in «Altri dettagli»)' : ''}.
          </div>
        </div>
      ) : null}
    </>
  )
}

export function ingredientPayload(v: IngredientFormValue) {
  const pack = packageOf(v.mode ?? 'conf', v)
  // al pezzo: il peso del pezzo serve anche per dosarlo a pezzi in ricetta
  const pieceKg = v.mode === 'pz' && pack.packageContent ? String(Number(pack.packageContent) * (toBase[pack.packageUnit] ?? 1)) : null
  return {
    code: v.code || null,
    name: v.name,
    category: v.category.trim() || null,
    supplier: v.supplier.trim() || null,
    notes: v.notes || null,
    purchaseUnit: pack.purchaseUnit,
    packageContent: pack.packageContent ?? '',
    packageUnit: pack.packageUnit,
    usageUnit: v.usageUnit,
    edibleYieldPercent: v.edibleYieldPercent ?? '100',
    densityKgPerL: v.densityKgPerL,
    unitWeightKg: v.mode === 'pz' ? pieceKg : v.unitWeightKg,
    nonFood: v.nonFood ?? null,
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
  const cats = useCategorySettings()
  const [price, setPrice] = useState<{ packagePrice: string | null; validFrom: string; source: string; agentName: string }>({ packagePrice: null, validFrom: todayIso(), source: '', agentName: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (p: Partial<IngredientFormValue>) => setV((x) => ({ ...x, ...p }))
  const showPrice = can('costs.read')

  const save = async () => {
    setError('')
    const local = validateIngredient(v, v.nonFood ?? cats.categoryNonFood(v.category))
    if (showPrice && !(Number(price.packagePrice) > 0)) local.packagePrice = 'Inserisci il prezzo (senza IVA).'
    setErrors(local)
    if (Object.keys(local).length) {
      setError('Completa i campi evidenziati.')
      return
    }
    setBusy(true)
    try {
      const body = { ...ingredientPayload(v), ...(showPrice && price.packagePrice !== null ? { initialPrice: { packagePrice: price.packagePrice, validFrom: price.validFrom, source: price.source || null, agentName: price.agentName || null } } : {}) }
      const created = await api.post<{ id: string; code: string; name: string; usageUnit: string; packageUnit: string }>('/ingredients', body)
      await qc.invalidateQueries({ queryKey: ['ingredients'] })
      toast(`Prodotto “${created.name}” creato.`)
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
      title="Nuovo prodotto"
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
        <IngredientFields
          v={v}
          set={set}
          errors={errors}
          isNew
          price={showPrice ? { value: price.packagePrice, onChange: (x) => setPrice((p) => ({ ...p, packagePrice: x })) } : undefined}
          agent={showPrice ? { value: price.agentName, onChange: (x) => setPrice((p) => ({ ...p, agentName: x })) } : undefined}
          moreDetails={
            showPrice ? (
              <div className="grid-3">
                <Field label="Data del prezzo" htmlFor="ing-vf" hint="Di solito la data della fattura">
                  <input id="ing-vf" type="date" className="input" value={price.validFrom} onChange={(e) => setPrice((p) => ({ ...p, validFrom: e.target.value }))} />
                </Field>
                <Field label="Fonte del prezzo" htmlFor="ing-src" hint="es. fattura n. 123, listino">
                  <input id="ing-src" className="input" value={price.source} onChange={(e) => setPrice((p) => ({ ...p, source: e.target.value }))} />
                </Field>
              </div>
            ) : null
          }
        />
        <button type="submit" hidden />
      </form>
    </Drawer>
  )
}
