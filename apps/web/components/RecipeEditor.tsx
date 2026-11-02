'use client'

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, type AffectedRecipe } from '@/lib/api'
import type { RecipeCost } from '@/lib/cost-types'
import { clearLocalDraft, readLocalDraft, useLocalDraft } from '@/lib/hooks'
import { SEGMENT_LABEL } from '@/lib/labels'
import { dateTime, euro, num, unitLabel } from '@/lib/num'
import { useCan } from '@/lib/session'
import { AsyncPicker, type PickerOption } from './AsyncPicker'
import { CostSummary } from './CostSummary'
import { CreateIngredientDrawer, UNITS } from './IngredientForm'
import { errorMessage, Field, Icon, NumberInput, useDebounced, useToast } from './ui'

/* ------------------------------ modello ------------------------------ */
let seq = 0
const key = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`

export interface ComponentRow {
  key: string
  kind: 'ingredient' | 'recipe'
  ingredientId: string | null
  recipeId: string | null
  quantity: string | null
  unit: string
  note: string
  ref: { code?: string | null; name: string; finalUnit?: string | null; hasFinalWeight?: boolean }
}
export interface UseRow {
  key: string
  phaseKey: string | null
  equipmentId: string
  segment: 'preheat' | 'work' | 'hold'
  minutes: string | null
  sharePercent: string | null
  sources: Array<'electric' | 'gas'> | null
  measuredElectricKwh: string | null
  measuredGasQuantity: string | null
  measuredGasUnit: 'kwh' | 'm3' | 'smc' | null
  note: string
  ref: { name: string; powerType: string }
}
export interface LaborRow {
  key: string
  phaseKey: string | null
  employeeId: string
  activeMinutes: string | null
  sharePercent: string | null
  note: string
  ref: { name: string; jobTitle?: string | null }
}
export interface PhaseRow {
  key: string
  name: string
  description: string
}
export interface EditorState {
  code: string
  title: string
  category: string
  description: string
  status: 'draft' | 'active'
  instructions: string
  finalQuantity: string | null
  finalUnit: string
  finalWeightKg: string | null
  portions: string | null
  declaredDurationMinutes: string | null
  yieldNotes: string
  phases: PhaseRow[]
  components: ComponentRow[]
  equipmentUses: UseRow[]
  labor: LaborRow[]
}

export const emptyEditor = (): EditorState => ({
  code: '',
  title: '',
  category: '',
  description: '',
  status: 'draft',
  instructions: '',
  finalQuantity: null,
  finalUnit: 'kg',
  finalWeightKg: null,
  portions: null,
  declaredDurationMinutes: null,
  yieldNotes: '',
  phases: [],
  components: [],
  equipmentUses: [],
  labor: [],
})

/** Converte la revisione restituita dall'API nello stato dell'editor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function editorFromRecipe(r: any): EditorState {
  const rev = r.revision ?? {}
  return {
    code: r.code,
    title: r.title,
    category: r.category ?? '',
    description: r.description ?? '',
    status: r.status === 'active' ? 'active' : 'draft',
    instructions: rev.instructions ?? '',
    finalQuantity: rev.finalQuantity ?? null,
    finalUnit: rev.finalUnit ?? 'kg',
    finalWeightKg: rev.finalWeightKg ?? null,
    portions: rev.portions ?? null,
    declaredDurationMinutes: rev.declaredDurationMinutes ?? null,
    yieldNotes: rev.yieldNotes ?? '',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    phases: (rev.phases ?? []).map((p: any) => ({ key: p.key, name: p.name, description: p.description ?? '' })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    components: (rev.components ?? []).map((c: any) => ({ key: key(), kind: c.kind, ingredientId: c.ingredientId, recipeId: c.recipeId, quantity: c.quantity, unit: c.unit, note: c.note ?? '', ref: c.ref })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    equipmentUses: (rev.equipmentUses ?? []).map((u: any) => ({ ...u, key: key(), note: u.note ?? '' })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    labor: (rev.labor ?? []).map((a: any) => ({ ...a, key: key(), note: a.note ?? '' })),
  }
}

function revisionPayload(s: EditorState) {
  const phaseKeys = new Set(s.phases.map((p) => p.key))
  return {
    instructions: s.instructions || null,
    finalQuantity: s.finalQuantity,
    finalUnit: s.finalQuantity ? s.finalUnit : null,
    finalWeightKg: s.finalWeightKg,
    portions: s.portions,
    declaredDurationMinutes: s.declaredDurationMinutes,
    yieldNotes: s.yieldNotes || null,
    phases: s.phases.map((p) => ({ key: p.key, name: p.name || 'Fase', description: p.description || null })),
    components: s.components.map((c) => ({ kind: c.kind, ingredientId: c.ingredientId, recipeId: c.recipeId, quantity: c.quantity, unit: c.unit, note: c.note || null })),
    equipmentUses: s.equipmentUses.map((u) => ({
      phaseKey: u.phaseKey && phaseKeys.has(u.phaseKey) ? u.phaseKey : null,
      equipmentId: u.equipmentId,
      segment: u.segment,
      minutes: u.minutes,
      sharePercent: u.sharePercent ?? '100',
      sources: u.sources,
      measuredElectricKwh: u.measuredElectricKwh,
      measuredGasQuantity: u.measuredGasQuantity,
      measuredGasUnit: u.measuredGasQuantity ? (u.measuredGasUnit ?? 'm3') : null,
      note: u.note || null,
    })),
    labor: s.labor.map((a) => ({ phaseKey: a.phaseKey && phaseKeys.has(a.phaseKey) ? a.phaseKey : null, employeeId: a.employeeId, activeMinutes: a.activeMinutes, sharePercent: a.sharePercent ?? '100', note: a.note || null })),
  }
}

/* ------------------------------ editor ------------------------------ */
export function RecipeEditor({ recipeId, initial, lockVersion }: { recipeId: string | null; initial: EditorState; lockVersion: number | null }) {
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const can = useCan()
  const draftKey = `recipe-draft:${recipeId ?? 'new'}`
  const [s, setS] = useState<EditorState>(initial)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ message: string; path?: string[] } | null>(null)
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({})
  const [restore, setRestore] = useState<{ savedAt: number; value: EditorState } | null>(null)
  const [newIngredient, setNewIngredient] = useState<string | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const lock = useRef(lockVersion)

  const update = (patch: Partial<EditorState> | ((x: EditorState) => EditorState)) => {
    setS((x) => (typeof patch === 'function' ? patch(x) : { ...x, ...patch }))
    setDirty(true)
  }

  // bozza locale: protegge da errori di rete, chiusure e conflitti
  useLocalDraft(draftKey, s, dirty)
  useEffect(() => {
    const d = readLocalDraft<EditorState>(draftKey)
    if (d && JSON.stringify(d.value) !== JSON.stringify(initial)) setRestore(d)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  /* anteprima autorevole dal backend, aggiornata mentre si compila */
  const payload = useMemo(() => revisionPayload(s), [s])
  const debounced = useDebounced(payload, 450)
  const costsVisible = can('costs.read')
  const preview = useQuery({
    queryKey: ['recipe-preview', recipeId, s.title, debounced],
    queryFn: () => api.post<RecipeCost>('/recipes/preview', { recipeId, title: s.title || 'Nuova ricetta', revision: debounced }),
    enabled: costsVisible,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: false,
  })
  const cost = preview.data
  const stale = preview.isFetching || debounced !== payload
  const lineCost = (prefix: string, i: number) => {
    if (!cost) return null
    const id = `${prefix}${i}`
    const l =
      prefix === 'c'
        ? (cost.ingredientLines.find((x) => x.componentId === id) ?? cost.subrecipeLines.find((x) => x.componentId === id))
        : prefix === 'u'
          ? cost.equipmentLines.find((x) => x.useId === id)
          : cost.laborLines.find((x) => x.assignmentId === id)
    return l ? l.cost : null
  }
  const lineIssues = (type: string, i: number) => cost?.issues.filter((x) => x.ref?.type === type && x.ref.id === `${type === 'component' ? 'c' : type === 'equipment_use' ? 'u' : 'l'}${i}` && x.severity === 'error') ?? []

  const save = async () => {
    setSaving(true)
    setError(null)
    setFieldErr({})
    const body = { code: s.code || (recipeId ? undefined : null), title: s.title, category: s.category || null, description: s.description || null, status: s.status, revision: payload }
    try {
      if (recipeId) {
        const r = await api.put<{ lockVersion: number; revisionNumber: number; affectedRecipes: AffectedRecipe[] }>(`/recipes/${recipeId}`, { ...body, code: s.code, lockVersion: lock.current })
        lock.current = r.lockVersion
        clearLocalDraft(draftKey)
        setDirty(false)
        toast(r.affectedRecipes.length ? `Salvata (revisione ${r.revisionNumber}). Aggiornate anche: ${r.affectedRecipes.map((x) => x.title).join(', ')}.` : `Salvata (revisione ${r.revisionNumber}).`)
        await qc.invalidateQueries({ queryKey: ['recipes'] })
        router.push(`/ricette/${recipeId}`)
      } else {
        const r = await api.post<{ id: string }>('/recipes', body)
        clearLocalDraft(draftKey)
        setDirty(false)
        toast('Ricetta creata.')
        await qc.invalidateQueries({ queryKey: ['recipes'] })
        router.replace(`/ricette/${r.id}`)
      }
    } catch (e) {
      const path = e instanceof ApiError ? e.details?.path : undefined
      setError({ message: errorMessage(e), path })
      if (e instanceof ApiError) setFieldErr(e.fields)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } finally {
      setSaving(false)
    }
  }

  /* -------------------------- fonti dei picker -------------------------- */
  const ingredientOptions = async (q: string, signal?: AbortSignal): Promise<PickerOption[]> => {
    const r = await api.get<{ data: Array<{ id: string; code: string; name: string; usageUnit: string; packageUnit: string; price: { unitPrice: string | null; baseUnit: string; status: string } | null }> }>(
      '/ingredients',
      { q, pageSize: 20, sort: 'name' },
      signal,
    )
    return r.data.map((i) => ({
      id: i.id,
      label: i.name,
      sub: i.code,
      right: i.price ? (i.price.status === 'missing' ? 'senza prezzo' : `${euro(i.price.unitPrice, 2)}/${i.price.baseUnit}`) : undefined,
      unit: i.usageUnit,
    }))
  }
  const recipeOptions = async (q: string, signal?: AbortSignal): Promise<PickerOption[]> => {
    const r = await api.get<{ data: Array<{ id: string; code: string; title: string; finalUnit: string | null; finalWeightKg: string | null; finalQuantity: string | null }> }>('/recipes/options', { q, exclude: recipeId ?? undefined }, signal)
    return r.data.map((x) => ({ id: x.id, label: x.title, sub: x.code, right: x.finalWeightKg ? `resa ${num(x.finalWeightKg)} kg` : x.finalQuantity ? `resa ${num(x.finalQuantity)} ${x.finalUnit}` : 'resa non dichiarata', unit: x.finalWeightKg ? 'g' : (x.finalUnit ?? 'g'), finalUnit: x.finalUnit, hasFinalWeight: !!x.finalWeightKg }))
  }
  const equipmentOptions = async (q: string, signal?: AbortSignal): Promise<PickerOption[]> => {
    const r = await api.get<{ data: Array<{ id: string; code: string; name: string; powerType: string }> }>('/equipment', { q, pageSize: 20, sort: 'name' }, signal)
    return r.data.map((x) => ({ id: x.id, label: x.name, sub: x.code, right: x.powerType === 'manual' ? 'manuale' : x.powerType === 'mixed' ? 'misto' : x.powerType === 'gas' ? 'gas' : 'elettrico', powerType: x.powerType }))
  }
  const employeeOptions = async (q: string, signal?: AbortSignal): Promise<PickerOption[]> => {
    const r = await api.get<{ data: Array<{ id: string; code: string; name: string; jobTitle: string | null; hasCost: boolean; status: string }> }>('/employees', { q, pageSize: 20, sort: 'name', status: 'active' }, signal)
    return r.data.map((x) => ({ id: x.id, label: x.name, sub: x.jobTitle ?? x.code, right: x.hasCost ? undefined : 'costo mancante', jobTitle: x.jobTitle }))
  }

  const addIngredient = (o: PickerOption & { unit?: string }) =>
    update((x) => ({ ...x, components: [...x.components, { key: key(), kind: 'ingredient', ingredientId: o.id, recipeId: null, quantity: null, unit: o.unit ?? 'g', note: '', ref: { name: o.label, code: o.sub } }] }))
  const addSubrecipe = (o: PickerOption & { unit?: string; finalUnit?: string | null; hasFinalWeight?: boolean }) =>
    update((x) => ({ ...x, components: [...x.components, { key: key(), kind: 'recipe', ingredientId: null, recipeId: o.id, quantity: null, unit: o.unit ?? 'g', note: '', ref: { name: o.label, code: o.sub, finalUnit: o.finalUnit, hasFinalWeight: o.hasFinalWeight } }] }))
  const setComp = (i: number, p: Partial<ComponentRow>) => update((x) => ({ ...x, components: x.components.map((c, j) => (j === i ? { ...c, ...p } : c)) }))
  const setUse = (i: number, p: Partial<UseRow>) => update((x) => ({ ...x, equipmentUses: x.equipmentUses.map((c, j) => (j === i ? { ...c, ...p } : c)) }))
  const setLab = (i: number, p: Partial<LaborRow>) => update((x) => ({ ...x, labor: x.labor.map((c, j) => (j === i ? { ...c, ...p } : c)) }))
  const move = <T,>(arr: T[], i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= arr.length) return arr
    const c = [...arr]
    ;[c[i], c[j]] = [c[j]!, c[i]!]
    return c
  }
  const phaseSelect = (value: string | null, onChange: (v: string | null) => void) => (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Fase">
      <option value="">Nessuna fase</option>
      {s.phases.map((p) => (
        <option key={p.key} value={p.key}>
          {p.name || 'Fase senza nome'}
        </option>
      ))}
    </select>
  )

  return (
    <div className="editor">
      <div className="stack loose">
        {restore ? (
          <div className="alert info">
            <div className="grow">C’è una bozza non salvata di questa ricetta del {dateTime(new Date(restore.savedAt))}.</div>
            <button
              className="btn sm"
              onClick={() => {
                setS(restore.value)
                setDirty(true)
                setRestore(null)
              }}
            >
              Ripristina
            </button>
            <button
              className="btn sm ghost"
              onClick={() => {
                clearLocalDraft(draftKey)
                setRestore(null)
              }}
            >
              Ignora
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="alert err" role="alert">
            <Icon name="alert" />
            <div>
              {error.message}
              {error.path ? <div className="small">Percorso: {error.path.join(' → ')}</div> : null}
              <div className="small">Le modifiche sono ancora qui e salvate nel browser: correggi e riprova.</div>
            </div>
          </div>
        ) : null}

        {/* -------- dati e resa -------- */}
        <section className="card" id="dati">
          <div className="card-head">
            <h2>Dati e resa</h2>
          </div>
          <div className="card-body stack">
            <div className="grid-3">
              <Field label="Titolo" htmlFor="r-title" required error={fieldErr.title}>
                <input id="r-title" className="input" value={s.title} onChange={(e) => update({ title: e.target.value })} autoFocus={!recipeId} />
              </Field>
              <Field label="Codice" htmlFor="r-code" hint={recipeId ? undefined : 'Vuoto = generato'} error={fieldErr.code}>
                <input id="r-code" className="input mono" value={s.code} onChange={(e) => update({ code: e.target.value })} />
              </Field>
              <Field label="Categoria" htmlFor="r-cat">
                <input id="r-cat" className="input" value={s.category} onChange={(e) => update({ category: e.target.value })} placeholder="es. Primi, Sughi, Dolci" />
              </Field>
            </div>
            <div className="section-title">Resa finale dichiarata</div>
            <p className="small muted">La resa non è la somma degli ingredienti: cottura ed evaporazione la cambiano. Il peso finale netto serve per il costo al kg e per usare la ricetta come semilavorato a peso.</p>
            <div className="grid-4">
              <Field label="Quantità ottenuta" htmlFor="r-fq" error={fieldErr['revision.finalQuantity']}>
                <NumberInput
                  id="r-fq"
                  value={s.finalQuantity}
                  onChange={(x) => update({ finalQuantity: x })}
                  suffix={
                    <select className="addon" value={s.finalUnit} onChange={(e) => update({ finalUnit: e.target.value })} aria-label="Unità resa">
                      {UNITS.map((u) => (
                        <option key={u.value}>{u.value}</option>
                      ))}
                    </select>
                  }
                />
              </Field>
              <Field label="Peso finale netto" htmlFor="r-fw" error={fieldErr['revision.finalWeightKg']}>
                <NumberInput id="r-fw" value={s.finalWeightKg} onChange={(x) => update({ finalWeightKg: x })} suffix="kg" />
              </Field>
              <Field label="Porzioni ottenute" htmlFor="r-por" error={fieldErr['revision.portions']}>
                <NumberInput id="r-por" value={s.portions} onChange={(x) => update({ portions: x })} />
              </Field>
              <Field label="Peso porzione" hint="Calcolato">
                <div className="input" style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-2)' }}>
                  {s.finalWeightKg && s.portions && Number(s.portions) > 0 ? `${num((Number(s.finalWeightKg) / Number(s.portions)) * 1000, 0)} g` : '—'}
                </div>
              </Field>
            </div>
            <div className="grid-2">
              <Field label="Durata complessiva dichiarata" htmlFor="r-dur" hint="Tempo dall’inizio alla fine: non è la somma di tempi macchina e uomo">
                <NumberInput id="r-dur" value={s.declaredDurationMinutes} onChange={(x) => update({ declaredDurationMinutes: x })} suffix="min" />
              </Field>
              <Field label="Note su resa e perdite" htmlFor="r-yn">
                <input id="r-yn" className="input" value={s.yieldNotes} onChange={(e) => update({ yieldNotes: e.target.value })} />
              </Field>
            </div>
          </div>
        </section>

        {/* -------- ingredienti e semilavorati -------- */}
        <section className="card" id="ingredienti">
          <div className="card-head">
            <h2>Ingredienti e semilavorati</h2>
            <span className="faint small">quantità nette utilizzate</span>
          </div>
          <div className="card-body">
            {s.components.length === 0 ? <p className="muted small" style={{ marginBottom: 10 }}>Aggiungi ingredienti dall’anagrafica, creane uno al volo o inserisci un’altra ricetta come semilavorato.</p> : null}
            {s.components.map((c, i) => {
              const issues = lineIssues('component', i)
              return (
                <div key={c.key} className="line-row comp-row">
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      {c.kind === 'recipe' ? <span className="badge accent" title="Semilavorato">Ricetta</span> : null}
                      <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.ref.name}</strong>
                      <span className="faint small mono">{c.ref.code}</span>
                    </div>
                    {issues.map((x, k) => (
                      <div key={k} className="small" style={{ color: 'var(--err)' }}>
                        {x.message}
                      </div>
                    ))}
                  </div>
                  <NumberInput value={c.quantity} onChange={(x) => setComp(i, { quantity: x })} ariaLabel={`Quantità di ${c.ref.name}`} invalid={!c.quantity} placeholder="quantità" />
                  <select className="input" value={c.unit} onChange={(e) => setComp(i, { unit: e.target.value })} aria-label="Unità">
                    {UNITS.map((u) => (
                      <option key={u.value}>{u.value}</option>
                    ))}
                  </select>
                  <span className="num small">{costsVisible ? euro(lineCost('c', i)) : ''}</span>
                  <div className="row" style={{ gap: 0 }}>
                    <button className="btn ghost icon sm" onClick={() => update((x) => ({ ...x, components: x.components.filter((_, j) => j !== i) }))} aria-label={`Rimuovi ${c.ref.name}`}>
                      <Icon name="x" />
                    </button>
                  </div>
                </div>
              )
            })}
            <div className="grid-2" style={{ marginTop: 12 }}>
              <AsyncPicker
                queryKey="ingredients"
                fetchOptions={ingredientOptions}
                value={null}
                onSelect={addIngredient}
                placeholder="+ Aggiungi ingrediente…"
                ariaLabel="Aggiungi ingrediente"
                onCreate={can('ingredients.manage') ? (q) => setNewIngredient(q) : undefined}
                createLabel={(q) => (q ? `Crea nuovo ingrediente “${q}”` : 'Crea nuovo ingrediente')}
              />
              <AsyncPicker queryKey={`recipes-${recipeId}`} fetchOptions={recipeOptions} value={null} onSelect={addSubrecipe} placeholder="+ Aggiungi semilavorato (ricetta)…" ariaLabel="Aggiungi semilavorato" />
            </div>
          </div>
        </section>

        {/* -------- fasi e strumenti -------- */}
        <section className="card" id="fasi">
          <div className="card-head">
            <h2>Fasi e strumenti</h2>
            <button className="btn sm" onClick={() => update((x) => ({ ...x, phases: [...x.phases, { key: key(), name: `Fase ${x.phases.length + 1}`, description: '' }] }))}>
              <Icon name="plus" /> Fase
            </button>
          </div>
          <div className="card-body stack">
            {s.phases.length ? (
              <div className="stack tight">
                {s.phases.map((p, i) => (
                  <div key={p.key} className="row">
                    <span className="badge">{i + 1}</span>
                    <input className="input" style={{ maxWidth: 260 }} value={p.name} onChange={(e) => update((x) => ({ ...x, phases: x.phases.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) }))} aria-label="Nome fase" />
                    <input className="input grow" value={p.description} placeholder="Descrizione (facoltativa)" onChange={(e) => update((x) => ({ ...x, phases: x.phases.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)) }))} aria-label="Descrizione fase" />
                    <button className="btn ghost icon sm" onClick={() => update((x) => ({ ...x, phases: move(x.phases, i, -1) }))} aria-label="Sposta su">
                      <Icon name="up" />
                    </button>
                    <button className="btn ghost icon sm" onClick={() => update((x) => ({ ...x, phases: x.phases.filter((_, j) => j !== i) }))} aria-label="Rimuovi fase">
                      <Icon name="x" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="small muted">Le fasi sono facoltative: servono a organizzare strumenti e manodopera.</p>
            )}
            <div className="section-title">Uso degli strumenti</div>
            <p className="small muted">Preriscaldamento, lavorazione e mantenimento vanno in righe separate, senza sommarli due volte. Se lo strumento è condiviso tra più produzioni, indica la quota imputata a questo lotto.</p>
            {s.equipmentUses.map((u, i) => {
              const issues = lineIssues('equipment_use', i)
              const mixed = u.ref.powerType === 'mixed'
              const hasGas = u.ref.powerType === 'gas' || mixed
              const hasEl = u.ref.powerType === 'electric' || mixed
              return (
                <div key={u.key} className="line-row use-row">
                  <div style={{ minWidth: 0 }}>
                    <strong>{u.ref.name}</strong>
                    <div className="row wrap small" style={{ gap: 6, marginTop: 4 }}>
                      <select className="input" style={{ height: 28, width: 'auto' }} value={u.segment} onChange={(e) => setUse(i, { segment: e.target.value as UseRow['segment'] })} aria-label="Segmento">
                        {Object.entries(SEGMENT_LABEL).map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </select>
                      {s.phases.length ? <div style={{ width: 150 }}>{phaseSelect(u.phaseKey, (v) => setUse(i, { phaseKey: v }))}</div> : null}
                      {mixed ? (
                        <select
                          className="input"
                          style={{ height: 28, width: 'auto' }}
                          value={(u.sources ?? ['electric', 'gas']).join(',')}
                          onChange={(e) => setUse(i, { sources: e.target.value.split(',') as Array<'electric' | 'gas'> })}
                          aria-label="Fonti usate"
                        >
                          <option value="electric,gas">Elettrico + gas</option>
                          <option value="electric">Solo elettrico</option>
                          <option value="gas">Solo gas</option>
                        </select>
                      ) : null}
                    </div>
                    {u.ref.powerType !== 'manual' ? (
                      <details style={{ marginTop: 4 }}>
                        <summary className="small faint">{u.measuredElectricKwh || u.measuredGasQuantity ? 'Consumo misurato inserito' : 'Inserisci un consumo misurato (sostituisce la stima)'}</summary>
                        <div className="row wrap" style={{ marginTop: 6 }}>
                          {hasEl ? (
                            <div style={{ width: 150 }}>
                              <NumberInput value={u.measuredElectricKwh} onChange={(x) => setUse(i, { measuredElectricKwh: x })} suffix="kWh" ariaLabel="kWh misurati" />
                            </div>
                          ) : null}
                          {hasGas ? (
                            <div style={{ width: 170 }}>
                              <NumberInput
                                value={u.measuredGasQuantity}
                                onChange={(x) => setUse(i, { measuredGasQuantity: x })}
                                ariaLabel="Gas misurato"
                                suffix={
                                  <select className="addon" value={u.measuredGasUnit ?? 'm3'} onChange={(e) => setUse(i, { measuredGasUnit: e.target.value as UseRow['measuredGasUnit'] })} aria-label="Unità gas">
                                    {['m3', 'smc', 'kwh'].map((x) => (
                                      <option key={x} value={x}>
                                        {unitLabel(x)}
                                      </option>
                                    ))}
                                  </select>
                                }
                              />
                            </div>
                          ) : null}
                        </div>
                      </details>
                    ) : (
                      <div className="faint small">manuale: nessun consumo</div>
                    )}
                    {issues.map((x, k) => (
                      <div key={k} className="small" style={{ color: 'var(--err)' }}>
                        {x.message}
                      </div>
                    ))}
                  </div>
                  <NumberInput value={u.minutes} onChange={(x) => setUse(i, { minutes: x })} suffix="min" ariaLabel="Minuti d’uso" invalid={!u.minutes} />
                  <NumberInput value={u.sharePercent} onChange={(x) => setUse(i, { sharePercent: x })} suffix="%" ariaLabel="Quota imputata" />
                  <span className="num small">{costsVisible ? euro(lineCost('u', i)) : ''}</span>
                  <span />
                  <button className="btn ghost icon sm" onClick={() => update((x) => ({ ...x, equipmentUses: x.equipmentUses.filter((_, j) => j !== i) }))} aria-label="Rimuovi uso strumento">
                    <Icon name="x" />
                  </button>
                </div>
              )
            })}
            <div style={{ maxWidth: 420 }}>
              <AsyncPicker
                queryKey="equipment"
                fetchOptions={equipmentOptions}
                value={null}
                onSelect={(o: PickerOption & { powerType?: string }) =>
                  update((x) => ({
                    ...x,
                    equipmentUses: [
                      ...x.equipmentUses,
                      { key: key(), phaseKey: x.phases.at(-1)?.key ?? null, equipmentId: o.id, segment: 'work', minutes: null, sharePercent: '100', sources: null, measuredElectricKwh: null, measuredGasQuantity: null, measuredGasUnit: null, note: '', ref: { name: o.label, powerType: o.powerType ?? 'electric' } },
                    ],
                  }))
                }
                placeholder="+ Aggiungi uso di uno strumento…"
                ariaLabel="Aggiungi strumento"
              />
            </div>
          </div>
        </section>

        {/* -------- manodopera -------- */}
        <section className="card" id="manodopera">
          <div className="card-head">
            <h2>Manodopera</h2>
            <span className="faint small">minuti di lavoro attivo, non tempo macchina</span>
          </div>
          <div className="card-body stack">
            <p className="small muted">60 minuti di cottura possono richiedere 10 minuti di lavoro: indica solo il tempo in cui la persona lavora davvero. Più dipendenti possono partecipare alla stessa fase.</p>
            {s.labor.map((a, i) => {
              const issues = lineIssues('labor', i)
              return (
                <div key={a.key} className="line-row lab-row">
                  <div style={{ minWidth: 0 }}>
                    <strong>{a.ref.name}</strong> <span className="faint small">{a.ref.jobTitle ?? ''}</span>
                    {issues.map((x, k) => (
                      <div key={k} className="small" style={{ color: 'var(--err)' }}>
                        {x.message}
                      </div>
                    ))}
                  </div>
                  {s.phases.length ? phaseSelect(a.phaseKey, (v) => setLab(i, { phaseKey: v })) : <span />}
                  <NumberInput value={a.activeMinutes} onChange={(x) => setLab(i, { activeMinutes: x })} suffix="min" ariaLabel="Minuti attivi" invalid={!a.activeMinutes} />
                  <NumberInput value={a.sharePercent} onChange={(x) => setLab(i, { sharePercent: x })} suffix="%" ariaLabel="Quota imputata" />
                  <span className="num small">{costsVisible && can('salaries.read') ? euro(lineCost('l', i)) : ''}</span>
                  <button className="btn ghost icon sm" onClick={() => update((x) => ({ ...x, labor: x.labor.filter((_, j) => j !== i) }))} aria-label="Rimuovi manodopera">
                    <Icon name="x" />
                  </button>
                </div>
              )
            })}
            <div style={{ maxWidth: 420 }}>
              <AsyncPicker
                queryKey="employees"
                fetchOptions={employeeOptions}
                value={null}
                onSelect={(o: PickerOption & { jobTitle?: string | null }) =>
                  update((x) => ({ ...x, labor: [...x.labor, { key: key(), phaseKey: x.phases.at(-1)?.key ?? null, employeeId: o.id, activeMinutes: null, sharePercent: '100', note: '', ref: { name: o.label, jobTitle: o.jobTitle } }] }))
                }
                placeholder="+ Aggiungi dipendente…"
                ariaLabel="Aggiungi dipendente"
              />
            </div>
          </div>
        </section>

        <section className="card" id="istruzioni">
          <div className="card-head">
            <h2>Istruzioni e descrizione</h2>
          </div>
          <div className="card-body stack">
            <Field label="Descrizione" htmlFor="r-desc">
              <textarea id="r-desc" className="input" rows={2} value={s.description} onChange={(e) => update({ description: e.target.value })} />
            </Field>
            <Field label="Istruzioni di preparazione" htmlFor="r-ins">
              <textarea id="r-ins" className="input" rows={6} value={s.instructions} onChange={(e) => update({ instructions: e.target.value })} />
            </Field>
          </div>
        </section>

        <div className="card card-pad row wrap between" style={{ position: 'sticky', bottom: 12, zIndex: 5 }}>
          <label className="row">
            <span className="label">Stato</span>
            <select className="input" style={{ width: 'auto' }} value={s.status} onChange={(e) => update({ status: e.target.value as 'draft' | 'active' })}>
              <option value="draft">Bozza</option>
              <option value="active">Attiva</option>
            </select>
          </label>
          <div className="row">
            {dirty ? <span className="faint small">Modifiche non salvate (copia di sicurezza nel browser)</span> : null}
            <button className="btn" onClick={() => router.back()}>
              Annulla
            </button>
            <button className="btn primary" onClick={save} disabled={saving || !s.title.trim()}>
              {saving ? <span className="spinner" /> : null} {recipeId ? 'Salva nuova revisione' : 'Crea ricetta'}
            </button>
          </div>
        </div>
      </div>

      {/* -------- riepilogo persistente -------- */}
      {costsVisible ? (
        <>
          <aside className="card summary-panel" data-open={summaryOpen} aria-label="Riepilogo costi">
            <div className="card-head">
              <h2>Riepilogo costi</h2>
              <span className="row small faint">
                {stale ? <span className="spinner" aria-label="Aggiornamento" /> : <Icon name="check" size={14} />}
                <button className="btn ghost icon sm summary-close" onClick={() => setSummaryOpen(false)} aria-label="Chiudi riepilogo" style={{ display: summaryOpen ? undefined : 'none' }}>
                  <Icon name="x" />
                </button>
              </span>
            </div>
            <div className="card-body">
              {preview.error ? <div className="alert warn small">{errorMessage(preview.error)}</div> : null}
              {cost ? <CostSummary cost={cost} compact stale={stale} /> : <div className="muted small">Il riepilogo compare mentre compili.</div>}
            </div>
          </aside>
          <button className="btn primary summary-mobile-btn" onClick={() => setSummaryOpen(true)}>
            Riepilogo · {cost ? euro(cost.total) : '—'} {cost && !cost.complete ? '(incompleto)' : ''}
          </button>
        </>
      ) : null}

      {newIngredient !== null ? (
        <CreateIngredientDrawer initialName={newIngredient} onClose={() => setNewIngredient(null)} onCreated={(ing) => addIngredient({ id: ing.id, label: ing.name, sub: ing.code, unit: ing.usageUnit } as PickerOption & { unit: string })} />
      ) : null}
    </div>
  )
}
