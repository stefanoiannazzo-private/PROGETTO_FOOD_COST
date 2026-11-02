'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { d } from '@foodcost/domain'
import { api } from '@/lib/api'
import type { RecipeCost, SubrecipeLine } from '@/lib/cost-types'
import { SEGMENT_LABEL } from '@/lib/labels'
import { date, dateTime, euro, euroPer, minutes, num, percent, todayIso, unitLabel } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { CostSummary } from '@/components/CostSummary'
import { Confirm, ErrorBox, errorMessage, Icon, Skeleton, StatusBadge, useToast } from '@/components/ui'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Detail {
  id: string
  code: string
  title: string
  category: string | null
  description: string | null
  status: string
  lockVersion: number
  updatedAt: string
  revision: any
  valuation: RecipeCost | null
  valuationDate: string
  comparison: {
    snapshotId: string
    snapshotCreatedAt: string
    snapshotDate: string
    snapshotLabel: string | null
    snapshotTotal: string
    currentTotal: string
    deltaTotal: string
    deltaPercent: string | null
    deltaPerKg: string | null
    deltaPerPortion: string | null
    reasons: string[]
  } | null
  snapshots: Array<{ id: string; created_at: string; valuation_date: string; label: string | null; total: string; cost_per_kg: string | null; cost_per_portion: string | null; complete: boolean; created_by: string | null; revision_number: number }>
  usedBy: Array<{ id: string; code: string; title: string; status: string }>
  permissions: { canEdit: boolean; costsVisible: boolean; salariesVisible: boolean; canSnapshot: boolean }
}

export default function RecipeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const [valDate, setValDate] = useState(todayIso())
  const [confirm, setConfirm] = useState<null | 'archive' | 'snapshot' | 'delete'>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const q = useQuery({
    queryKey: ['recipes', id, valDate],
    queryFn: () => api.get<Detail>(`/recipes/${id}`, valDate === todayIso() ? {} : { date: valDate }),
    placeholderData: keepPreviousData,
  })
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data) return <Skeleton rows={10} />
  const r = q.data
  const v = r.valuation
  const rev = r.revision
  const phaseName = (pid: string | null) => rev?.phases.find((p: any) => p.key === pid)?.name ?? null

  const action = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      toast(ok)
      await qc.invalidateQueries({ queryKey: ['recipes'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (e) {
      toast(errorMessage(e), 'err')
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  return (
    <>
      <PageHead
        title={r.title}
        sub={
          <span className="row wrap">
            <span className="mono">{r.code}</span>
            <StatusBadge status={r.status} />
            {r.category ? <span className="badge">{r.category}</span> : null}
            <span className="faint small">
              revisione {rev?.number ?? '—'} · aggiornata {dateTime(r.updatedAt)}
            </span>
          </span>
        }
        actions={
          <>
            {r.permissions.canEdit && r.status !== 'archived' ? (
              <Link className="btn primary" href={`/ricette/${id}/modifica`} prefetch>
                <Icon name="edit" /> Modifica
              </Link>
            ) : null}
            {r.permissions.canSnapshot && v ? (
              <button className="btn" onClick={() => setConfirm('snapshot')}>
                <Icon name="camera" /> Salva snapshot
              </button>
            ) : null}
            {r.permissions.canEdit ? (
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    const d = await api.post<{ id: string }>(`/recipes/${id}/duplicate`)
                    router.push(`/ricette/${d.id}/modifica`)
                  }, 'Ricetta duplicata: stai modificando la copia.')
                }
              >
                <Icon name="copy" /> Duplica
              </button>
            ) : null}
            {r.permissions.canEdit ? (
              r.status === 'archived' ? (
                <button className="btn" onClick={() => action(() => api.post(`/recipes/${id}/restore`), 'Ricetta ripristinata come bozza.').then(() => q.refetch())}>
                  Ripristina
                </button>
              ) : (
                <button className="btn" onClick={() => setConfirm('archive')}>
                  <Icon name="archive" /> Archivia
                </button>
              )
            ) : null}
          </>
        }
      />

      <div className="editor">
        <div className="stack loose">
          {r.description ? <p className="muted">{r.description}</p> : null}

          {r.comparison ? (
            <div className={`alert ${Number(r.comparison.deltaTotal) > 0 ? 'warn' : Number(r.comparison.deltaTotal) < 0 ? 'ok' : 'info'}`}>
              <Icon name="layers" />
              <div className="grow">
                <strong>Rispetto all’ultimo snapshot</strong> ({r.comparison.snapshotLabel ? `“${r.comparison.snapshotLabel}”, ` : ''}
                {dateTime(r.comparison.snapshotCreatedAt)}): {euro(r.comparison.snapshotTotal)} → {euro(r.comparison.currentTotal)} ({Number(r.comparison.deltaTotal) >= 0 ? '+' : ''}
                {euro(r.comparison.deltaTotal)}
                {r.comparison.deltaPercent ? `, ${Number(r.comparison.deltaPercent) >= 0 ? '+' : ''}${num(r.comparison.deltaPercent, 1)}%` : ''})
                {r.comparison.deltaPerKg ? ` · al kg ${Number(r.comparison.deltaPerKg) >= 0 ? '+' : ''}${euro(r.comparison.deltaPerKg)}` : ''}
                {r.comparison.reasons.length ? (
                  <ul>
                    {r.comparison.reasons.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* resa */}
          <div className="kpis">
            <div className="kpi">
              <div className="k-label">Resa finale</div>
              <div className="k-value">{rev?.finalQuantity ? `${num(rev.finalQuantity)} ${rev.finalUnit}` : '—'}</div>
              <div className="k-sub">{rev?.finalWeightKg ? `peso netto ${num(rev.finalWeightKg)} kg` : 'peso finale non dichiarato'}</div>
            </div>
            <div className="kpi">
              <div className="k-label">Porzioni</div>
              <div className="k-value">{rev?.portions ? num(rev.portions) : '—'}</div>
              <div className="k-sub">{rev?.finalWeightKg && rev?.portions ? `${num((Number(rev.finalWeightKg) / Number(rev.portions)) * 1000, 0)} g a porzione` : ''}</div>
            </div>
            <div className="kpi">
              <div className="k-label">Durata dichiarata</div>
              <div className="k-value">{rev?.declaredDurationMinutes ? minutes(rev.declaredDurationMinutes) : '—'}</div>
              <div className="k-sub">
                macchina {minutes(v?.machineMinutes ?? null)} · persone {minutes(v?.personMinutes ?? null)}
              </div>
            </div>
          </div>

          {/* composizione */}
          <div className="card">
            <div className="card-head">
              <h2>Composizione</h2>
              {v ? <span className="faint small">valorizzata al {date(v.date)}</span> : null}
            </div>
            {rev?.components.length ? (
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Componente</th>
                      <th className="num">Quantità netta</th>
                      {v ? (
                        <>
                          <th className="num">Acquistato equiv.</th>
                          <th className="num">Prezzo unitario</th>
                          <th className="num">Costo</th>
                          <th className="num">%</th>
                        </>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rev.components.map((c: any, i: number) => {
                      const line = v ? (c.kind === 'ingredient' ? v.ingredientLines.find((l) => l.componentId === c.id) : v.subrecipeLines.find((l) => l.componentId === c.id)) : null
                      return c.kind === 'recipe' ? (
                        <SubRow key={c.id} c={c} line={line as SubrecipeLine | undefined} total={v?.total ?? null} />
                      ) : (
                        <tr key={c.id}>
                          <td>
                            <Link className="link" href={`/ingredienti/${c.ingredientId}`}>
                              {c.ref.name}
                            </Link>{' '}
                            <span className="faint small mono">{c.ref.code}</span>
                            {c.ref.archived ? <span className="badge warn"> archiviato</span> : null}
                          </td>
                          <td className="num">{c.quantity ? `${num(c.quantity)} ${c.unit}` : <span className="badge err">mancante</span>}</td>
                          {v && line && 'grossBaseQuantity' in line ? (
                            <>
                              <td className="num small">
                                {line.grossBaseQuantity && line.edibleYield !== '1' ? `${num(line.grossBaseQuantity, 3)} ${line.baseUnit} (resa ${percent(Number(line.edibleYield) * 100, 0)})` : '—'}
                              </td>
                              <td className="num">{line.unitPrice ? euroPer(line.unitPrice, line.baseUnit, 4) : <span className="badge err">mancante</span>}</td>
                              <td className="num">{euro(line.cost)}</td>
                              <td className="num faint">{line.cost && Number(v.total) > 0 ? `${num((Number(line.cost) / Number(v.total)) * 100, 1)}%` : ''}</td>
                            </>
                          ) : v ? (
                            <td colSpan={4} />
                          ) : null}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card-body muted">Nessun componente.</div>
            )}
          </div>

          {/* fasi, strumenti e manodopera */}
          <div className="card">
            <div className="card-head">
              <h2>Fasi, strumenti e manodopera</h2>
            </div>
            <div className="card-body stack">
              {rev?.phases.length ? (
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {rev.phases.map((p: any) => (
                    <li key={p.key}>
                      <strong>{p.name}</strong>
                      {p.description ? <span className="muted"> — {p.description}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              {rev?.equipmentUses.length ? (
                <div className="table-wrap">
                  <table className="table compact">
                    <thead>
                      <tr>
                        <th>Strumento</th>
                        <th>Fase / segmento</th>
                        <th className="num">Minuti</th>
                        <th className="num">Quota</th>
                        {v ? (
                          <>
                            <th>Consumo</th>
                            <th className="num">Costo</th>
                          </>
                        ) : null}
                      </tr>
                    </thead>
                    <tbody>
                      {rev.equipmentUses.map((u: any) => {
                        const line = v?.equipmentLines.find((l) => l.useId === u.id)
                        return (
                          <tr key={u.id}>
                            <td>
                              <Link className="link" href={`/strumenti/${u.equipmentId}`}>
                                {u.ref.name}
                              </Link>
                            </td>
                            <td className="small">
                              {phaseName(u.phaseKey) ? `${phaseName(u.phaseKey)} · ` : ''}
                              {SEGMENT_LABEL[u.segment]}
                            </td>
                            <td className="num">{u.minutes ? num(u.minutes) : <span className="badge err">mancante</span>}</td>
                            <td className="num">{percent(u.sharePercent, 1)}</td>
                            {v ? (
                              <>
                                <td className="small">
                                  {line?.manual
                                    ? 'manuale'
                                    : line?.sources.map((s, k) => (
                                        <div key={k}>
                                          {s.consumption ? `${num(s.consumption, 3)} ${unitLabel(s.consumptionUnit)}` : '—'} {s.estimated ? <span className="faint">stimato{s.coefficient ? ` (coeff. ${num(s.coefficient, 2)})` : ''}</span> : <span className="badge info">misurato</span>}
                                          {s.tariffPrice ? <span className="faint"> × {euro(s.tariffPrice, 4)}/{unitLabel(s.tariffUnit)}</span> : null}
                                        </div>
                                      ))}
                                </td>
                                <td className="num">{euro(line?.cost)}</td>
                              </>
                            ) : null}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted small">Nessuno strumento associato.</p>
              )}
              {rev?.labor.length ? (
                <div className="table-wrap">
                  <table className="table compact">
                    <thead>
                      <tr>
                        <th>Dipendente</th>
                        <th>Fase</th>
                        <th className="num">Minuti attivi</th>
                        <th className="num">Quota</th>
                        {v && r.permissions.salariesVisible ? <th className="num">Costo</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {rev.labor.map((a: any) => {
                        const line = v?.laborLines.find((l) => l.assignmentId === a.id)
                        return (
                          <tr key={a.id}>
                            <td>
                              {a.ref.name} <span className="faint small">{a.ref.jobTitle ?? ''}</span>
                              {line?.basis === 'gross_only' && r.permissions.salariesVisible ? <span className="badge warn"> solo lordo</span> : null}
                            </td>
                            <td className="small">{phaseName(a.phaseKey) ?? '—'}</td>
                            <td className="num">{a.activeMinutes ? num(a.activeMinutes) : <span className="badge err">mancante</span>}</td>
                            <td className="num">{percent(a.sharePercent, 1)}</td>
                            {v && r.permissions.salariesVisible ? <td className="num">{euro(line?.cost)}</td> : null}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted small">Nessuna manodopera associata.</p>
              )}
            </div>
          </div>

          {rev?.instructions ? (
            <div className="card">
              <div className="card-head">
                <h2>Istruzioni</h2>
              </div>
              <div className="card-body" style={{ whiteSpace: 'pre-wrap' }}>
                {rev.instructions}
              </div>
            </div>
          ) : null}

          {r.usedBy.length ? (
            <div className="card">
              <div className="card-head">
                <h2>Usata come semilavorato in</h2>
              </div>
              <div className="card-body row wrap">
                {r.usedBy.map((u) => (
                  <Link key={u.id} className="badge accent" href={`/ricette/${u.id}`}>
                    {u.title}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          {r.permissions.costsVisible ? (
            <div className="card">
              <div className="card-head">
                <h2>Snapshot di costo</h2>
                <span className="faint small">fotografie immutabili</span>
              </div>
              {r.snapshots.length === 0 ? (
                <div className="card-body muted">Nessuno snapshot. Salvane uno per fissare il costo attuale (es. per un listino).</div>
              ) : (
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Salvato</th>
                      <th>Etichetta</th>
                      <th>Data valorizzazione</th>
                      <th className="num">Rev.</th>
                      <th className="num">Totale</th>
                      <th className="num">€/kg</th>
                      <th className="num">€/porzione</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.snapshots.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link className="link" href={`/ricette/${id}/snapshot/${s.id}`}>
                            {dateTime(s.created_at)}
                          </Link>
                          <div className="faint small">{s.created_by}</div>
                        </td>
                        <td>{s.label ?? '—'}</td>
                        <td>{date(s.valuation_date)}</td>
                        <td className="num">{s.revision_number}</td>
                        <td className="num">
                          {euro(s.total)} {!s.complete ? <span className="badge err">incompleto</span> : null}
                        </td>
                        <td className="num">{euro(s.cost_per_kg)}</td>
                        <td className="num">{euro(s.cost_per_portion)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}
        </div>

        {v ? (
          <aside className="card summary-panel" data-open="true" style={{ transform: 'none', position: 'sticky' }}>
            <div className="card-head">
              <h2>Costi</h2>
              <input type="date" className="input" style={{ width: 150, height: 30 }} value={valDate} max="2100-12-31" onChange={(e) => e.target.value && setValDate(e.target.value)} aria-label="Data di valorizzazione" />
            </div>
            <div className="card-body">
              <CostSummary cost={v} stale={q.isFetching} />
            </div>
          </aside>
        ) : null}
      </div>

      {confirm === 'archive' ? (
        <Confirm
          title="Archiviare la ricetta?"
          message={r.usedBy.length ? `È usata come semilavorato in ${r.usedBy.map((u) => u.title).join(', ')}: quelle ricette continueranno a valorizzarla. Nessun dato viene cancellato.` : 'Non comparirà tra le ricette attive. Nessun dato, revisione o snapshot viene cancellato.'}
          confirmLabel="Archivia"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => action(() => api.post(`/recipes/${id}/archive`), 'Ricetta archiviata.')}
        />
      ) : null}
      {confirm === 'snapshot' && v ? (
        <Confirm
          title="Salvare uno snapshot di costo?"
          message={
            <div className="stack">
              <span>
                Fisserà il costo attuale ({euro(v.total)}
                {v.complete ? '' : ', incompleto'}) con prezzi, tariffe, costi del lavoro e composizione di tutte le sottoricette. Le modifiche future non lo altereranno.
              </span>
              <input className="input" placeholder="Etichetta (facoltativa), es. Listino 2027" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
          }
          confirmLabel="Salva snapshot"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => action(() => api.post(`/recipes/${id}/snapshots`, { label: label || undefined, expectedRevisionId: v.revisionId, date: valDate }), 'Snapshot salvato.')}
        />
      ) : null}
    </>
  )
}

/** Riga di un semilavorato con dettaglio espandibile della composizione interna (solo informativo). */
function SubRow({ c, line, total }: { c: any; line?: SubrecipeLine; total: string | null }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <tr>
        <td>
          <button className="btn ghost icon sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Mostra composizione del semilavorato">
            <Icon name={open ? 'down' : 'chevron'} />
          </button>
          <span className="badge accent">Ricetta</span>{' '}
          <Link className="link" href={`/ricette/${c.recipeId}`}>
            {c.ref.name}
          </Link>
        </td>
        <td className="num">{c.quantity ? `${num(c.quantity)} ${c.unit}` : <span className="badge err">mancante</span>}</td>
        {total !== null ? (
          <>
            <td className="num small faint">{line?.fraction ? `${num(Number(line.fraction) * 100, 1)}% del lotto` : ''}</td>
            <td className="num">{line?.unitCost ? `${euro(line.unitCost)}/${line.basis === 'weight' ? 'kg' : (line.sub?.finalUnit ?? '')}` : '—'}</td>
            <td className="num">{euro(line?.cost)}</td>
            <td className="num faint">{line?.cost && Number(total) > 0 ? `${num((Number(line.cost) / Number(total)) * 100, 1)}%` : ''}</td>
          </>
        ) : null}
      </tr>
      {open && line?.sub ? (
        <tr>
          <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
            <SubTree sub={line.sub} fraction={line.fraction} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

function SubTree({ sub, fraction }: { sub: RecipeCost; fraction: string | null }) {
  const f = d(fraction ?? 0)
  const part = (v: string | null) => (v ? euro(d(v).times(f).toFixed(), 3) : '—')
  return (
    <div className="tree small stack tight">
      <div className="faint">
        Dettaglio informativo di {sub.title} (rev. {sub.revisionNumber}), già compreso nel costo della riga: lotto {euro(sub.total)}, quota prelevata {num(f.times(100).toFixed(), 1)}%.
      </div>
      {sub.ingredientLines.map((l) => (
        <div key={l.componentId} className="row between">
          <span>{l.name}</span>
          <span>{part(l.cost)}</span>
        </div>
      ))}
      {sub.subrecipeLines.map((l) => (
        <details key={l.componentId}>
          <summary className="row between">
            <span>▸ {l.name}</span>
            <span>{part(l.cost)}</span>
          </summary>
          {l.sub ? <SubTree sub={l.sub} fraction={d(l.fraction ?? 0).times(f).toFixed()} /> : null}
        </details>
      ))}
      <div className="row between">
        <span>Energia</span>
        <span>{part(sub.energy)}</span>
      </div>
      <div className="row between">
        <span>Manodopera</span>
        <span>{part(sub.labor)}</span>
      </div>
    </div>
  )
}
