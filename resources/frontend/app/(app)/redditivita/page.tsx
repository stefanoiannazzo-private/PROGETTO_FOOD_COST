'use client'

import Link from 'next/link'
import { FilterBar } from '@/components/FilterBar'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { date, euro, num, percent, todayIso } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { Drawer, Empty, ErrorBox, errorMessage, Field, fieldErrors, Icon, NumberInput, Skeleton, useToast } from '@/components/ui'

/**
 * NUOVO — Coefficiente di redditività: quanti piatti di un certo tipo servono, a settimana e per giorno
 * di apertura, per coprire i costi fissi dell'attività. Solo per l'amministratore.
 */
interface FixedCost {
  id: string
  name: string
  category: string
  categoryLabel: string
  amount: string
  period: 'weekly' | 'monthly' | 'yearly'
  validFrom: string
  validTo: string | null
  notes: string | null
  monthly: string
  active: boolean
  status: 'active' | 'future' | 'ended'
}
interface Dish {
  recipeId: string
  code: string
  title: string
  category: string | null
  status: string
  menuPrice: string | null
  vatPercent: string
  portions: string | null
  costComplete: boolean
  netPrice: string | null
  variableCost: string | null
  margin: string | null
  marginPercent: string | null
  perWeek: number | null
  perOpenDay: number | null
  perMonth: number | null
  issue: null | 'missing_portions' | 'missing_price' | 'missing_cost' | 'no_margin' | 'no_open_days'
}
interface Data {
  date: string
  settings: { closedWeekdays: number[]; includeStaff: boolean; referenceRecipeId: string | null }
  openDaysPerWeek: number
  categories: Record<string, string>
  fixedCosts: FixedCost[]
  staff: { count: number; missing: number; monthly: string; included: boolean }
  lines: Array<{ source: 'fixed_cost' | 'staff' | 'bill'; label: string; detail: string | null; monthly: string; weekly: string }>
  totals: { monthly: string; weekly: string | null; perOpenDay: string | null }
  dishes: Dish[]
}

const WEEKDAYS: Array<[number, string]> = [
  [1, 'Lun'],
  [2, 'Mar'],
  [3, 'Mer'],
  [4, 'Gio'],
  [5, 'Ven'],
  [6, 'Sab'],
  [7, 'Dom'],
]
const PERIODS: Record<FixedCost['period'], string> = { weekly: 'a settimana', monthly: 'al mese', yearly: 'all’anno' }
const VAT_RATES = ['4', '5', '10', '22', '0']

const ISSUES: Record<NonNullable<Dish['issue']>, string> = {
  missing_portions: 'Indica nella ricetta quante porzioni produce.',
  missing_price: 'Inserisci il prezzo in menu.',
  missing_cost: 'Costo della ricetta non calcolabile: controlla ingredienti ed energia.',
  no_margin: 'Il prezzo non copre nemmeno ingredienti ed energia.',
  no_open_days: 'Indica almeno un giorno di apertura.',
}

export default function ProfitabilityPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['profitability'], queryFn: () => api.get<Data>('/profitability') })
  const [editing, setEditing] = useState<FixedCost | 'new' | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['profitability'] })

  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data) return <Skeleton rows={10} />
  const d = q.data
  const priced = d.dishes.filter((x) => x.menuPrice !== null)
  const refId = d.settings.referenceRecipeId && d.dishes.some((x) => x.recipeId === d.settings.referenceRecipeId) ? d.settings.referenceRecipeId : (priced[0]?.recipeId ?? null)
  const ref = d.dishes.find((x) => x.recipeId === refId) ?? null

  const saveSettings = async (patch: Partial<Data['settings']>) => {
    try {
      await api.put('/profitability/settings', { ...d.settings, ...patch })
      refresh()
    } catch (e) {
      toast(errorMessage(e), 'err')
    }
  }

  return (
    <>
      <PageHead
        title="Coefficiente di redditività"
        sub="Quanti piatti devi vendere per coprire i costi fissi dell’attività. Dal piatto successivo cominci a guadagnare."
      />
      <div className="stack loose">
        <div className="card">
          <div className="card-body">
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }}>
              <Field label="Piatto da usare come unità di misura" htmlFor="ref-dish">
                <select
                  id="ref-dish"
                  className="input"
                  value={refId ?? ''}
                  onChange={(e) => saveSettings({ referenceRecipeId: e.target.value || null })}
                  disabled={d.dishes.length === 0}
                  style={{ minWidth: 280 }}
                >
                  {/* NUOVO: tutte le ricette sono selezionabili; quelle senza prezzo si completano qui sotto */}
                  {d.dishes.length === 0 ? <option value="">Nessuna ricetta: creane una</option> : !ref ? <option value="">— scegli un piatto —</option> : null}
                  {priced.length ? (
                    <optgroup label="Con prezzo in menu">
                      {priced.map((x) => (
                        <option key={x.recipeId} value={x.recipeId}>
                          {x.title} — {euro(x.menuPrice)}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {d.dishes.some((x) => x.menuPrice === null) ? (
                    <optgroup label="Senza prezzo in menu (lo inserisci subito dopo)">
                      {d.dishes
                        .filter((x) => x.menuPrice === null)
                        .map((x) => (
                          <option key={x.recipeId} value={x.recipeId}>
                            {x.title}
                            {x.status === 'draft' ? ' (bozza)' : ''}
                          </option>
                        ))}
                    </optgroup>
                  ) : null}
                </select>
              </Field>
              {ref && ref.menuPrice === null ? <QuickPrice key={ref.recipeId} dish={ref} onSaved={refresh} /> : null}
            </div>
            {!ref ? (
              <p className="muted" style={{ marginTop: 16 }}>
                {d.dishes.length === 0 ? 'Crea almeno una ricetta per vedere il risultato.' : 'Scegli il piatto da usare come unità di misura.'}
              </p>
            ) : ref.issue === 'missing_price' ? (
              <p className="muted" style={{ marginTop: 16 }}>
                Inserisci qui sopra il prezzo in menu di <strong>{ref.title}</strong> (IVA inclusa) e premi «Salva prezzo»: il risultato compare subito.
              </p>
            ) : ref.issue ? (
              <div className="alert warn" style={{ marginTop: 16 }}>
                {ISSUES[ref.issue]}
              </div>
            ) : (
              <>
                <div className="kpis" style={{ marginTop: 16 }}>
                  <div className="kpi">
                    <div className="k-label">A settimana</div>
                    <div className="k-value">{num(ref.perWeek)}</div>
                    <div className="faint small">{ref.title}</div>
                  </div>
                  <div className="kpi">
                    <div className="k-label">Per giorno di apertura (media)</div>
                    <div className="k-value">{num(ref.perOpenDay)}</div>
                    <div className="faint small">
                      su {d.openDaysPerWeek} {d.openDaysPerWeek === 1 ? 'giorno' : 'giorni'} a settimana
                    </div>
                  </div>
                  <div className="kpi">
                    <div className="k-label">Al mese</div>
                    <div className="k-value">{num(ref.perMonth)}</div>
                  </div>
                  <div className="kpi">
                    <div className="k-label">Guadagno su ogni piatto</div>
                    <div className="k-value">{euro(ref.margin)}</div>
                    <div className="faint small">{percent(ref.marginPercent)} del prezzo senza IVA</div>
                  </div>
                </div>
                <p style={{ marginTop: 12 }}>
                  Per andare in pari ti servono <strong>{num(ref.perWeek)} {ref.title}</strong> a settimana: dal piatto numero {num((ref.perWeek ?? 0) + 1)} in poi cominci a
                  guadagnare.
                </p>
                <p className="small muted">
                  Prezzo in menu {euro(ref.menuPrice)} (IVA {num(ref.vatPercent)}% inclusa) → {euro(ref.netPrice)} senza IVA, meno {euro(ref.variableCost)} di ingredienti ed energia per porzione ={' '}
                  {euro(ref.margin)} che restano per coprire i costi fissi ({euro(d.totals.weekly)} a settimana). La manodopera non è tolta dal piatto perché gli stipendi sono già
                  tra i costi fissi.
                  {!ref.costComplete ? ' Attenzione: il costo della ricetta è incompleto.' : ''}
                </p>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Lo stesso obiettivo con gli altri piatti</h2>
          </div>
          {priced.length === 0 ? (
            <Empty title="Nessun piatto con prezzo in menu" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Piatto</th>
                    <th className="num">Prezzo in menu</th>
                    <th className="num">Ingredienti + energia</th>
                    <th className="num">Guadagno per piatto</th>
                    <th className="num">A settimana</th>
                    <th className="num">Per giorno</th>
                  </tr>
                </thead>
                <tbody>
                  {priced.map((x) => (
                    <tr key={x.recipeId}>
                      <td>
                        <Link className="link" href={`/ricette/${x.recipeId}`}>
                          {x.title}
                        </Link>
                        {!x.costComplete ? <span className="badge warn"> costo incompleto</span> : null}
                      </td>
                      <td className="num">{euro(x.menuPrice)}</td>
                      <td className="num">{x.variableCost ? euro(x.variableCost) : '—'}</td>
                      <td className="num">{x.margin ? euro(x.margin) : '—'}</td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {x.perWeek !== null ? num(x.perWeek) : <span className="badge err">{x.issue === 'no_margin' ? 'in perdita' : 'n.d.'}</span>}
                      </td>
                      <td className="num">{x.perOpenDay !== null ? num(x.perOpenDay) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Costi fissi</h2>
            <button className="btn primary sm" onClick={() => setEditing('new')}>
              <Icon name="plus" /> Nuova voce
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Voce</th>
                  <th className="num">Al mese</th>
                  <th className="num">A settimana</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {l.label}
                      {l.detail ? <span className="faint small"> · {l.detail}</span> : null}
                      {l.source !== 'fixed_cost' ? <span className="badge info"> automatico</span> : null}
                    </td>
                    <td className="num">{euro(l.monthly)}</td>
                    <td className="num">{euro(l.weekly)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ fontWeight: 700 }}>Totale</td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {euro(d.totals.monthly)}
                  </td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {euro(d.totals.weekly)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card-body stack">
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={d.settings.includeStaff} onChange={(e) => saveSettings({ includeStaff: e.target.checked })} />
              Includi il costo del personale ({euro(d.staff.monthly)} al mese, {d.staff.count} {d.staff.count === 1 ? 'dipendente' : 'dipendenti'}, dalla sezione Dipendenti)
            </label>
            {d.staff.missing > 0 ? (
              <div className="alert warn small">
                {d.staff.missing} {d.staff.missing === 1 ? 'dipendente non ha' : 'dipendenti non hanno'} una retribuzione valida a oggi e non {d.staff.missing === 1 ? 'è contato' : 'sono contati'}.
              </div>
            ) : null}
            <p className="small muted">
              Le quote fisse delle bollette sono aggiunte in automatico solo per le voci <em>non</em> incluse nel prezzo dell’utenza: quelle incluse sono già nel costo dell’energia
              di ogni piatto.
            </p>
          </div>
          {d.fixedCosts.length ? (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Voce inserita</th>
                    <th>Tipo</th>
                    <th className="num">Importo</th>
                    <th>Periodo</th>
                    <th>Stato</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.fixedCosts.map((f) => (
                    <tr key={f.id}>
                      <td>
                        {f.name}
                        {f.notes ? <div className="faint small">{f.notes}</div> : null}
                      </td>
                      <td>{f.categoryLabel}</td>
                      <td className="num">
                        {euro(f.amount)} {PERIODS[f.period]}
                      </td>
                      <td className="small">
                        dal {date(f.validFrom)}
                        {f.validTo ? ` al ${date(f.validTo)}` : ''}
                      </td>
                      <td>
                        <span className={`badge ${f.status === 'active' ? 'ok' : f.status === 'future' ? 'info' : ''}`}>{f.status === 'active' ? 'in corso' : f.status === 'future' ? 'futura' : 'terminata'}</span>
                      </td>
                      <td className="num">
                        <button className="btn ghost icon sm" aria-label={`Modifica ${f.name}`} onClick={() => setEditing(f)}>
                          <Icon name="edit" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Giorni di apertura</h2>
          </div>
          <div className="card-body stack">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {WEEKDAYS.map(([n, label]) => {
                const closed = d.settings.closedWeekdays.includes(n)
                return (
                  <button
                    key={n}
                    className={`btn sm ${closed ? '' : 'primary'}`}
                    aria-pressed={!closed}
                    title={closed ? 'Chiuso: clic per segnare come aperto' : 'Aperto: clic per segnare come giorno di chiusura'}
                    onClick={() => {
                      const next = closed ? d.settings.closedWeekdays.filter((x) => x !== n) : [...d.settings.closedWeekdays, n]
                      if (next.length >= 7) return toast('Serve almeno un giorno di apertura.', 'err')
                      saveSettings({ closedWeekdays: next })
                    }}
                  >
                    {label} {closed ? '· chiuso' : ''}
                  </button>
                )
              })}
            </div>
            <p className="small muted">
              Il calcolo ragiona sulla settimana: i costi fissi settimanali sono divisi per {d.openDaysPerWeek} {d.openDaysPerWeek === 1 ? 'giorno' : 'giorni'} di apertura (
              {euro(d.totals.perOpenDay)} per giorno). Nei giorni di maggiore affluenza ne venderai di più, in quelli tranquilli di meno: conta raggiungere il totale della
              settimana.
            </p>
          </div>
        </div>

        <MenuPrices dishes={d.dishes} onSaved={refresh} />
      </div>
      {editing ? <FixedCostDrawer cost={editing === 'new' ? null : editing} categories={d.categories} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
    </>
  )
}

function MenuPrices({ dishes, onSaved }: { dishes: Dish[]; onSaved: () => void }) {
  const toast = useToast()
  const [edits, setEdits] = useState<Record<string, { price: string | null; vat: string }>>({})
  const [filter, setFilter] = useState('')
  const rows = dishes.filter((x) => !filter || x.title.toLowerCase().includes(filter.toLowerCase()) || x.code.toLowerCase().includes(filter.toLowerCase()))
  return (
    <div className="card">
      <div className="card-head">
        <h2>Prezzi in menu</h2>
      </div>
      <FilterBar search={<input className="input filterbar-search" type="search" placeholder="Cerca piatto" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Cerca piatto" />} />
      {dishes.length === 0 ? (
        <Empty title="Nessuna ricetta">Crea le ricette dei piatti che vendi per poterne indicare il prezzo.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Ricetta</th>
                <th className="num">Porzioni</th>
                <th>Prezzo in menu (IVA inclusa)</th>
                <th>IVA</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const e = edits[x.recipeId] ?? { price: x.menuPrice, vat: x.vatPercent }
                const changed = e.price !== x.menuPrice || e.vat !== x.vatPercent
                return (
                  <tr key={x.recipeId}>
                    <td>
                      {x.title} <span className="faint small">{x.code}</span>
                    </td>
                    <td className="num">{x.portions ? num(x.portions) : <span className="badge warn">da indicare</span>}</td>
                    <td style={{ maxWidth: 160 }}>
                      <NumberInput
                        ariaLabel={`Prezzo di ${x.title}`}
                        value={e.price}
                        onChange={(v) => setEdits((s) => ({ ...s, [x.recipeId]: { ...e, price: v } }))}
                        suffix="€"
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={`IVA di ${x.title}`}
                        value={VAT_RATES.includes(e.vat) ? e.vat : 'altro'}
                        onChange={(ev) => setEdits((s) => ({ ...s, [x.recipeId]: { ...e, vat: ev.target.value } }))}
                      >
                        {VAT_RATES.map((v) => (
                          <option key={v} value={v}>
                            {v}%
                          </option>
                        ))}
                        {!VAT_RATES.includes(e.vat) ? <option value="altro">{e.vat}%</option> : null}
                      </select>
                    </td>
                    <td className="num">
                      <button
                        className="btn sm primary"
                        disabled={!changed}
                        onClick={async () => {
                          try {
                            await api.put(`/profitability/prices/${x.recipeId}`, { menuPrice: e.price, vatPercent: e.vat })
                            setEdits((s) => {
                              const n = { ...s }
                              delete n[x.recipeId]
                              return n
                            })
                            onSaved()
                          } catch (err) {
                            toast(errorMessage(err), 'err')
                          }
                        }}
                      >
                        Salva
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function FixedCostDrawer({ cost, categories, onClose, onSaved }: { cost: FixedCost | null; categories: Record<string, string>; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({
    name: cost?.name ?? '',
    category: cost?.category ?? 'rent',
    amount: cost?.amount ?? (null as string | null),
    period: cost?.period ?? ('monthly' as FixedCost['period']),
    validFrom: cost?.validFrom ?? todayIso(),
    validTo: cost?.validTo ?? '',
    notes: cost?.notes ?? '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const body = { ...v, validTo: v.validTo || null, notes: v.notes || null }
  const save = async () => {
    setErrors({})
    setError('')
    try {
      if (cost) await api.put(`/profitability/fixed-costs/${cost.id}`, body)
      else await api.post('/profitability/fixed-costs', body)
      onSaved()
      onClose()
    } catch (e) {
      setErrors(fieldErrors(e))
      setError(errorMessage(e))
    }
  }
  return (
    <Drawer
      title={cost ? 'Modifica costo fisso' : 'Nuovo costo fisso'}
      onClose={onClose}
      footer={
        <>
          {cost ? (
            <button
              className="btn ghost"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                if (!window.confirm(`Eliminare «${cost.name}»?`)) return
                await api.del(`/profitability/fixed-costs/${cost.id}`)
                onSaved()
                onClose()
              }}
            >
              <Icon name="trash" /> Elimina
            </button>
          ) : null}
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button className="btn primary" onClick={save}>
            Salva
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? <div className="alert err">{error}</div> : null}
        <Field label="Descrizione" htmlFor="fc-name" required error={errors.name}>
          <input id="fc-name" className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="es. Affitto locale, Rate forno" autoFocus />
        </Field>
        <Field label="Tipo" htmlFor="fc-cat" error={errors.category}>
          <select id="fc-cat" className="input" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>
            {Object.entries(categories).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="Importo" htmlFor="fc-amount" required error={errors.amount}>
            <NumberInput id="fc-amount" value={v.amount} onChange={(x) => setV({ ...v, amount: x })} suffix="€" />
          </Field>
          <Field label="Ogni" htmlFor="fc-period" error={errors.period}>
            <select id="fc-period" className="input" value={v.period} onChange={(e) => setV({ ...v, period: e.target.value as FixedCost['period'] })}>
              <option value="weekly">settimana</option>
              <option value="monthly">mese</option>
              <option value="yearly">anno</option>
            </select>
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Dal" htmlFor="fc-from" required error={errors.validFrom}>
            <input id="fc-from" type="date" className="input" value={v.validFrom} onChange={(e) => setV({ ...v, validFrom: e.target.value })} />
          </Field>
          <Field label="Al" htmlFor="fc-to" error={errors.validTo} hint="Per rate e finanziamenti: l’ultima rata. Vuoto se non ha scadenza.">
            <input id="fc-to" type="date" className="input" value={v.validTo} onChange={(e) => setV({ ...v, validTo: e.target.value })} />
          </Field>
        </div>
        <Field label="Note" htmlFor="fc-notes" error={errors.notes}>
          <textarea id="fc-notes" className="input" rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </Field>
      </div>
    </Drawer>
  )
}

/** NUOVO — prezzo in menu inserito direttamente accanto alla scelta del piatto. */
function QuickPrice({ dish, onSaved }: { dish: Dish; onSaved: () => void }) {
  const toast = useToast()
  const [price, setPrice] = useState<string | null>(null)
  const [vat, setVat] = useState(dish.vatPercent ?? '10')
  const [busy, setBusy] = useState(false)
  return (
    <>
      <Field label="Prezzo in menu (IVA inclusa)" htmlFor="ref-price">
        <NumberInput id="ref-price" value={price} onChange={setPrice} suffix="€" />
      </Field>
      <Field label="IVA" htmlFor="ref-vat">
        <select id="ref-vat" className="input" value={vat} onChange={(e) => setVat(e.target.value)} style={{ width: 90 }}>
          {VAT_RATES.map((r) => (
            <option key={r} value={r}>
              {r}%
            </option>
          ))}
        </select>
      </Field>
      <button
        className="btn primary"
        disabled={busy || !price}
        onClick={async () => {
          setBusy(true)
          try {
            await api.put(`/profitability/prices/${dish.recipeId}`, { menuPrice: price, vatPercent: vat })
            toast(`Prezzo di «${dish.title}» salvato.`)
            onSaved()
          } catch (e) {
            toast(errorMessage(e), 'err')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? <span className="spinner" /> : null} Salva prezzo
      </button>
    </>
  )
}
