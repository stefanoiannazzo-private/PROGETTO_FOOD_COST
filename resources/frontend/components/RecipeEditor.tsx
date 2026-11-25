'use client'

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  /** NUOVO: durata della fase (minuti sull'orologio) e fase di attesa (nessuno lavora) */
  durationMinutes: string | null
  waiting: boolean
}

/** «2 h 30 min» */
export function fmtDuration(min: number | string | null | undefined): string {
  const m = Math.round(Number(min ?? 0))
  if (!m) return '0 min'
  // sempre in ore (es. «30 h 45 min»): i giorni abbreviati si confonderebbero con i grammi
  const h = Math.floor(m / 60)
  const r = m % 60
  return [h ? `${h} h` : '', r ? `${r} min` : ''].filter(Boolean).join(' ')
}

/** Tempo totale calcolato dalle fasi: null se nessuna fase ha una durata. */
export function phaseTotals(phases: Array<{ durationMinutes: string | null; waiting: boolean }>) {
  const withDur = phases.filter((p) => p.durationMinutes && Number(p.durationMinutes) > 0)
  if (!withDur.length) return null
  const total = withDur.reduce((t, p) => t + Number(p.durationMinutes), 0)
  const waiting = withDur.filter((p) => p.waiting).reduce((t, p) => t + Number(p.durationMinutes), 0)
  return { total, waiting, work: total - waiting }
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
    phases: (rev.phases ?? []).map((p: any) => ({ key: p.key, name: p.name, description: p.description ?? '', durationMinutes: p.durationMinutes ?? null, waiting: !!p.waiting })),
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
  const totals = phaseTotals(s.phases)
  return {
    instructions: s.instructions || null,
    finalQuantity: s.finalQuantity,
    finalUnit: s.finalQuantity ? s.finalUnit : null,
    finalWeightKg: s.finalWeightKg,
    portions: s.portions,
    // NUOVO: con le durate delle fasi il tempo complessivo è la loro somma
    declaredDurationMinutes: totals ? String(totals.total) : s.declaredDurationMinutes,
    yieldNotes: s.yieldNotes || null,
    phases: s.phases.map((p) => ({ key: p.key, name: p.name || 'Fase', description: p.description || null, durationMinutes: p.durationMinutes, waiting: p.waiting })),
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
const fmtKg = (kg: string | number) => (Number(kg) < 1 ? `${num(Number(kg) * 1000, 0)} g` : `${num(kg, 3)} kg`)

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
  // NUOVO: su smartphone l'editor usa la striscia «costo + salva» sopra la barra in basso (soluzione B)
  useEffect(() => {
    document.body.classList.add('edit-strip')
    return () => document.body.classList.remove('edit-strip')
  }, [])
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
  // NUOVO: peso effettivo (dopo cottura se indicato, altrimenti somma degli ingredienti)
  const effWeight = s.finalWeightKg || (cost?.ingredientsWeightKg && !cost.ingredientsWeightMissing?.length ? cost.ingredientsWeightKg : null)
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
    return r.data.map((x) => ({ id: x.id, label: x.title, sub: x.code, right: x.finalWeightKg ? `resa ${num(x.finalWeightKg)} kg` : x.finalQuantity ? `resa ${num(x.finalQuantity)} ${x.finalUnit}` : 'peso dagli ingredienti', unit: x.finalWeightKg ? 'g' : (x.finalUnit ?? 'g'), finalUnit: x.finalUnit, hasFinalWeight: !!x.finalWeightKg }))
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
  const totalsNow = phaseTotals(s.phases)
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

  /* ---------------------- NUOVO: fasi, strumenti e persone ---------------------- */
  const addPhase = (waiting: boolean) =>
    update((x) => ({ ...x, phases: [...x.phases, { key: key(), name: waiting ? 'Attesa' : `Fase ${x.phases.length + 1}`, description: '', durationMinutes: null, waiting }] }))
  const addUse = (o: PickerOption & { powerType?: string }, p: PhaseRow | null) =>
    update((x) => ({
      ...x,
      equipmentUses: [
        ...x.equipmentUses,
        {
          key: key(),
          phaseKey: p?.key ?? null,
          equipmentId: o.id,
          // in una fase di attesa lo strumento (es. frigorifero) tiene la temperatura per tutta la durata, per la quota di spazio occupato
          segment: p?.waiting ? 'hold' : 'work',
          minutes: p?.waiting ? p.durationMinutes : null,
          sharePercent: p?.waiting ? '10' : '100',
          sources: null,
          measuredElectricKwh: null,
          measuredGasQuantity: null,
          measuredGasUnit: null,
          note: '',
          ref: { name: o.label, powerType: o.powerType ?? 'electric' },
        },
      ],
    }))
  const addLabor = (o: PickerOption & { jobTitle?: string | null }, phaseKey: string | null) =>
    update((x) => ({ ...x, labor: [...x.labor, { key: key(), phaseKey, employeeId: o.id, activeMinutes: null, sharePercent: '100', note: '', ref: { name: o.label, jobTitle: o.jobTitle } }] }))
  const phaseKeySet = new Set(s.phases.map((p) => p.key))
  const unphasedUses = s.equipmentUses.map((u, i) => ({ u, i })).filter((x) => !x.u.phaseKey || !phaseKeySet.has(x.u.phaseKey))
  const unphasedLabor = s.labor.map((a, i) => ({ a, i })).filter((x) => !x.a.phaseKey || !phaseKeySet.has(x.a.phaseKey))
  const phaseSubtotal = (pk: string) => {
    if (!cost) return null
    let energy = 0
    let labor = 0
    s.equipmentUses.forEach((u, i) => {
      if (u.phaseKey === pk) energy += Number(lineCost('u', i) ?? 0)
    })
    s.labor.forEach((a, i) => {
      if (a.phaseKey === pk) labor += Number(lineCost('l', i) ?? 0)
    })
    return { energy, labor }
  }
  const phaseOf = (pk: string | null) => s.phases.find((p) => p.key === pk) ?? null

  const useRow = (u: UseRow, i: number, withPhase: boolean) => {
    const issues = lineIssues('equipment_use', i)
    const mixed = u.ref.powerType === 'mixed'
    const hasGas = u.ref.powerType === 'gas' || mixed
    const hasEl = u.ref.powerType === 'electric' || mixed
    const inWaiting = !!phaseOf(u.phaseKey)?.waiting
    return (
      <div key={u.key} className="line-row use-row">
        <div style={{ minWidth: 0 }}>
          <span className="faint small">🔧 </span>
          <strong>{u.ref.name}</strong>
          <div className="row wrap small" style={{ gap: 6, marginTop: 4 }}>
            <select className="input" style={{ height: 28, width: 'auto' }} value={u.segment} onChange={(e) => setUse(i, { segment: e.target.value as UseRow['segment'] })} aria-label="Segmento">
              {Object.entries(SEGMENT_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            {withPhase && s.phases.length ? <div style={{ width: 150 }}>{phaseSelect(u.phaseKey, (v) => setUse(i, { phaseKey: v }))}</div> : null}
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
          {inWaiting ? <div className="faint small" style={{ marginTop: 2 }}>Quota = parte dello spazio occupata da questa produzione (es. 10% del frigorifero)</div> : null}
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
        <NumberInput value={u.sharePercent} onChange={(x) => setUse(i, { sharePercent: x })} suffix="%" ariaLabel={inWaiting ? 'Quota di spazio occupato' : 'Quota imputata'} />
        <span className="num small">{costsVisible ? euro(lineCost('u', i)) : ''}</span>
        <span />
        <button className="btn ghost icon sm" onClick={() => update((x) => ({ ...x, equipmentUses: x.equipmentUses.filter((_, j) => j !== i) }))} aria-label="Rimuovi uso strumento">
          <Icon name="x" />
        </button>
      </div>
    )
  }
  const laborRow = (a: LaborRow, i: number, withPhase: boolean) => {
    const issues = lineIssues('labor', i)
    return (
      <div key={a.key} className="line-row lab-row">
        <div style={{ minWidth: 0 }}>
          <span className="faint small">👤 </span>
          <strong>{a.ref.name}</strong> <span className="faint small">{a.ref.jobTitle ?? ''}</span>
          {issues.map((x, k) => (
            <div key={k} className="small" style={{ color: 'var(--err)' }}>
              {x.message}
            </div>
          ))}
        </div>
        {withPhase && s.phases.length ? phaseSelect(a.phaseKey, (v) => setLab(i, { phaseKey: v })) : <span className="faint small">minuti di lavoro attivo</span>}
        <NumberInput value={a.activeMinutes} onChange={(x) => setLab(i, { activeMinutes: x })} suffix="min" ariaLabel="Minuti attivi" invalid={!a.activeMinutes} />
        <NumberInput value={a.sharePercent} onChange={(x) => setLab(i, { sharePercent: x })} suffix="%" ariaLabel="Quota imputata" />
        <span className="num small">{costsVisible && can('salaries.read') ? euro(lineCost('l', i)) : ''}</span>
        <button className="btn ghost icon sm" onClick={() => update((x) => ({ ...x, labor: x.labor.filter((_, j) => j !== i) }))} aria-label="Rimuovi manodopera">
          <Icon name="x" />
        </button>
      </div>
    )
  }

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
            <h2>Dati della ricetta</h2>
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
            {/* su smartphone lo stato si sceglie qui (la barra di salvataggio in fondo è sostituita dalla striscia) */}
            <div className="field strip-only">
              <span className="label">Stato</span>
              <div className="seg" role="radiogroup" aria-label="Stato della ricetta">
                {(['draft', 'active'] as const).map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={s.status === v} aria-pressed={s.status === v} onClick={() => update({ status: v })}>
                    {v === 'draft' ? 'Bozza' : 'Attiva'}
                  </button>
                ))}
              </div>
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


        {/* -------- NUOVO: peso, resa e porzioni (sotto gli ingredienti: il peso totale si calcola da solo) -------- */}
        <section className="card" id="resa">
          <div className="card-head">
            <h2>Peso, resa e porzioni</h2>
          </div>
          <div className="card-body stack">
            <div className="weight-total">
              <div>
                <span className="faint small">Peso totale degli ingredienti</span>
                <strong>{s.components.length === 0 ? '—' : cost?.ingredientsWeightKg && !cost.ingredientsWeightMissing?.length ? fmtKg(cost.ingredientsWeightKg) : cost?.ingredientsWeightMissing?.length ? 'incompleto' : '…'}</strong>
              </div>
              <span className="small muted">
                {s.components.length === 0
                  ? 'Si calcola da solo man mano che aggiungi ingredienti e semilavorati.'
                  : cost?.ingredientsWeightMissing?.length
                    ? `Manca il peso di ${cost.ingredientsWeightMissing.slice(0, 4).join(', ')}: indica il peso al pezzo (o la densità) nella scheda del prodotto, oppure scrivi qui sotto il peso finale.`
                    : 'Somma delle quantità nette di ingredienti e semilavorati, calcolata in automatico.'}
              </span>
            </div>
            <div className="grid-4">
              <Field
                label="Peso finale dopo la cottura"
                htmlFor="r-fw"
                error={fieldErr['revision.finalWeightKg']}
                hint={cost?.ingredientsWeightKg && !cost.ingredientsWeightMissing?.length ? `Facoltativo: se vuoto vale il peso degli ingredienti (${fmtKg(cost.ingredientsWeightKg)})` : 'Facoltativo se il peso degli ingredienti è completo'}
              >
                <NumberInput id="r-fw" value={s.finalWeightKg} onChange={(x) => update({ finalWeightKg: x })} suffix="kg" placeholder={cost?.ingredientsWeightKg && !cost.ingredientsWeightMissing?.length ? num(cost.ingredientsWeightKg) : undefined} />
              </Field>
              <Field label="Porzioni ottenute" htmlFor="r-por" error={fieldErr['revision.portions']}>
                <NumberInput id="r-por" value={s.portions} onChange={(x) => update({ portions: x })} />
              </Field>
              <Field label="Peso porzione" hint="Calcolato">
                <div className="input" style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-2)' }}>
                  {effWeight && s.portions && Number(s.portions) > 0 ? `${num((Number(effWeight) / Number(s.portions)) * 1000, 0)} g` : '—'}
                </div>
              </Field>
              <Field label="Quantità ottenuta" htmlFor="r-fq" error={fieldErr['revision.finalQuantity']} hint="Facoltativa, es. 30 pz, 2 teglie">
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
            </div>
            <div className="grid-2">
              {totalsNow ? (
                <Field label="Tempo totale di preparazione" hint="Calcolato dalle durate delle fasi qui sotto">
                  <div className="input" style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-2)', height: 'auto', minHeight: 34, padding: '6px 10px' }}>
                    <span>
                      <strong>{fmtDuration(totalsNow.total)}</strong>
                      {totalsNow.waiting ? <span className="faint small"> · di cui {fmtDuration(totalsNow.waiting)} di attesa</span> : null}
                    </span>
                  </div>
                </Field>
              ) : (
                <Field label="Durata complessiva" htmlFor="r-dur" hint="Tempo dall’inizio alla fine. Se indichi la durata delle fasi, si calcola da sola">
                  <NumberInput id="r-dur" value={s.declaredDurationMinutes} onChange={(x) => update({ declaredDurationMinutes: x })} suffix="min" />
                </Field>
              )}
              <Field label="Note su resa e perdite" htmlFor="r-yn">
                <input id="r-yn" className="input" value={s.yieldNotes} onChange={(e) => update({ yieldNotes: e.target.value })} placeholder="es. il ragù cala del 30% in cottura" />
              </Field>
            </div>
            {s.finalWeightKg && cost?.ingredientsWeightKg && !cost.ingredientsWeightMissing?.length && Number(cost.ingredientsWeightKg) > 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                Calo in cottura: {num(((Number(cost.ingredientsWeightKg) - Number(s.finalWeightKg)) / Number(cost.ingredientsWeightKg)) * 100, 1)}% ({fmtKg(cost.ingredientsWeightKg)} → {fmtKg(s.finalWeightKg)})
              </p>
            ) : null}
          </div>
        </section>

        {/* -------- NUOVO: fasi di lavorazione (strumenti e persone dentro ogni fase) -------- */}
        <section className="card" id="fasi">
          <div className="card-head">
            <h2>Fasi di lavorazione</h2>
            <button className="btn sm" onClick={() => addPhase(false)}>
              <Icon name="plus" /> Fase
            </button>
          </div>
          <div className="card-body stack">
            <p className="small muted">
              Dividi la ricetta in fasi, ognuna con la sua <strong>durata</strong>. Dentro ogni fase aggiungi gli <strong>strumenti</strong> usati e le <strong>persone</strong> che ci lavorano (solo i minuti di lavoro attivo). Le fasi di{' '}
              <strong>attesa</strong> (lievitazione, maturazione, riposo, raffreddamento) contano solo nel tempo di preparazione.
            </p>
            {s.phases.map((p, pi) => (
              <PhaseCard
                key={p.key}
                index={pi}
                phase={p}
                uses={s.equipmentUses.map((u, i) => ({ u, i })).filter((x) => x.u.phaseKey === p.key)}
                labor={s.labor.map((a, i) => ({ a, i })).filter((x) => x.a.phaseKey === p.key)}
                onPhase={(patch) =>
                  update((x) => {
                    const old = x.phases[pi]!
                    const next = { ...old, ...patch }
                    // in attesa gli strumenti seguono la durata della fase (es. frigorifero per tutta la maturazione)
                    const follow = next.waiting && patch.durationMinutes !== undefined
                    return {
                      ...x,
                      phases: x.phases.map((y, j) => (j === pi ? next : y)),
                      equipmentUses: follow ? x.equipmentUses.map((u) => (u.phaseKey === p.key && (!u.minutes || u.minutes === old.durationMinutes) ? { ...u, minutes: next.durationMinutes } : u)) : x.equipmentUses,
                    }
                  })
                }
                onMoveUp={() => update((x) => ({ ...x, phases: move(x.phases, pi, -1) }))}
                onRemove={() => {
                  const busy = s.equipmentUses.some((u) => u.phaseKey === p.key) || s.labor.some((a) => a.phaseKey === p.key)
                  if (busy && !window.confirm(`Eliminare la fase «${p.name}»? Strumenti e persone della fase restano tra le righe senza fase.`)) return
                  update((x) => ({
                    ...x,
                    phases: x.phases.filter((_, j) => j !== pi),
                    equipmentUses: x.equipmentUses.map((u) => (u.phaseKey === p.key ? { ...u, phaseKey: null } : u)),
                    labor: x.labor.map((a) => (a.phaseKey === p.key ? { ...a, phaseKey: null } : a)),
                  }))
                }}
                renderUse={(u, i) => useRow(u, i, false)}
                renderLabor={(a, i) => laborRow(a, i, false)}
                addUse={(o) => addUse(o, p)}
                addLabor={(o) => addLabor(o, p.key)}
                equipmentOptions={equipmentOptions}
                employeeOptions={employeeOptions}
                subtotal={costsVisible ? phaseSubtotal(p.key) : null}
                salariesVisible={can('salaries.read')}
              />
            ))}
            {s.phases.length === 0 ? (
              <div className="row wrap" style={{ gap: 8 }}>
                <button className="btn" onClick={() => addPhase(false)}>
                  <Icon name="plus" /> Aggiungi una fase di lavoro
                </button>
                <button className="btn" onClick={() => addPhase(true)}>
                  <Icon name="plus" /> Aggiungi una fase di attesa
                </button>
              </div>
            ) : (
              <div className="row wrap" style={{ gap: 8 }}>
                <button className="btn sm" onClick={() => addPhase(false)}>
                  <Icon name="plus" /> Fase di lavoro
                </button>
                <button className="btn sm" onClick={() => addPhase(true)}>
                  <Icon name="plus" /> Fase di attesa
                </button>
              </div>
            )}
            {/* righe senza fase: ricette senza fasi o righe di fasi eliminate */}
            {unphasedUses.length || unphasedLabor.length || s.phases.length === 0 ? (
              <div className="phase-card">
                <div className="phase-head">
                  <strong>{s.phases.length ? 'Senza fase' : 'Strumenti e persone'}</strong>
                  <span className="faint small">{s.phases.length ? 'scegli la fase dalla tendina di ogni riga' : 'puoi anche non usare le fasi'}</span>
                </div>
                <div className="stack tight">
                  {unphasedUses.map(({ u, i }) => useRow(u, i, true))}
                  {unphasedLabor.map(({ a, i }) => laborRow(a, i, true))}
                  {s.phases.length === 0 ? (
                    <div className="grid-2">
                      <AsyncPicker queryKey="equipment" fetchOptions={equipmentOptions} value={null} onSelect={(o: PickerOption & { powerType?: string }) => addUse(o, null)} placeholder="+ Strumento…" ariaLabel="Aggiungi strumento" />
                      <AsyncPicker queryKey="employees" fetchOptions={employeeOptions} value={null} onSelect={(o: PickerOption & { jobTitle?: string | null }) => addLabor(o, null)} placeholder="+ Persona…" ariaLabel="Aggiungi dipendente" />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
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

        <div className="card card-pad row wrap between save-bar">
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

      {/* NUOVO — smartphone: «Annulla» in alto a sinistra e un'unica striscia costo + salva sopra la barra in basso */}
      <button type="button" className="edit-cancel" onClick={() => router.back()}>
        ‹ Annulla
      </button>
      <div className="edit-strip-bar">
        {costsVisible ? (
          <button type="button" className="es-cost" onClick={() => setSummaryOpen(true)} aria-label="Apri il riepilogo dei costi">
            <small>
              {cost && !cost.complete ? 'Costo incompleto' : 'Costo ricetta'} ▴ riepilogo
            </small>
            <b>{cost ? euro(cost.total) : '—'}</b>
          </button>
        ) : (
          <span className="es-cost">
            <small>{dirty ? 'Modifiche non salvate' : recipeId ? 'Nessuna modifica' : 'Nuova ricetta'}</small>
          </span>
        )}
        <button className="btn primary" onClick={save} disabled={saving || !s.title.trim()}>
          {saving ? <span className="spinner" /> : null} {recipeId ? 'Salva' : 'Crea ricetta'}
        </button>
      </div>

      {newIngredient !== null ? (
        <CreateIngredientDrawer initialName={newIngredient} onClose={() => setNewIngredient(null)} onCreated={(ing) => addIngredient({ id: ing.id, label: ing.name, sub: ing.code, unit: ing.usageUnit } as PickerOption & { unit: string })} />
      ) : null}
    </div>
  )
}

/** NUOVO — durata in minuti con unità a scelta (min / h). */
function DurationInput({ value, onChange, id }: { value: string | null; onChange: (minutes: string | null) => void; id?: string }) {
  const [unit, setUnit] = useState<'min' | 'h'>(value && Number(value) >= 120 && Number(value) % 30 === 0 ? 'h' : 'min')
  const shown = value === null || value === '' ? null : unit === 'h' ? String(Number(value) / 60) : value
  return (
    <NumberInput
      id={id}
      value={shown}
      onChange={(x) => onChange(x === null || x === '' ? null : unit === 'h' ? String(Math.round(Number(x) * 60 * 100) / 100) : x)}
      ariaLabel="Durata della fase"
      suffix={
        <select className="addon" value={unit} onChange={(e) => setUnit(e.target.value as 'min' | 'h')} aria-label="Unità della durata">
          <option value="min">min</option>
          <option value="h">ore</option>
        </select>
      }
    />
  )
}

/** NUOVO — una fase: nome, durata, attesa; dentro, strumenti e persone con il subtotale. */
function PhaseCard({
  index,
  phase,
  uses,
  labor,
  onPhase,
  onMoveUp,
  onRemove,
  renderUse,
  renderLabor,
  addUse,
  addLabor,
  equipmentOptions,
  employeeOptions,
  subtotal,
  salariesVisible,
}: {
  index: number
  phase: PhaseRow
  uses: Array<{ u: UseRow; i: number }>
  labor: Array<{ a: LaborRow; i: number }>
  onPhase: (p: Partial<PhaseRow>) => void
  onMoveUp: () => void
  onRemove: () => void
  renderUse: (u: UseRow, i: number) => ReactNode
  renderLabor: (a: LaborRow, i: number) => ReactNode
  addUse: (o: PickerOption & { powerType?: string }) => void
  addLabor: (o: PickerOption & { jobTitle?: string | null }) => void
  equipmentOptions: (q: string, signal?: AbortSignal) => Promise<PickerOption[]>
  employeeOptions: (q: string, signal?: AbortSignal) => Promise<PickerOption[]>
  subtotal: { energy: number; labor: number } | null
  salariesVisible: boolean
}) {
  return (
    <div className={`phase-card${phase.waiting ? ' waiting' : ''}`}>
      <div className="phase-head">
        <span className="badge">{index + 1}</span>
        <input className="input" style={{ maxWidth: 240 }} value={phase.name} onChange={(e) => onPhase({ name: e.target.value })} aria-label="Nome fase" placeholder={phase.waiting ? 'es. Lievitazione' : 'es. Impasto'} />
        <div style={{ width: 150 }}>
          <DurationInput value={phase.durationMinutes} onChange={(x) => onPhase({ durationMinutes: x })} />
        </div>
        <label className="checkbox" title="Nessuno lavora: la fase conta solo nel tempo di preparazione">
          <input type="checkbox" checked={phase.waiting} onChange={(e) => onPhase({ waiting: e.target.checked })} /> ⏸ Attesa
        </label>
        <span className="grow" />
        <button className="btn ghost icon sm" onClick={onMoveUp} aria-label="Sposta su" disabled={index === 0}>
          <Icon name="up" />
        </button>
        <button className="btn ghost icon sm" onClick={onRemove} aria-label="Rimuovi fase">
          <Icon name="x" />
        </button>
      </div>
      <input className="input small" value={phase.description} placeholder="Descrizione (facoltativa)" onChange={(e) => onPhase({ description: e.target.value })} aria-label="Descrizione fase" />
      {phase.waiting ? (
        <div className="faint small">
          ⏸ Fase di attesa{phase.durationMinutes ? ` di ${fmtDuration(phase.durationMinutes)}` : ''}: nessuno lavora, conta solo nel tempo di preparazione. Se avviene in frigorifero o in cella puoi aggiungerlo con la quota di spazio occupato.
        </div>
      ) : null}
      <div className="stack tight">
        {uses.map(({ u, i }) => renderUse(u, i))}
        {labor.map(({ a, i }) => renderLabor(a, i))}
      </div>
      <div className="grid-2">
        <AsyncPicker queryKey="equipment" fetchOptions={equipmentOptions} value={null} onSelect={addUse} placeholder={phase.waiting ? '+ Frigorifero o cella (facoltativo)…' : '+ Strumento usato in questa fase…'} ariaLabel="Aggiungi strumento alla fase" />
        {!phase.waiting ? <AsyncPicker queryKey="employees" fetchOptions={employeeOptions} value={null} onSelect={addLabor} placeholder="+ Persona che lavora in questa fase…" ariaLabel="Aggiungi dipendente alla fase" /> : <span />}
      </div>
      {subtotal && (uses.length || labor.length) ? (
        <div className="small faint" style={{ textAlign: 'right' }}>
          Subtotale fase: energia <strong>{euro(String(subtotal.energy))}</strong>
          {labor.length && salariesVisible ? (
            <>
              {' '}
              · manodopera <strong>{euro(String(subtotal.labor))}</strong>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
