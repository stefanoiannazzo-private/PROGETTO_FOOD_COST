'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AffectedRecipe } from '@/lib/api'
import { date, dateTime, euro, num, todayIso, unitLabel } from '@/lib/num'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { AffectedNotice, ErrorBox, errorMessage, Field, fieldErrors, Icon, NumberInput, Skeleton, useToast } from '@/components/ui'
import { KIND_LABEL } from '@/lib/labels'

interface Version {
  id: string
  price_per_unit: string
  valid_from: string
  origin: 'direct' | 'bill'
  m3_to_smc: string | null
  smc_to_kwh: string | null
  bill: { periodFrom: string; periodTo: string; consumption: string; consumptionUnit: string; components: BillComponent[]; selectedTotal: string; fixedTotal: string; includesFixed: boolean } | null
  notes: string | null
  created_at: string
  created_by: string | null
  future: boolean
}
interface BillComponent {
  label: string
  amount: string | null
  kind: 'variable' | 'fixed'
  include: boolean
}
interface Detail {
  id: string
  name: string
  kind: 'electricity' | 'gas' | 'water'
  unit: 'kwh' | 'm3' | 'smc'
  notes: string | null
  archived: boolean
  versions: Version[]
  current: Version | null
  equipment: Array<{ id: string; code: string; name: string }>
}

/** NUOVO — bollette caricate (archivio) e risultato della lettura automatica */
interface BillRow {
  id: string
  fileName: string
  mime: string
  size: number
  supplier: string | null
  periodFrom: string | null
  periodTo: string | null
  totalAmount: string | null
  readStatus: 'ok' | 'failed' | 'off' | 'limit'
  version: { id: string; validFrom: string; pricePerUnit: string } | null
  createdAt: string
  createdBy: string | null
}
interface BillRead {
  id: string
  readStatus: BillRow['readStatus']
  message: string
  form: {
    validFrom: string | null
    periodFrom: string | null
    periodTo: string | null
    consumption: string | null
    consumptionUnit: string
    components: BillComponent[]
    m3ToSmc: string | null
    smcToKwh: string | null
  } | null
  info: { supplier: string | null; billNumber: string | null; issueDate: string | null; totalAmount: string | null } | null
  warnings: string[]
  method: 'ai' | 'local' | null
  found: Array<{ label: string; ok: boolean; value: string | null }> | null
}
type BillsResponse = { data: BillRow[]; meta: { aiEnabled: boolean; reader: 'ai' | 'local' } }

export default function TariffDetailPage() {
  const { id } = useParams<{ id: string }>()
  const can = useCan()
  const q = useQuery({ queryKey: ['tariffs', 'detail', id], queryFn: () => api.get<Detail>(`/tariffs/${id}`) })
  const [affected, setAffected] = useState<AffectedRecipe[]>([])
  const qc = useQueryClient()
  const toast = useToast()
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data) return <Skeleton rows={8} />
  const t = q.data
  const u = unitLabel(t.unit)
  return (
    <>
      <PageHead title={t.name} sub={`${KIND_LABEL[t.kind]} · prezzo in €/${u}`} />
      <div className="stack loose">
        <AffectedNotice recipes={affected} />
        <div className="kpis">
          <div className="kpi">
            <div className="k-label">Valore corrente</div>
            <div className="k-value">{t.current ? `${euro(t.current.price_per_unit, 4)}/${u}` : '—'}</div>
            <div className="k-sub">{t.current ? `dal ${date(t.current.valid_from)} · ${t.current.origin === 'bill' ? 'media da bolletta' : 'inserimento diretto'}` : 'nessun valore valido a oggi'}</div>
          </div>
          {t.kind === 'gas' ? (
            <div className="kpi">
              <div className="k-label">Coefficienti di conversione</div>
              <div className="small" style={{ marginTop: 6 }}>
                m³→Smc: {t.current?.m3_to_smc ? num(t.current.m3_to_smc, 6) : <span className="faint">non configurato</span>}
                <br />
                kWh/Smc: {t.current?.smc_to_kwh ? num(t.current.smc_to_kwh, 6) : <span className="faint">non configurato</span>}
              </div>
            </div>
          ) : null}
        </div>
        {can('tariffs.manage') ? <NewVersion t={t} onDone={(r) => setAffected(r)} /> : null}
        <div className="card">
          <div className="card-head">
            <h2>Storico valori</h2>
          </div>
          {t.versions.length === 0 ? (
            <div className="card-body muted">Nessun valore inserito.</div>
          ) : (
            <table className="table compact">
              <thead>
                <tr>
                  <th>Valido dal</th>
                  <th className="num">€/{u}</th>
                  <th>Origine</th>
                  <th>Dettaglio</th>
                  <th>Inserito</th>
                  {can('tariffs.manage') ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {t.versions.map((v) => (
                  <tr key={v.id}>
                    <td>
                      {date(v.valid_from)} {v.future ? <span className="badge info">futuro</span> : t.current?.id === v.id ? <span className="badge ok">corrente</span> : null}
                    </td>
                    <td className="num">{euro(v.price_per_unit, 5)}</td>
                    <td>{v.origin === 'bill' ? 'Bolletta (media del periodo)' : 'Diretta'}</td>
                    <td className="small">
                      {v.bill ? (
                        <>
                          {date(v.bill.periodFrom)}–{date(v.bill.periodTo)}: {euro(v.bill.selectedTotal)} / {num(v.bill.consumption)} {unitLabel(v.bill.consumptionUnit)}
                          {v.bill.includesFixed ? <span className="badge warn"> include quote fisse {euro(v.bill.fixedTotal)}</span> : null}
                        </>
                      ) : (
                        v.notes ?? '—'
                      )}
                    </td>
                    <td className="faint small">
                      {dateTime(v.created_at)} {v.created_by ? `· ${v.created_by}` : ''}
                    </td>
                    {/* NUOVO: eliminazione di un valore inserito per errore (l'API esisteva già nell'originale) */}
                    {can('tariffs.manage') ? (
                      <td className="num">
                        <button
                          className="btn ghost icon sm"
                          aria-label="Elimina valore"
                          title="Elimina questo valore"
                          onClick={async () => {
                            if (!window.confirm(`Eliminare il valore dal ${date(v.valid_from)}? Gli snapshot già salvati non cambiano.`)) return
                            try {
                              const r = await api.del<{ affectedRecipes: AffectedRecipe[] }>(`/tariffs/${t.id}/versions/${v.id}`)
                              setAffected(r.affectedRecipes)
                              await qc.invalidateQueries({ queryKey: ['tariffs'] })
                              qc.invalidateQueries({ queryKey: ['recipes'] })
                            } catch (e) {
                              toast(errorMessage(e), 'err')
                            }
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
          )}
        </div>
        <Bills t={t} />
        <div className="card">
          <div className="card-head">
            <h2>Strumenti collegati</h2>
          </div>
          {t.equipment.length === 0 ? (
            <div className="card-body muted">Nessuno strumento usa questa tariffa.</div>
          ) : (
            <div className="card-body row wrap">
              {t.equipment.map((e) => (
                <Link key={e.id} className="badge" href={`/strumenti/${e.id}`}>
                  {e.name}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function NewVersion({ t, onDone }: { t: Detail; onDone: (r: AffectedRecipe[]) => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [mode, setMode] = useState<'direct' | 'bill'>('direct')
  const [validFrom, setValidFrom] = useState(todayIso())
  const [price, setPrice] = useState<string | null>(null)
  const [m3ToSmc, setM3ToSmc] = useState<string | null>(t.current?.m3_to_smc ?? null)
  const [smcToKwh, setSmcToKwh] = useState<string | null>(t.current?.smc_to_kwh ?? null)
  const [bill, setBill] = useState({ periodFrom: '', periodTo: '', consumption: null as string | null })
  const [comps, setComps] = useState<BillComponent[]>([
    { label: 'Spesa per la materia (energia)', amount: null, kind: 'variable', include: true },
    { label: 'Trasporto e oneri variabili', amount: null, kind: 'variable', include: true },
    { label: 'Quote fisse e potenza', amount: null, kind: 'fixed', include: false },
  ])
  const [preview, setPreview] = useState<{ pricePerUnit: string; variableOnlyPricePerUnit: string; includesFixed: boolean } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  // NUOVO: bolletta caricata e letta automaticamente
  const fileRef = useRef<HTMLInputElement>(null)
  const bills = useQuery({ queryKey: ['tariffs', 'bills', t.id], queryFn: () => api.get<BillsResponse>(`/tariffs/${t.id}/bills`) })
  const localReader = bills.data?.meta.reader === 'local'
  const [reading, setReading] = useState(false)
  const [read, setRead] = useState<BillRead | null>(null)
  const u = unitLabel(t.unit)

  const uploadBill = async (file: File) => {
    setReading(true)
    setRead(null)
    setErrors({})
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await api.upload<BillRead>(`/tariffs/${t.id}/bills`, fd)
      setRead(r)
      setMode('bill')
      if (r.form) {
        const f = r.form
        if (f.validFrom) setValidFrom(f.validFrom)
        setBill({ periodFrom: f.periodFrom ?? '', periodTo: f.periodTo ?? '', consumption: f.consumption })
        if (f.components.length) setComps(f.components)
        if (t.kind === 'gas') {
          if (f.m3ToSmc) setM3ToSmc(f.m3ToSmc)
          if (f.smcToKwh) setSmcToKwh(f.smcToKwh)
        }
      }
      qc.invalidateQueries({ queryKey: ['tariffs', 'bills', t.id] })
    } catch (e) {
      toast(errorMessage(e), 'err')
    } finally {
      setReading(false)
    }
  }

  const billBody = {
    mode: 'bill',
    validFrom,
    periodFrom: bill.periodFrom,
    periodTo: bill.periodTo,
    consumption: bill.consumption ?? '',
    consumptionUnit: t.unit,
    vatBasis: 'net',
    components: comps.filter((c) => c.amount !== null && c.label.trim()).map((c) => ({ ...c, amount: c.amount! })),
  }
  useEffect(() => {
    if (mode !== 'bill' || !bill.consumption || !billBody.components.some((c) => c.include)) return setPreview(null)
    const ctl = setTimeout(() => {
      api
        .post<{ pricePerUnit: string; variableOnlyPricePerUnit: string; includesFixed: boolean }>('/tariffs/bill-preview', { ...billBody, periodFrom: bill.periodFrom || validFrom, periodTo: bill.periodTo || validFrom })
        .then(setPreview)
        .catch(() => setPreview(null))
    }, 250)
    return () => clearTimeout(ctl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, JSON.stringify(billBody)])

  const submit = async () => {
    setBusy(true)
    setErrors({})
    try {
      const conv = t.kind === 'gas' ? { m3ToSmc, smcToKwh } : {}
      const body = mode === 'direct' ? { mode, validFrom, pricePerUnit: price ?? '', ...conv } : { ...billBody, ...conv, ...(read ? { billFileId: read.id } : {}) }
      const r = await api.post<{ affectedRecipes: AffectedRecipe[] }>(`/tariffs/${t.id}/versions`, body)
      onDone(r.affectedRecipes)
      toast('Nuovo valore registrato. I valori precedenti restano nello storico.')
      setPrice(null)
      setRead(null)
      await qc.invalidateQueries({ queryKey: ['tariffs'] })
      qc.invalidateQueries({ queryKey: ['recipes'] })
    } catch (e) {
      setErrors(fieldErrors(e))
      toast(errorMessage(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Nuovo valore della tariffa</h2>
      </div>
      <div className="card-body stack">
        <div className="alert info" style={{ alignItems: 'center' }}>
          <Icon name="upload" />
          <div className="grow">
            <strong>Hai la bolletta?</strong>{' '}
            {localReader
              ? 'Carica il PDF scaricato dall’area clienti del fornitore: leggiamo periodo, consumi e voci di costo. Le foto vengono archiviate ma i dati vanno inseriti a mano.'
              : 'Caricala in PDF o come foto: leggiamo noi periodo, consumi e voci di costo.'}{' '}
            Tu controlli e confermi; la bolletta resta nell’archivio.
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void uploadBill(f)
              e.target.value = ''
            }}
          />
          <button className="btn primary" disabled={reading} onClick={() => fileRef.current?.click()}>
            {reading ? <span className="spinner" /> : <Icon name="upload" />} {reading ? 'Lettura in corso…' : 'Carica bolletta'}
          </button>
        </div>
        {reading ? <div className="muted small">Sto leggendo la bolletta{localReader ? '…' : ': può richiedere fino a 40 secondi.'}</div> : null}
        {read ? (
          <div className={`alert ${read.readStatus === 'ok' ? 'ok' : 'warn'}`}>
            <Icon name={read.readStatus === 'ok' ? 'check' : 'alert'} />
            <div>
              <div>
                <strong>{read.message}</strong>
              </div>
              {read.info && (read.info.supplier || read.info.totalAmount) ? (
                <div className="small">
                  {[read.info.supplier, read.info.billNumber ? `fattura ${read.info.billNumber}` : null, read.info.issueDate ? `del ${date(read.info.issueDate)}` : null, read.info.totalAmount ? `totale ${euro(read.info.totalAmount)} IVA inclusa` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              ) : null}
              {read.found ? (
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }} aria-label="Dati trovati nella bolletta">
                  {read.found.map((x) => (
                    <span key={x.label} className={`badge ${x.ok ? 'ok' : 'warn'}`} title={x.ok ? 'Trovato: controlla che sia giusto' : 'Non trovato: inseriscilo a mano'}>
                      {x.ok ? '✓' : '✗'} {x.label}
                      {x.ok && x.value && x.label === 'Voci di costo' ? ` (${x.value})` : ''}
                    </span>
                  ))}
                </div>
              ) : null}
              {read.warnings.length ? (
                <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {read.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
              {read.form ? <div className="small faint" style={{ marginTop: 4 }}>Le quote fisse sono proposte escluse: le trovi già nei costi fissi della pagina Redditività. Spunta «Includi» se vuoi la tariffa “tutto compreso”.</div> : null}
            </div>
          </div>
        ) : null}
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'direct'} onClick={() => setMode('direct')}>
            Conosco il prezzo unitario
          </button>
          <button role="tab" aria-selected={mode === 'bill'} onClick={() => setMode('bill')}>
            Calcola da una bolletta
          </button>
        </div>
        <div className="grid-3">
          <Field label="Valido dal" htmlFor="v-vf" required error={errors.validFrom}>
            <input id="v-vf" type="date" className="input" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          </Field>
          {mode === 'direct' ? (
            <Field label="Prezzo unitario (netto IVA)" htmlFor="v-price" required error={errors.pricePerUnit}>
              <NumberInput id="v-price" value={price} onChange={setPrice} suffix={`€/${u}`} invalid={!!errors.pricePerUnit} />
            </Field>
          ) : null}
        </div>
        {mode === 'bill' ? (
          <>
            <div className="grid-3">
              <Field label="Periodo dal" htmlFor="b-from" required error={errors.periodFrom}>
                <input id="b-from" type="date" className="input" value={bill.periodFrom} onChange={(e) => setBill({ ...bill, periodFrom: e.target.value })} />
              </Field>
              <Field label="al" htmlFor="b-to" required error={errors.periodTo}>
                <input id="b-to" type="date" className="input" value={bill.periodTo} onChange={(e) => setBill({ ...bill, periodTo: e.target.value })} />
              </Field>
              <Field label="Consumo del periodo" htmlFor="b-cons" required error={errors.consumption}>
                <NumberInput id="b-cons" value={bill.consumption} onChange={(x) => setBill({ ...bill, consumption: x })} suffix={u} />
              </Field>
            </div>
            <div className="stack tight">
              <div className="label">Voci di costo (importi netti IVA)</div>
              {comps.map((c, i) => (
                <div key={i} className="row wrap">
                  <input className="input grow" style={{ minWidth: 180 }} value={c.label} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Descrizione voce" />
                  <div style={{ width: 140 }}>
                    <NumberInput value={c.amount} onChange={(x) => setComps(comps.map((y, j) => (j === i ? { ...y, amount: x } : y)))} suffix="€" ariaLabel="Importo" />
                  </div>
                  <select className="input" style={{ width: 130 }} value={c.kind} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, kind: e.target.value as 'variable' | 'fixed' } : x)))} aria-label="Tipo voce">
                    <option value="variable">Variabile</option>
                    <option value="fixed">Quota fissa</option>
                  </select>
                  <label className="checkbox">
                    <input type="checkbox" checked={c.include} onChange={(e) => setComps(comps.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} /> Includi
                  </label>
                  <button className="btn ghost icon sm" onClick={() => setComps(comps.filter((_, j) => j !== i))} aria-label="Rimuovi voce">
                    <Icon name="x" />
                  </button>
                </div>
              ))}
              <div>
                <button className="btn sm" onClick={() => setComps([...comps, { label: '', amount: null, kind: 'variable', include: true }])}>
                  <Icon name="plus" /> Aggiungi voce
                </button>
              </div>
            </div>
            {comps.some((c) => c.kind === 'fixed' && c.include) ? (
              <div className="alert warn">
                <Icon name="alert" />
                <div>Stai includendo quote fisse nella tariffa media: non imputarle di nuovo altrove (per esempio come costi generali), altrimenti verrebbero conteggiate due volte.</div>
              </div>
            ) : null}
            {preview ? (
              <div className="alert info">
                <div>
                  Tariffa media del periodo: <strong>{euro(preview.pricePerUnit, 5)}/{u}</strong>
                  {preview.includesFixed ? <> (solo componente variabile: {euro(preview.variableOnlyPricePerUnit, 5)}/{u})</> : null}. È la media delle voci selezionate sul consumo indicato.
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {t.kind === 'gas' ? (
          <div className="grid-3">
            <Field label="Coefficiente m³ → Smc" htmlFor="v-m3" hint="Dalla bolletta; serve se tariffa e consumi usano unità diverse">
              <NumberInput id="v-m3" value={m3ToSmc} onChange={setM3ToSmc} />
            </Field>
            <Field label="Potere calorifico kWh/Smc" htmlFor="v-pcs" hint="Serve per convertire gas in kWh">
              <NumberInput id="v-pcs" value={smcToKwh} onChange={setSmcToKwh} />
            </Field>
          </div>
        ) : null}
        <div>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? <span className="spinner" /> : null} {read && mode === 'bill' ? 'Conferma e registra valore' : 'Registra valore'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** NUOVO — archivio delle bollette caricate per questa utenza. */
function Bills({ t }: { t: Detail }) {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['tariffs', 'bills', t.id], queryFn: () => api.get<BillsResponse>(`/tariffs/${t.id}/bills`) })
  const u = unitLabel(t.unit)
  const fileUrl = (b: BillRow, download = false) => `/api/tariffs/${t.id}/bills/${b.id}/file${download ? '?download=1' : ''}`
  return (
    <div className="card">
      <div className="card-head">
        <h2>Bollette caricate</h2>
        {q.data?.meta.reader === 'local' ? <span className="badge">lettura automatica: solo PDF digitali</span> : null}
      </div>
      {q.error ? (
        <div className="card-body">
          <ErrorBox error={q.error} retry={() => q.refetch()} />
        </div>
      ) : !q.data ? (
        <div className="card-body">
          <Skeleton rows={2} />
        </div>
      ) : q.data.data.length === 0 ? (
        <div className="card-body muted">Nessuna bolletta caricata. Usa «Carica bolletta» qui sopra: il file resta archiviato e consultabile in ogni momento.</div>
      ) : (
        <table className="table compact">
          <thead>
            <tr>
              <th>Periodo</th>
              <th>Fornitore</th>
              <th className="num">Totale IVA incl.</th>
              <th>Valore generato</th>
              <th>Caricata</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.data.map((b) => (
              <tr key={b.id}>
                <td>{b.periodFrom && b.periodTo ? `${date(b.periodFrom)}–${date(b.periodTo)}` : <span className="faint">—</span>}</td>
                <td>
                  {b.supplier ?? <span className="faint">—</span>}
                  <div className="faint small" title={b.fileName} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.fileName}
                  </div>
                </td>
                <td className="num">{b.totalAmount ? euro(b.totalAmount) : '—'}</td>
                <td className="small">
                  {b.version ? (
                    <>
                      {euro(b.version.pricePerUnit, 5)}/{u} dal {date(b.version.validFrom)}
                    </>
                  ) : (
                    <span className="faint">non usata per un valore</span>
                  )}
                </td>
                <td className="faint small">
                  {dateTime(b.createdAt)} {b.createdBy ? `· ${b.createdBy}` : ''}
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  <a className="btn ghost icon sm" href={fileUrl(b)} target="_blank" rel="noopener" aria-label="Apri bolletta" title="Apri">
                    <Icon name="eye" />
                  </a>
                  <a className="btn ghost icon sm" href={fileUrl(b, true)} aria-label="Scarica bolletta" title="Scarica">
                    <Icon name="download" />
                  </a>
                  {can('tariffs.manage') ? (
                    <button
                      className="btn ghost icon sm"
                      aria-label="Elimina bolletta"
                      title="Elimina il file dall’archivio"
                      onClick={async () => {
                        if (!window.confirm(`Eliminare definitivamente il file «${b.fileName}» dall’archivio? Il valore della tariffa eventualmente generato resta.`)) return
                        try {
                          await api.del(`/tariffs/${t.id}/bills/${b.id}`)
                          qc.invalidateQueries({ queryKey: ['tariffs', 'bills', t.id] })
                        } catch (e) {
                          toast(errorMessage(e), 'err')
                        }
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
