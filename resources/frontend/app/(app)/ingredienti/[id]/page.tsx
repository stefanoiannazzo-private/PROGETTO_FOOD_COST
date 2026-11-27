'use client'

import Link from 'next/link'
import { backTarget, savedMessage } from '@/lib/nav-history'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AffectedRecipe } from '@/lib/api'
import { date, dateTime, euro, euroPer, num, todayIso } from '@/lib/num'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { ChangesNotice, type Change } from '@/components/ChangeAlerts'
import { PriceHistory } from '@/components/PriceHistory'
import { AgentSelect, BuyBlock, inferMode, IngredientFields, ingredientPayload, packageOf, validateIngredient, type BuyMode, type IngredientFormValue, useCategorySettings } from '@/components/IngredientForm'
import { AffectedNotice, Confirm, ErrorBox, errorMessage, Field, fieldErrors, Icon, NumberInput, Skeleton, StatusBadge, useToast } from '@/components/ui'

interface Price {
  id: string
  package_price: string
  package_content: string
  package_unit: string
  valid_from: string
  source: string | null
  agent_name: string | null
  notes: string | null
  created_at: string
  created_by: string | null
  import_id: string | null
  supplier: string | null
  supplier_invoice_id?: string | null
  unitPrice: string
  baseUnit: string
  future: boolean
}
const TO_BASE: Record<string, number> = { g: 0.001, kg: 1, ml: 0.001, cl: 0.01, l: 1, pz: 1 }
const dimOf = (u: string): 'mass' | 'volume' | 'count' => (['g', 'kg'].includes(u) ? 'mass' : ['ml', 'cl', 'l'].includes(u) ? 'volume' : 'count')

interface Detail extends Omit<IngredientFormValue, 'code' | 'mode'> {
  id: string
  code: string
  archived: boolean
  lockVersion: number
  nonFoodOverride: boolean | null
  categoryNonFood: boolean
  priceVisible: boolean
  currentPrice: (Price & { unitPrice: string }) | null
  prices: Price[]
  usedIn: Array<{ id: string; code: string; title: string; status: string }>
  updatedAt: string
  changes?: Change[]
}

export default function IngredientDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['ingredients', id], queryFn: () => api.get<Detail>(`/ingredients/${id}`) })
  const [v, setV] = useState<IngredientFormValue | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [affected, setAffected] = useState<AffectedRecipe[]>([])
  const [confirm, setConfirm] = useState<null | 'delete' | 'archive'>(null)
  const [updatePrices, setUpdatePrices] = useState(true)
  const editable = can('ingredients.manage')
  const cats = useCategorySettings()

  useEffect(() => {
    if (q.data) {
      const d = q.data
      setV({
        code: d.code,
        name: d.name,
        category: d.category ?? '',
        supplier: d.supplier ?? '',
        notes: d.notes ?? '',
        mode: inferMode(d.purchaseUnit, d.packageContent, d.packageUnit),
        purchaseUnit: d.purchaseUnit,
        packageContent: d.packageContent,
        packageUnit: d.packageUnit,
        usageUnit: d.usageUnit,
        edibleYieldPercent: d.edibleYieldPercent,
        densityKgPerL: d.densityKgPerL,
        unitWeightKg: d.unitWeightKg,
        nonFood: d.nonFoodOverride,
      })
    }
  }, [q.data])

  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data || !v) return <Skeleton rows={8} />
  const d = q.data
  // NUOVO: la confezione cambia (es. da «1 pz» a «24 pz») e ci sono prezzi registrati con quella di prima:
  // si propone di correggerli, perché l'importo pagato era per la confezione intera.
  const pl = ingredientPayload(v)
  const packChanged = pl.packageUnit !== d.packageUnit || Number(String(pl.packageContent).replace(',', '.')) !== Number(d.packageContent)
  const oldPrices = d.prices.filter((p) => p.package_unit === d.packageUnit && Number(p.package_content) === Number(d.packageContent))
  const newContent = Number(String(pl.packageContent).replace(',', '.'))
  const dimChanged = dimOf(pl.packageUnit) !== dimOf(d.packageUnit)
  const repack = !dimChanged && packChanged && oldPrices.length && newContent > 0 ? { n: oldPrices.length, sample: oldPrices[0]! } : null
  const perUnit = (price: string, content = newContent) => {
    const f = TO_BASE[pl.packageUnit] ?? 1
    const base = dimOf(pl.packageUnit) === 'mass' ? 'kg' : dimOf(pl.packageUnit) === 'volume' ? 'l' : 'pz'
    return euroPer(String(Number(price) / (content * f)), base, 4)
  }
  // NUOVO: cambio di tipo (pezzi ↔ peso ↔ volume): tutti i prezzi registrati si convertono con peso del pezzo e densità
  const density = Number(pl.densityKgPerL) > 0 ? Number(pl.densityKgPerL) : null
  const pieceKg = Number(pl.unitWeightKg) > 0 ? Number(pl.unitWeightKg) : null
  const perPackage = !['kg', 'litro', 'l'].includes((pl.purchaseUnit ?? '').toLowerCase())
  const convert = (content: string, unit: string): number | 'density' | 'piece' => {
    // prezzo per la confezione di prima (es. «1 pz» = un vaso) e ancora a confezione: stesso importo per la nuova
    if (perPackage && unit === d.packageUnit && Number(content) === Number(d.packageContent)) return newContent
    const base = Number(content) * (TO_BASE[unit] ?? 1)
    const src = dimOf(unit)
    const dst = dimOf(pl.packageUnit)
    let kg: number
    if (src === 'mass') kg = base
    else if (src === 'volume') {
      if (!density) return 'density'
      kg = base * density
    } else {
      if (!pieceKg) return 'piece'
      kg = base * pieceKg
    }
    let out: number
    if (dst === 'mass') out = kg
    else if (dst === 'volume') {
      if (!density) return 'density'
      out = kg / density
    } else {
      if (!pieceKg) return 'piece'
      out = kg / pieceKg
    }
    return out / (TO_BASE[pl.packageUnit] ?? 1)
  }
  const conversions = dimChanged && d.prices.length ? d.prices.map((p) => ({ p, to: convert(p.package_content, p.package_unit) })) : []
  const convMissing = conversions.find((c) => typeof c.to === 'string')?.to as 'density' | 'piece' | undefined
  // prezzi già registrati con una confezione diversa da quella attuale (stessa grandezza): proposta di allineamento
  const misaligned = packChanged
    ? []
    : Object.values(
        d.prices
          .filter((p) => dimOf(p.package_unit) === dimOf(d.packageUnit) && !(p.package_unit === d.packageUnit && Number(p.package_content) === Number(d.packageContent)))
          .reduce<Record<string, { content: string; unit: string; n: number; sample: Price }>>((acc, p) => {
            const k = `${Number(p.package_content)}|${p.package_unit}`
            acc[k] = acc[k] ? { ...acc[k], n: acc[k].n + 1 } : { content: p.package_content, unit: p.package_unit, n: 1, sample: p }
            return acc
          }, {}),
      )
  const align = async (m: { content: string; unit: string }) => {
    try {
      const r = await api.post<{ updated: number; affectedRecipes: AffectedRecipe[] }>(`/ingredients/${id}/prices/align`, { fromContent: m.content, fromUnit: m.unit })
      setAffected(r.affectedRecipes)
      await qc.invalidateQueries({ queryKey: ['ingredients'] })
      await qc.invalidateQueries({ queryKey: ['recipes'] })
      toast(r.updated === 1 ? 'Prezzo corretto.' : `${r.updated} prezzi corretti.`)
    } catch (e) {
      toast(errorMessage(e), 'err')
    }
  }
  const qn = (x: string | number | null) => String(Number(x)).replace('.', ',')

  const save = async () => {
    const local = validateIngredient(v, v.nonFood ?? cats.categoryNonFood(v.category))
    if (convMissing === 'density') local.densityKgPerL = 'Serve per convertire i prezzi già registrati (per l’acqua 1).'
    if (convMissing === 'piece') local.unitWeightKg = 'Serve per convertire i prezzi già registrati.'
    setErrors(local)
    if (Object.keys(local).length) {
      toast('Completa i campi evidenziati.', 'err')
      return
    }
    setSaving(true)
    try {
      const r = await api.patch<{ affectedRecipes: AffectedRecipe[]; repricedPrices: number }>(`/ingredients/${id}`, { ...ingredientPayload(v), code: v.code, lockVersion: d.lockVersion, updatePrices: conversions.length > 0 || (!!repack && updatePrices) })
      setAffected(r.affectedRecipes)
      toast(savedMessage(r.repricedPrices ? `Prodotto salvato: confezione corretta anche in ${r.repricedPrices === 1 ? '1 prezzo' : `${r.repricedPrices} prezzi`}.` : 'Prodotto salvato.', r.affectedRecipes))
      await qc.invalidateQueries({ queryKey: ['ingredients'] })
      await qc.invalidateQueries({ queryKey: ['recipes'] })
      // NUOVO: torna all'elenco (o alla pagina da cui si era arrivati)
      router.push(backTarget(`/ingredienti/${id}`, '/ingredienti'))
    } catch (e) {
      setErrors(fieldErrors(e))
      toast(errorMessage(e), 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHead
        title={d.name}
        sub={
          <span className="row">
            <span className="mono">{d.code}</span>
            {d.archived ? <span className="badge warn">Archiviato</span> : null}
          </span>
        }
        actions={
          editable ? (
            <>
              {d.archived ? (
                <button className="btn" onClick={() => api.post(`/ingredients/${id}/restore`).then(() => q.refetch())}>
                  Ripristina
                </button>
              ) : (
                <button className="btn" onClick={() => setConfirm('archive')}>
                  <Icon name="archive" /> Archivia
                </button>
              )}
              {d.usedIn.length === 0 ? (
                <button className="btn danger" onClick={() => setConfirm('delete')}>
                  <Icon name="trash" /> Elimina
                </button>
              ) : null}
            </>
          ) : null
        }
      />
      <div className="stack loose">
        <ChangesNotice key={id} type="ingredient" id={id} changes={d.changes} />
        <AffectedNotice recipes={affected} />
        {d.priceVisible ? <PricesCard d={d} editable={editable} onAffected={setAffected} /> : null}

        <div className="card">
          <div className="card-head">
            <h2>Anagrafica</h2>
            <span className="faint small">Aggiornato {dateTime(d.updatedAt)}</span>
          </div>
          <form
            className="card-body stack"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
              <IngredientFields
                v={v}
                set={(p) => {
                  setV((x) => ({ ...x!, ...p }))
                  // un campo corretto non resta segnato in rosso fino al prossimo salvataggio
                  setErrors((e) => {
                    const keys = Object.keys(p).filter((k) => k in e)
                    if (!keys.length) return e
                    const n = { ...e }
                    keys.forEach((k) => delete n[k])
                    return n
                  })
                }}
                errors={errors}
              />
            </fieldset>
            {editable && d.priceVisible
              ? misaligned.map((m) => (
                  <div key={`${m.content}|${m.unit}`} className="alert warn" style={{ flexDirection: 'column', gap: 8 }}>
                    <span>
                      <strong>
                        {m.n === 1 ? 'Un prezzo è registrato' : `${m.n} prezzi sono registrati`} per {qn(m.content)} {m.unit}, ma la confezione indicata è da {qn(d.packageContent)} {d.packageUnit}.
                      </strong>{' '}
                      Se {m.n === 1 ? 'l\'importo era' : 'gli importi erano'} per la confezione intera (es. {euro(m.sample.package_price)} per il cartone), {m.n === 1 ? 'correggilo' : 'correggili'}: costerà {perUnit(m.sample.package_price)} invece di {euro(m.sample.unitPrice)}/{m.sample.baseUnit}.
                    </span>
                    <span>
                      <button type="button" className="btn sm primary" onClick={() => void align(m)}>
                        Correggi: {euro(m.sample.package_price)} per {qn(d.packageContent)} {d.packageUnit}
                      </button>
                    </span>
                  </div>
                ))
              : null}
            {editable && conversions.length && d.priceVisible ? (
              <div className={`alert ${convMissing ? 'warn' : 'info'}`} style={{ flexDirection: 'column', gap: 6 }}>
                <strong>
                  Cambi il tipo di prezzo: {conversions.length === 1 ? 'il prezzo già registrato viene convertito' : `i ${conversions.length} prezzi già registrati vengono convertiti`} (l'importo pagato resta uguale)
                </strong>
                {convMissing ? (
                  <span className="small">
                    {convMissing === 'density'
                      ? 'Per convertire serve la densità (kg per litro: acqua 1, latte 1,03, olio 0,92). Indicala in «Altri dettagli».'
                      : 'Per convertire serve quanto pesa o contiene un pezzo. Indicalo in «Altri dettagli» («Peso medio di un pezzo»).'}
                  </span>
                ) : (
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    {conversions.slice(0, 4).map(({ p, to }) => (
                      <li key={p.id}>
                        dal {date(p.valid_from)}: {euro(p.package_price)} per {qn(p.package_content)} {p.package_unit} → per {qn(Math.round((to as number) * 1000) / 1000)} {pl.packageUnit} = <strong>{perUnit(p.package_price, to as number)}</strong>
                      </li>
                    ))}
                    {conversions.length > 4 ? <li>e altri {conversions.length - 4}</li> : null}
                  </ul>
                )}
              </div>
            ) : null}
            {editable && repack && d.priceVisible ? (
              <label className="alert info row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={updatePrices} onChange={(e) => setUpdatePrices(e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  <strong>
                    Correggi anche {repack.n === 1 ? 'il prezzo già registrato' : `i ${repack.n} prezzi già registrati`} con la confezione da {qn(d.packageContent)} {d.packageUnit}
                  </strong>
                  <br />
                  <span className="small">
                    L'importo pagato resta {euro(repack.sample.package_price)}, ma vale per {qn(newContent)} {v.packageUnit}: {perUnit(repack.sample.package_price)} invece di {euro(repack.sample.unitPrice)}/{repack.sample.baseUnit}. Togli la spunta solo se quei prezzi erano davvero per {qn(d.packageContent)} {d.packageUnit}.
                  </span>
                </span>
              </label>
            ) : null}
            {editable ? (
              <div className="row">
                <button className="btn primary" type="submit" disabled={saving}>
                  {saving ? <span className="spinner" /> : null} Salva modifiche
                </button>
              </div>
            ) : null}
          </form>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Usato nelle ricette</h2>
          </div>
          {d.usedIn.length === 0 ? (
            <div className="card-body muted">Non ancora usato in nessuna ricetta.</div>
          ) : (
            <table className="table compact">
              <tbody>
                {d.usedIn.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="link" href={`/ricette/${r.id}`}>
                        {r.title}
                      </Link>{' '}
                      <span className="mono faint">{r.code}</span>
                    </td>
                    <td className="num">
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {confirm === 'archive' ? (
        <Confirm
          title="Archiviare l’ingrediente?"
          message="Non comparirà più negli elenchi e nelle ricerche, ma resta valido nelle ricette che lo usano e nello storico dei costi."
          confirmLabel="Archivia"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await api.post(`/ingredients/${id}/archive`)
            setConfirm(null)
            await q.refetch()
            qc.invalidateQueries({ queryKey: ['ingredients'] })
          }}
        />
      ) : null}
      {confirm === 'delete' ? (
        <Confirm
          title="Eliminare definitivamente?"
          message="L’ingrediente e il suo storico prezzi saranno cancellati. Possibile solo perché non è mai stato usato in una ricetta."
          confirmLabel="Elimina"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await api.del(`/ingredients/${id}`)
              qc.invalidateQueries({ queryKey: ['ingredients'] })
              router.replace('/ingredienti')
            } catch (e) {
              toast(errorMessage(e), 'err')
              setConfirm(null)
            }
          }}
        />
      ) : null}
    </>
  )
}

function PricesCard({ d, editable, onAffected }: { d: Detail; editable: boolean; onAffected: (r: AffectedRecipe[]) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  // NUOVO: il nuovo prezzo parte da "come lo paghi" dell'ultimo prezzo (o dell'anagrafica)
  const startPu = d.purchaseUnit
  const startContent = (d.currentPrice?.package_content ?? d.packageContent) as string | null
  const startUnit = d.currentPrice?.package_unit ?? d.packageUnit
  const [form, setForm] = useState({
    packagePrice: null as string | null,
    validFrom: todayIso(),
    source: '',
    agentName: d.currentPrice?.agent_name ?? '',
    notes: '',
    mode: inferMode(startPu, startContent, startUnit) as BuyMode,
    purchaseUnit: startPu,
    packageContent: startContent,
    packageUnit: startUnit,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  return (
    <div className="card">
      <div className="card-head">
        <h2>Prezzo e storico prezzi</h2>
        {editable && !open ? (
          <button className="btn sm primary" onClick={() => setOpen(true)}>
            <Icon name="plus" /> Nuovo prezzo
          </button>
        ) : null}
      </div>
      <div className="card-body stack">
        {d.currentPrice ? (
          <div className="row wrap" style={{ gap: 24 }}>
            <div>
              <div className="faint small">Prezzo corrente (netto IVA)</div>
              <div className="big-number">{euro(d.currentPrice.package_price)}</div>
              <div className="small muted">
                per {num(d.currentPrice.package_content)} {d.currentPrice.package_unit} · dal {date(d.currentPrice.valid_from)}
              </div>
            </div>
            <div>
              <div className="faint small">Prezzo normalizzato</div>
              <div className="big-number">{euroPer(d.currentPrice.unitPrice, d.currentPrice.baseUnit, 4)}</div>
            </div>
          </div>
        ) : (
          <div className="alert warn">Nessun prezzo valido a oggi: le ricette che usano questo ingrediente risultano incomplete.</div>
        )}
        {open ? (
          <form
            className="card card-pad stack"
            style={{ background: 'var(--surface-2)' }}
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              setErrors({})
              try {
                const r = await api.post<{ affectedRecipes: AffectedRecipe[] }>(`/ingredients/${d.id}/prices`, {
                  packagePrice: form.packagePrice ?? '',
                  validFrom: form.validFrom,
                  source: form.source || null,
                  agentName: form.agentName || null,
                  notes: form.notes || null,
                  ...(() => {
                    const pk = packageOf(form.mode, form)
                    return { packageContent: pk.packageContent, packageUnit: pk.packageUnit }
                  })(),
                })
                onAffected(r.affectedRecipes)
                toast('Prezzo registrato nello storico.')
                setOpen(false)
                setForm((f) => ({ ...f, packagePrice: null, source: '', notes: '' }))
                await qc.invalidateQueries({ queryKey: ['ingredients'] })
                await qc.invalidateQueries({ queryKey: ['recipes'] })
                qc.invalidateQueries({ queryKey: ['dashboard'] })
              } catch (err) {
                setErrors(fieldErrors(err))
                toast(errorMessage(err), 'err')
              } finally {
                setBusy(false)
              }
            }}
          >
            <BuyBlock
              mode={form.mode}
              purchaseUnit={form.purchaseUnit}
              content={form.packageContent}
              unit={form.packageUnit}
              errors={errors}
              idPrefix="p"
              lockDimension={dimOf(d.packageUnit)}
              price={form.packagePrice}
              onPrice={(x) => setForm((f) => ({ ...f, packagePrice: x }))}
              onChange={(p) => setForm((f) => ({ ...f, ...p }))}
            />
            <div className="grid-3">
              <Field label="Data del prezzo" htmlFor="p-vf" required error={errors.validFrom} hint="Di solito la data della fattura">
                <input id="p-vf" type="date" className="input" value={form.validFrom} onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))} />
              </Field>
              <Field label="Agente" htmlFor="p-agent" hint={d.supplier ? `Prima quelli di ${d.supplier}` : 'Facoltativo'}>
                <AgentSelect id="p-agent" supplier={d.supplier ?? ''} value={form.agentName} onChange={(x) => setForm((f) => ({ ...f, agentName: x }))} />
              </Field>
              <Field label="Fonte" htmlFor="p-src" hint="es. fattura n. 123, listino">
                <input id="p-src" className="input" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} />
              </Field>
            </div>
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? <span className="spinner" /> : null} Registra prezzo
              </button>
              <button className="btn" type="button" onClick={() => setOpen(false)}>
                Annulla
              </button>
            </div>
          </form>
        ) : null}
        <PriceHistory
          prices={d.prices}
          currentId={d.currentPrice?.id ?? null}
          onDelete={
            editable
              ? async (p) => {
                  if (!window.confirm('Eliminare questa voce di storico? Gli snapshot già salvati non cambiano.')) return
                  const r = await api.del<{ affectedRecipes: AffectedRecipe[] }>(`/ingredients/${d.id}/prices/${p.id}`)
                  onAffected(r.affectedRecipes)
                  await qc.invalidateQueries({ queryKey: ['ingredients'] })
                  qc.invalidateQueries({ queryKey: ['recipes'] })
                }
              : undefined
          }
        />
      </div>
    </div>
  )
}
