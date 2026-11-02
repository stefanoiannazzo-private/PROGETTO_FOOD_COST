'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AffectedRecipe } from '@/lib/api'
import { date, dateTime, euro, euroPer, num, todayIso } from '@/lib/num'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { IngredientFields, ingredientPayload, UNITS, type IngredientFormValue } from '@/components/IngredientForm'
import { AffectedNotice, Confirm, ErrorBox, errorMessage, Field, fieldErrors, Icon, NumberInput, Skeleton, StatusBadge, useToast } from '@/components/ui'

interface Price {
  id: string
  package_price: string
  package_content: string
  package_unit: string
  valid_from: string
  source: string | null
  notes: string | null
  created_at: string
  created_by: string | null
  import_id: string | null
  unitPrice: string
  baseUnit: string
  future: boolean
}
interface Detail extends Omit<IngredientFormValue, 'code'> {
  id: string
  code: string
  archived: boolean
  lockVersion: number
  priceVisible: boolean
  currentPrice: (Price & { unitPrice: string }) | null
  prices: Price[]
  usedIn: Array<{ id: string; code: string; title: string; status: string }>
  updatedAt: string
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
  const editable = can('ingredients.manage')

  useEffect(() => {
    if (q.data) {
      const d = q.data
      setV({
        code: d.code,
        name: d.name,
        category: d.category ?? '',
        supplier: d.supplier ?? '',
        notes: d.notes ?? '',
        purchaseUnit: d.purchaseUnit,
        packageContent: d.packageContent,
        packageUnit: d.packageUnit,
        usageUnit: d.usageUnit,
        edibleYieldPercent: d.edibleYieldPercent,
        densityKgPerL: d.densityKgPerL,
        unitWeightKg: d.unitWeightKg,
      })
    }
  }, [q.data])

  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data || !v) return <Skeleton rows={8} />
  const d = q.data

  const save = async () => {
    setSaving(true)
    setErrors({})
    try {
      const r = await api.patch<{ affectedRecipes: AffectedRecipe[] }>(`/ingredients/${id}`, { ...ingredientPayload(v), code: v.code, lockVersion: d.lockVersion })
      setAffected(r.affectedRecipes)
      await qc.invalidateQueries({ queryKey: ['ingredients'] })
      await qc.invalidateQueries({ queryKey: ['recipes'] })
      toast('Ingrediente salvato.')
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
              <IngredientFields v={v} set={(p) => setV((x) => ({ ...x!, ...p }))} errors={errors} />
            </fieldset>
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
  const [form, setForm] = useState({ packagePrice: null as string | null, validFrom: todayIso(), source: '', notes: '', packageContent: d.packageContent as string | null, packageUnit: d.packageUnit })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const unitPreview = form.packagePrice && form.packageContent ? Number(form.packagePrice) / Number(form.packageContent) : null

  return (
    <div className="card">
      <div className="card-head">
        <h2>Prezzo e storico</h2>
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
                  notes: form.notes || null,
                  packageContent: form.packageContent,
                  packageUnit: form.packageUnit,
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
            <div className="grid-4">
              <Field label="Prezzo confezione (netto IVA)" htmlFor="p-price" required error={errors.packagePrice}>
                <NumberInput id="p-price" value={form.packagePrice} onChange={(x) => setForm((f) => ({ ...f, packagePrice: x }))} suffix="€" invalid={!!errors.packagePrice} />
              </Field>
              <Field label="Contenuto confezione" htmlFor="p-cont" error={errors.packageContent}>
                <NumberInput
                  id="p-cont"
                  value={form.packageContent}
                  onChange={(x) => setForm((f) => ({ ...f, packageContent: x }))}
                  suffix={
                    <select className="addon" value={form.packageUnit} onChange={(e) => setForm((f) => ({ ...f, packageUnit: e.target.value }))} aria-label="Unità">
                      {UNITS.map((u) => (
                        <option key={u.value}>{u.value}</option>
                      ))}
                    </select>
                  }
                />
              </Field>
              <Field label="Valido dal" htmlFor="p-vf" required error={errors.validFrom}>
                <input id="p-vf" type="date" className="input" value={form.validFrom} onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))} />
              </Field>
              <Field label="Fonte" htmlFor="p-src" hint="fattura, listino…">
                <input id="p-src" className="input" value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} />
              </Field>
            </div>
            {unitPreview !== null && Number.isFinite(unitPreview) ? <div className="small muted">Prezzo normalizzato risultante: circa {euro(String(unitPreview), 4)} per unità della confezione.</div> : null}
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
        {d.prices.length ? (
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Valido dal</th>
                  <th className="num">Prezzo confezione</th>
                  <th>Confezione</th>
                  <th className="num">Normalizzato</th>
                  <th>Fonte</th>
                  <th>Inserito</th>
                  {editable ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {d.prices.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {date(p.valid_from)} {p.future ? <span className="badge info">futuro</span> : d.currentPrice?.id === p.id ? <span className="badge ok">corrente</span> : null}
                    </td>
                    <td className="num">{euro(p.package_price)}</td>
                    <td>
                      {num(p.package_content)} {p.package_unit}
                    </td>
                    <td className="num">{euroPer(p.unitPrice, p.baseUnit, 4)}</td>
                    <td>{p.source ?? (p.import_id ? 'Importazione' : '—')}</td>
                    <td className="faint small">
                      {dateTime(p.created_at)} {p.created_by ? `· ${p.created_by}` : ''}
                    </td>
                    {editable ? (
                      <td className="num">
                        <button
                          className="btn ghost icon sm"
                          aria-label="Elimina prezzo"
                          onClick={async () => {
                            if (!window.confirm('Eliminare questa voce di storico? Gli snapshot già salvati non cambiano.')) return
                            const r = await api.del<{ affectedRecipes: AffectedRecipe[] }>(`/ingredients/${d.id}/prices/${p.id}`)
                            onAffected(r.affectedRecipes)
                            await qc.invalidateQueries({ queryKey: ['ingredients'] })
                            qc.invalidateQueries({ queryKey: ['recipes'] })
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  )
}
