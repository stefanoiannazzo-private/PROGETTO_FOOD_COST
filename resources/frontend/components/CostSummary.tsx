'use client'

import type { RecipeCost } from '@/lib/cost-types'
import { euro, minutes, num } from '@/lib/num'

const pct = (part: string, total: string) => {
  const t = Number(total)
  return t > 0 ? (Number(part) / t) * 100 : 0
}

/**
 * Riepilogo del costo di produzione di un lotto.
 * Il totale comprende solo le voci configurate: se mancano dati non è presentato come definitivo.
 */
export function CostSummary({ cost, compact, stale }: { cost: RecipeCost; compact?: boolean; stale?: boolean }) {
  const parts = [
    { key: 'ing', label: 'Costo ingredienti', value: cost.directIngredients, cls: 'c-ing' },
    { key: 'sub', label: 'Semilavorati', value: cost.subrecipes, cls: 'c-sub' },
    { key: 'en', label: 'Energia', value: cost.energy, cls: 'c-en' },
    { key: 'lab', label: 'Manodopera', value: cost.labor, cls: 'c-lab' },
  ].filter((p) => p.key !== 'sub' || cost.subrecipeLines.length > 0)
  const errors = cost.issues.filter((i) => i.severity === 'error')
  const warnings = cost.issues.filter((i) => i.severity === 'warning')

  return (
    <div className="stack" style={{ opacity: stale ? 0.6 : 1, transition: 'opacity .15s' }}>
      <div>
        <div className="row between">
          <span className="faint small">{cost.complete ? 'Costo di produzione del lotto' : 'Subtotale delle voci valorizzate'}</span>
          {cost.complete ? <span className="badge ok">Completo</span> : <span className="badge err">Incompleto</span>}
        </div>
        <div className="big-number">{euro(cost.total)}</div>
        {!cost.complete ? <div className="small" style={{ color: 'var(--err)' }}>Non è il costo totale definitivo: mancano {errors.length} dati.</div> : null}
      </div>

      <div className="grid-2" style={{ gap: 8 }}>
        <div className="card card-pad" style={{ padding: 10 }}>
          <div className="faint small">Costo al kg</div>
          <div style={{ fontWeight: 650, fontSize: 17 }}>{cost.costPerKg ? euro(cost.costPerKg) : '—'}</div>
          <div className="faint small">{cost.finalWeightKg ? `resa ${num(cost.finalWeightKg)} kg` : 'peso finale non dichiarato'}</div>
        </div>
        <div className="card card-pad" style={{ padding: 10 }}>
          <div className="faint small">Costo a porzione</div>
          <div style={{ fontWeight: 650, fontSize: 17 }}>{cost.costPerPortion ? euro(cost.costPerPortion) : '—'}</div>
          <div className="faint small">{cost.portions ? `${num(cost.portions)} porzioni${cost.portionWeightKg ? ` da ${num(Number(cost.portionWeightKg) * 1000, 0)} g` : ''}` : 'porzioni non dichiarate'}</div>
        </div>
      </div>

      <div className="stack tight">
        <div className="costbar" aria-hidden="true">
          {parts.map((p) => (
            <span key={p.key} className={p.cls} style={{ width: `${pct(p.value, cost.total)}%` }} />
          ))}
        </div>
        {parts.map((p) => (
          <div key={p.key} className="sumline">
            <span className="row">
              <span className={`legend-dot ${p.cls}`} /> {p.label}
            </span>
            <span className="row">
              <span className="faint small">{cost.total !== '0' ? `${num(pct(p.value, cost.total), 1)}%` : ''}</span>
              <span style={{ minWidth: 76, textAlign: 'right' }}>{euro(p.value)}</span>
            </span>
          </div>
        ))}
        <div className="sumline total">
          <span>Costo di produzione</span>
          <span>{euro(cost.total)}</span>
        </div>
        {cost.subrecipeLines.length > 0 && !compact ? (
          <div className="small muted">
            Con i semilavorati espansi: ingredienti {euro(cost.expanded.ingredients)} · energia {euro(cost.expanded.energy)} · manodopera {euro(cost.expanded.labor)}
          </div>
        ) : null}
      </div>

      <div className="grid-3 small" style={{ gap: 6 }}>
        <div>
          <div className="faint">Minuti macchina</div>
          <div>{minutes(cost.machineMinutes)}</div>
        </div>
        <div>
          <div className="faint">Minuti-persona</div>
          <div>{minutes(cost.personMinutes)}</div>
        </div>
        <div>
          <div className="faint">Durata dichiarata</div>
          <div>{cost.declaredDurationMinutes ? minutes(cost.declaredDurationMinutes) : '—'}</div>
        </div>
      </div>

      {errors.length || warnings.length ? (
        <div className="stack tight">
          {errors.map((i, k) => (
            <div key={`e${k}`} className="alert err small" style={{ padding: '6px 10px' }}>
              <div>
                {i.message}
                {i.path.length > 1 ? <div className="faint">Percorso: {i.path.join(' → ')}</div> : null}
              </div>
            </div>
          ))}
          {!compact
            ? warnings.map((i, k) => (
                <div key={`w${k}`} className="alert warn small" style={{ padding: '6px 10px' }}>
                  <div>
                    {i.message}
                    {i.path.length > 1 ? <div className="faint">Percorso: {i.path.join(' → ')}</div> : null}
                  </div>
                </div>
              ))
            : null}
        </div>
      ) : null}
      <p className="faint small">Il costo di produzione comprende ingredienti, energia e manodopera configurati (netti IVA); non equivale al costo aziendale completo.</p>
    </div>
  )
}
