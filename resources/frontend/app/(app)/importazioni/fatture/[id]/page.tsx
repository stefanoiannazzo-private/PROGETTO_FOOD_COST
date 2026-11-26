'use client'

/**
 * NUOVO — Fattura elettronica di un fornitore: per ogni riga il ristoratore decide se è un prodotto nuovo
 * (nome, categoria e "come lo paghi" obbligatori), un prodotto già presente o da ignorare.
 * Le scelte vengono ricordate per le fatture successive dello stesso fornitore.
 */
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AffectedRecipe } from '@/lib/api'
import { date, euro, num } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { AffectedNotice, Confirm, ErrorBox, errorMessage, Field, fieldErrors, Icon, NumberInput, Skeleton, useToast } from '@/components/ui'

type Mode = 'kg' | 'l' | 'conf'
type Action = 'new' | 'existing' | 'ignore'

interface Line {
  n: number
  code: string | null
  description: string
  quantity: string | null
  um: string | null
  netUnitPrice: string | null
  total: string | null
  vat: string | null
  kind: string | null
  skip: boolean
  mode: Mode
  packageContent: string | null
  packageUnit: string | null
  suggestedName: string
  suggestion: { action: 'existing' | 'ignore'; ingredientId?: string; mode?: Mode | null; packageContent?: string | null; packageUnit?: string | null; purchaseUnit?: string | null; remembered: boolean } | null
}

interface Product {
  id: string
  code: string
  name: string
  category: string | null
  supplier: string | null
  purchaseUnit: string
  packageContent: string
  packageUnit: string
}

interface Invoice {
  id: string
  status: 'draft' | 'applied'
  supplier: string
  supplierVat: string
  docType: string | null
  number: string
  date: string | null
  total: string | null
  fileName: string
  summary: Summary | null
  lines: Line[]
  products: Product[]
  categories: string[]
  nextDraft: string | null
}

interface Summary {
  created: number
  prices: number
  ignored: number
  skipped: number
  skippedLines?: string[]
}

interface Choice {
  action: Action
  ingredientId: string
  name: string
  category: string
  mode: Mode | null
  packageContent: string | null
  packageUnit: string
  purchaseUnit: string
  /** NUOVO: confezione a pezzi → quanto pesa o contiene un pezzo */
  pieceSize: string | null
  pieceUnit: 'g' | 'ml'
  remember: boolean
}

const MODES: Array<{ value: Mode; title: string; ex: string }> = [
  { value: 'kg', title: 'Al kg', ex: 'in fattura: KG' },
  { value: 'l', title: 'Al litro', ex: 'in fattura: LT' },
  { value: 'conf', title: 'A confezione', ex: 'in fattura: N, NR, PZ, CT, CF' },
]

const UNITS = [
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
  { value: 'ml', label: 'ml' },
  { value: 'cl', label: 'cl' },
  { value: 'l', label: 'l' },
  { value: 'pz', label: 'pz' },
]

const toBase: Record<string, number> = { g: 0.001, kg: 1, ml: 0.001, cl: 0.01, l: 1, pz: 1 }
const baseOf = (u: string) => (['ml', 'cl', 'l'].includes(u) ? 'l' : u === 'pz' ? 'pezzo' : 'kg')

function initialChoice(l: Line): Choice {
  const s = l.suggestion
  return {
    action: s ? s.action : 'new',
    ingredientId: s?.ingredientId ?? '',
    name: l.suggestedName,
    category: '',
    mode: (s?.mode as Mode | undefined) ?? l.mode,
    packageContent: s?.mode ? (s.packageContent ?? null) : l.packageContent,
    packageUnit: (s?.mode ? s.packageUnit : l.packageUnit) ?? 'g',
    purchaseUnit: s?.purchaseUnit && !['kg', 'litro'].includes(s.purchaseUnit) ? s.purchaseUnit : 'confezione',
    pieceSize: null,
    pieceUnit: 'g',
    remember: true,
  }
}

function pricePreview(l: Line, c: Choice): string | null {
  if (!l.netUnitPrice || !c.mode) return null
  const p = Number(l.netUnitPrice)
  if (c.mode === 'kg') return `${euro(p, 2)} al kg`
  if (c.mode === 'l') return `${euro(p, 2)} al litro`
  const q = Number(c.packageContent) * (toBase[c.packageUnit] ?? 1)
  if (!(q > 0)) return `${euro(p, 2)} a confezione`
  return `${euro(p, 2)} a confezione = ${euro(p / q, 2)} al ${baseOf(c.packageUnit)}`
}

export default function SupplierInvoicePage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['supplier-invoice', id], queryFn: () => api.get<Invoice>(`/supplier-invoices/${id}`) })
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<(Summary & { affectedRecipes: AffectedRecipe[] }) | null>(null)
  const [discard, setDiscard] = useState(false)

  useEffect(() => {
    if (!q.data) return
    setChoices(Object.fromEntries(q.data.lines.map((l) => [l.n, initialChoice(l)])))
    setErrors({})
    setDone(null)
    setError('')
  }, [q.data])

  const productsById = useMemo(() => new Map((q.data?.products ?? []).map((p) => [p.id, p])), [q.data])
  const grouped = useMemo(() => {
    const g = new Map<string, Product[]>()
    for (const p of q.data?.products ?? []) {
      const k = p.category || 'Senza categoria'
      g.set(k, [...(g.get(k) ?? []), p])
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b, 'it'))
  }, [q.data])

  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data) return <Skeleton rows={8} />
  const inv = q.data
  const draft = inv.status === 'draft' && !done
  const set = (n: number, patch: Partial<Choice>) => setChoices((c) => ({ ...c, [n]: { ...c[n]!, ...patch } }))
  const counts = Object.values(choices).reduce((a, c) => ({ ...a, [c.action]: (a[c.action] ?? 0) + 1 }), {} as Record<string, number>)

  const confirm = async () => {
    setBusy(true)
    setError('')
    setErrors({})
    try {
      const lines = inv.lines.map((l) => {
        const c = choices[l.n]!
        return {
          n: l.n,
          action: c.action,
          ingredientId: c.action === 'existing' ? c.ingredientId || null : null,
          name: c.name,
          category: c.category,
          mode: c.action === 'ignore' ? null : c.mode,
          packageContent: c.mode === 'conf' ? c.packageContent : null,
          packageUnit: c.mode === 'conf' ? c.packageUnit : null,
          purchaseUnit: c.mode === 'conf' ? c.purchaseUnit : null,
          pieceSize: c.action === 'new' && c.mode === 'conf' && c.packageUnit === 'pz' ? c.pieceSize : null,
          pieceUnit: c.pieceUnit,
          remember: c.remember,
        }
      })
      const r = await api.post<Summary & { affectedRecipes: AffectedRecipe[] }>(`/supplier-invoices/${id}/confirm`, { lines })
      setDone(r)
      qc.invalidateQueries({ queryKey: ['supplier-invoices'] })
      qc.invalidateQueries({ queryKey: ['ingredients'] })
      toast(`Fattura importata: ${r.prices} prezzi registrati`)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (e) {
      setErrors(fieldErrors(e))
      setError(errorMessage(e))
      const first = Object.keys(fieldErrors(e))[0]?.match(/^line(\d+)/)?.[1]
      if (first) document.getElementById(`riga-${first}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } finally {
      setBusy(false)
    }
  }

  const summary = done ?? inv.summary

  return (
    <>
      <PageHead
        title={inv.supplier}
        sub={
          <>
            Fattura {inv.number}
            {inv.date ? ` del ${date(inv.date)}` : ''}
            {inv.total ? ` · totale ${euro(inv.total)}` : ''} · {inv.lines.length} righe
          </>
        }
        actions={
          <>
            <Link className="btn" href="/importazioni">
              ← Importazioni
            </Link>
            <a className="btn" href={`/api/supplier-invoices/${id}/file`}>
              <Icon name="download" /> XML
            </a>
          </>
        }
      />

      {summary ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body stack">
            <div className="alert ok">
              <Icon name="check" />
              <div>
                <strong>Fattura importata.</strong> {summary.created} prodotti nuovi · {summary.prices} prezzi registrati alla data della fattura · {summary.ignored} righe ignorate
                {summary.skipped ? ` · ${summary.skipped} già presenti in quella data (non modificati)` : ''}.
              </div>
            </div>
            {done ? <AffectedNotice recipes={done.affectedRecipes} /> : null}
            <div className="row wrap">
              {inv.nextDraft ? (
                <button className="btn primary" onClick={() => router.push(`/importazioni/fatture/${inv.nextDraft}`)}>
                  Prossima fattura da abbinare →
                </button>
              ) : null}
              <Link className="btn" href="/ingredienti">
                Vai ai prodotti
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="alert info" style={{ marginBottom: 16 }}>
          <Icon name="alert" />
          <div>
            Per ogni riga scegli cosa fare. Per i <strong>prodotti nuovi</strong> servono nome, <strong>categoria</strong> e <strong>come lo paghi</strong>: di solito <strong>KG</strong> in fattura vuol dire prezzo al kg, <strong>N</strong> o <strong>PZ</strong> prezzo a confezione. Le scelte vengono ricordate: dalla prossima fattura di questo fornitore le righe saranno già abbinate.
          </div>
        </div>
      )}

      <div className="stack">
        {inv.lines.map((l) => {
          const c = choices[l.n]
          if (!c) return null
          const e = (k?: string) => errors[k ? `line${l.n}.${k}` : `line${l.n}`]
          const prod = c.ingredientId ? productsById.get(c.ingredientId) : undefined
          const preview = c.action !== 'ignore' ? pricePreview(l, c) : null
          return (
            <div key={l.n} id={`riga-${l.n}`} className={`card inv-line${c.action === 'ignore' ? ' ignored' : ''}${Object.keys(errors).some((k) => k === `line${l.n}` || k.startsWith(`line${l.n}.`)) ? ' has-error' : ''}`}>
              <div className="card-body stack">
                <div className="inv-line-head">
                  <span className="inv-n">{l.n}</span>
                  <div className="grow">
                    <div className="inv-desc">{l.description}</div>
                    <div className="small faint">
                      {l.code ? `cod. ${l.code} · ` : ''}
                      {l.quantity ? `${num(l.quantity)} ${l.um ?? ''} × ` : ''}
                      {l.netUnitPrice ? euro(l.netUnitPrice, Math.abs(Number(l.netUnitPrice)) < 1 && Number(l.netUnitPrice) !== 0 ? 4 : 2) : '—'}
                      {l.total ? ` = ${euro(l.total)}` : ''}
                      {l.vat ? ` · IVA ${num(l.vat)}%` : ''}
                    </div>
                  </div>
                  {l.suggestion?.remembered ? <span className="badge ok">Riconosciuta</span> : null}
                </div>

                {draft ? (
                  <>
                    <div className="seg" role="group" aria-label={`Riga ${l.n}: cosa fare`}>
                      {(
                        [
                          ['new', 'Nuovo prodotto'],
                          ['existing', 'Prodotto esistente'],
                          ['ignore', 'Ignora'],
                        ] as Array<[Action, string]>
                      ).map(([a, label]) => (
                        <button key={a} type="button" aria-pressed={c.action === a} onClick={() => set(l.n, { action: a })}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {e() ? (
                      <span className="error" role="alert">
                        {e()}
                      </span>
                    ) : null}

                    {c.action === 'new' ? (
                      <div className="grid-2">
                        <Field label="Nome del prodotto" required htmlFor={`n-${l.n}`} error={e('name')} hint="Scrivilo come lo chiami tu in cucina">
                          <input id={`n-${l.n}`} className="input" value={c.name} onChange={(ev) => set(l.n, { name: ev.target.value })} />
                        </Field>
                        <Field label="Categoria" required htmlFor={`c-${l.n}`} error={e('category')} hint="es. Latticini, Carne, Verdura, Conserve">
                          <input id={`c-${l.n}`} className="input" value={c.category} list="inv-categories" onChange={(ev) => set(l.n, { category: ev.target.value })} />
                        </Field>
                      </div>
                    ) : null}

                    {c.action === 'existing' ? (
                      <Field label="Quale prodotto?" required htmlFor={`p-${l.n}`} error={e('ingredientId')}>
                        <select id={`p-${l.n}`} className="input" value={c.ingredientId} onChange={(ev) => set(l.n, { ingredientId: ev.target.value })}>
                          <option value="">— scegli —</option>
                          {grouped.map(([cat, ps]) => (
                            <optgroup key={cat} label={cat}>
                              {ps.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                  {p.supplier ? ` · ${p.supplier}` : ''}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </Field>
                    ) : null}

                    {c.action !== 'ignore' ? (
                      <>
                        <div className="field">
                          <label>
                            Come lo paghi?<span aria-hidden="true"> *</span>
                            {l.um ? <span className="faint small"> (in fattura: {l.um})</span> : null}
                          </label>
                          <div className="buy-modes three" role="group" aria-label={`Riga ${l.n}: come lo paghi`}>
                            {MODES.map((m) => (
                              <button key={m.value} type="button" className="buy-mode" aria-pressed={c.mode === m.value} onClick={() => set(l.n, { mode: m.value })}>
                                <span className="bm-title">{m.title}</span>
                                <span className="bm-ex">{m.ex}</span>
                              </button>
                            ))}
                          </div>
                          {e('mode') ? (
                            <span className="error" role="alert">
                              {e('mode')}
                            </span>
                          ) : null}
                        </div>
                        {c.mode === 'conf' ? (
                          <div className="grid-2">
                            <Field label="Che confezione è?" htmlFor={`t-${l.n}`} hint="es. cartone, bottiglia, vaschetta">
                              <input id={`t-${l.n}`} className="input" value={c.purchaseUnit} onChange={(ev) => set(l.n, { purchaseUnit: ev.target.value })} />
                            </Field>
                            <Field label="Quanto contiene una confezione?" required htmlFor={`q-${l.n}`} error={e('packageContent')} hint="es. 700 g · cartone 6 × 1,5 l → 9 l · 30 uova → 30 pz">
                              <NumberInput
                                id={`q-${l.n}`}
                                value={c.packageContent}
                                onChange={(x) => set(l.n, { packageContent: x })}
                                invalid={!!e('packageContent')}
                                suffix={
                                  <select className="addon" value={c.packageUnit} onChange={(ev) => set(l.n, { packageUnit: ev.target.value })} aria-label="Unità del contenuto">
                                    {UNITS.map((u) => (
                                      <option key={u.value} value={u.value}>
                                        {u.label}
                                      </option>
                                    ))}
                                  </select>
                                }
                              />
                            </Field>
                          </div>
                        ) : null}
                        {c.action === 'new' && c.mode === 'conf' && c.packageUnit === 'pz' ? (
                          <div className="grid-2">
                            <Field label="Quanto pesa o contiene un pezzo?" required htmlFor={`pc-${l.n}`} error={e('pieceSize')} hint="es. bustina 12 g · uovo 60 g · bottiglietta 250 ml: così in ricetta lo usi anche a grammi o ml">
                              <NumberInput
                                id={`pc-${l.n}`}
                                value={c.pieceSize}
                                onChange={(x) => set(l.n, { pieceSize: x })}
                                invalid={!!e('pieceSize')}
                                suffix={
                                  <select className="addon" value={c.pieceUnit} onChange={(ev) => set(l.n, { pieceUnit: ev.target.value as 'g' | 'ml' })} aria-label="Unità del pezzo">
                                    <option value="g">g</option>
                                    <option value="ml">ml</option>
                                  </select>
                                }
                              />
                            </Field>
                          </div>
                        ) : null}
                        <div className="row wrap between">
                          {preview ? <span className="price-preview">Prezzo senza IVA: {preview}</span> : <span />}
                          {prod ? <span className="small faint">Registrato come: {prod.purchaseUnit} da {num(prod.packageContent)} {prod.packageUnit}</span> : null}
                        </div>
                      </>
                    ) : null}
                    <label className="checkbox small">
                      <input type="checkbox" checked={c.remember} onChange={(ev) => set(l.n, { remember: ev.target.checked })} /> Ricorda questa scelta per le prossime fatture di {inv.supplier}
                    </label>
                  </>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <datalist id="inv-categories">
        {inv.categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {draft ? (
        <div className="inv-bar">
          {error ? <div className="alert err">{error}</div> : null}
          <div className="row wrap between">
            <span className="small muted">
              {counts.new ?? 0} nuovi · {counts.existing ?? 0} esistenti · {counts.ignore ?? 0} ignorate
            </span>
            <div className="row wrap">
              <button className="btn ghost" onClick={() => setDiscard(true)} disabled={busy}>
                Scarta fattura
              </button>
              <button className="btn primary" onClick={() => void confirm()} disabled={busy}>
                {busy ? <span className="spinner" /> : <Icon name="check" />} Importa prezzi
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {discard ? (
        <Confirm
          title="Scartare questa fattura?"
          message="Nessun prezzo viene registrato. Potrai ricaricarla in seguito."
          confirmLabel="Scarta"
          danger
          onCancel={() => setDiscard(false)}
          onConfirm={async () => {
            await api.del(`/supplier-invoices/${id}`)
            qc.invalidateQueries({ queryKey: ['supplier-invoices'] })
            router.push('/importazioni')
          }}
        />
      ) : null}
    </>
  )
}
