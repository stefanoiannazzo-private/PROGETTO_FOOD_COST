'use client'

/**
 * NUOVO — Storico prezzi del prodotto: andamento del prezzo normalizzato (al kg / litro / pezzo),
 * minimo, massimo e media, variazione rispetto al prezzo precedente, fornitore e fattura di provenienza.
 */
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { date, dateTime, euro, euroPer, num } from '@/lib/num'
import { Icon } from './ui'

export interface HistoryPrice {
  id: string
  package_price: string
  package_content: string
  package_unit: string
  valid_from: string
  source: string | null
  supplier: string | null
  agent_name: string | null
  created_at: string
  created_by: string | null
  import_id: string | null
  supplier_invoice_id?: string | null
  unitPrice: string
  baseUnit: string
  future: boolean
}

const unitWord = (u: string) => (u === 'l' ? 'litro' : u === 'pz' ? 'pezzo' : 'kg')
const pctText = (p: number) => `${p >= 0 ? '+' : '−'}${Math.abs(p).toLocaleString('it-IT', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`

export function PriceHistory({ prices, currentId, onDelete }: { prices: HistoryPrice[]; currentId: string | null; onDelete?: (p: HistoryPrice) => void }) {
  const suppliers = useMemo(() => [...new Set(prices.map((p) => p.supplier ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it')), [prices])
  const [supplier, setSupplier] = useState('')
  const list = supplier ? prices.filter((p) => p.supplier === supplier) : prices
  // dal più vecchio al più recente, per variazioni e grafico
  const asc = [...list].sort((a, b) => a.valid_from.localeCompare(b.valid_from))
  const past = asc.filter((p) => !p.future)
  const prevOf = new Map<string, HistoryPrice | undefined>(asc.map((p, i) => [p.id, asc[i - 1]]))
  const unit = prices[0]?.baseUnit ?? 'kg'
  const vals = past.map((p) => Number(p.unitPrice))
  const stats = vals.length
    ? {
        first: vals[0]!,
        last: vals[vals.length - 1]!,
        min: Math.min(...vals),
        max: Math.max(...vals),
        avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      }
    : null

  if (!prices.length) return null
  return (
    <div className="stack">
      <div className="row wrap between">
        <h3 className="ph-title">Storico prezzi</h3>
        {suppliers.length > 1 ? (
          <select className="input" style={{ width: 'auto' }} value={supplier} onChange={(e) => setSupplier(e.target.value)} aria-label="Fornitore">
            <option value="">Tutti i fornitori ({suppliers.length})</option>
            {suppliers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {stats && past.length > 1 ? (
        <div className="ph-stats">
          <div>
            <span className="faint small">Variazione dal primo prezzo</span>
            <strong>{stats.first ? pctText(((stats.last - stats.first) / stats.first) * 100) : '—'}</strong>
          </div>
          <div>
            <span className="faint small">Minimo</span>
            <strong>{euroPer(String(stats.min), unit, 2)}</strong>
          </div>
          <div>
            <span className="faint small">Massimo</span>
            <strong>{euroPer(String(stats.max), unit, 2)}</strong>
          </div>
          <div>
            <span className="faint small">Media</span>
            <strong>{euroPer(String(stats.avg), unit, 2)}</strong>
          </div>
        </div>
      ) : null}

      {past.length > 1 ? <StepChart points={past} unit={unit} /> : null}

      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Valido dal</th>
              <th>Fornitore</th>
              <th className="num">Prezzo al {unitWord(unit)}</th>
              <th className="num">Variazione</th>
              <th className="num">Confezione</th>
              <th>Fonte</th>
              <th>Inserito</th>
              {onDelete ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {[...asc].reverse().map((p) => {
              const prev = prevOf.get(p.id)
              const d = prev && Number(prev.unitPrice) ? ((Number(p.unitPrice) - Number(prev.unitPrice)) / Number(prev.unitPrice)) * 100 : null
              return (
                <tr key={p.id}>
                  <td>
                    {date(p.valid_from)} {p.future ? <span className="badge info">futuro</span> : currentId === p.id ? <span className="badge ok">corrente</span> : null}
                  </td>
                  <td>
                    {p.supplier ?? <span className="faint">—</span>}
                    {p.agent_name ? <div className="faint small">agente: {p.agent_name}</div> : null}
                  </td>
                  <td className="num">
                    <strong>{euroPer(p.unitPrice, p.baseUnit, 4)}</strong>
                  </td>
                  <td className="num">{d === null ? <span className="faint">—</span> : Math.abs(d) < 0.05 ? <span className="faint">=</span> : <span className={d > 0 ? 'ph-up' : 'ph-down'}>{pctText(d)}</span>}</td>
                  <td className="num">
                    {euro(p.package_price)}
                    <div className="faint small">
                      per {num(p.package_content)} {p.package_unit}
                    </div>
                  </td>
                  <td>
                    {p.supplier_invoice_id ? (
                      <Link className="link" href={`/importazioni/fatture/${p.supplier_invoice_id}`}>
                        {p.source ?? 'Fattura'}
                      </Link>
                    ) : (
                      (p.source ?? (p.import_id ? 'Importazione Excel' : '—'))
                    )}
                  </td>
                  <td className="faint small">
                    {dateTime(p.created_at)} {p.created_by ? `· ${p.created_by}` : ''}
                  </td>
                  {onDelete ? (
                    <td className="num">
                      <button className="btn ghost icon sm" aria-label="Elimina prezzo" onClick={() => onDelete(p)}>
                        <Icon name="trash" />
                      </button>
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Grafico a gradini: il prezzo resta valido fino al successivo. Un'unica serie, nessuna legenda; tooltip al passaggio. */
function StepChart({ points, unit }: { points: HistoryPrice[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null)
  // disegnato alla larghezza reale del contenitore: testi sempre a 11 px, su computer e telefono
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(640)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(260, Math.round(el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const H = W < 480 ? 150 : 180
  const pad = { l: 56, r: 16, t: 12, b: 26 }
  const today = new Date().toISOString().slice(0, 10)
  const t = (d: string) => new Date(d + 'T00:00:00Z').getTime()
  const xs = points.map((p) => t(p.valid_from))
  const x0 = xs[0]!
  const x1 = Math.max(t(today), xs[xs.length - 1]! + 86400000)
  const ys = points.map((p) => Number(p.unitPrice))
  let lo = Math.min(...ys)
  let hi = Math.max(...ys)
  if (hi - lo < hi * 0.05) {
    lo = lo * 0.95
    hi = hi * 1.05
  }
  const span = hi - lo || 1
  lo = Math.max(0, lo - span * 0.15)
  hi = hi + span * 0.15
  const X = (v: number) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r)
  const Y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b)
  let d = ''
  points.forEach((p, i) => {
    const x = X(xs[i]!)
    const y = Y(ys[i]!)
    d += i === 0 ? `M${x},${y}` : `H${x}V${y}`
  })
  d += `H${X(x1)}`
  const ticks = [lo, (lo + hi) / 2, hi]
  const h = hover !== null ? points[hover] : null
  return (
    <div className="ph-chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Andamento del prezzo al ${unitWord(unit)}`}>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} className="ph-grid" />
            <text x={pad.l - 8} y={Y(v) + 4} textAnchor="end" className="ph-axis">
              {euro(v, 2)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 6} className="ph-axis">
          {date(points[0]!.valid_from)}
        </text>
        <text x={W - pad.r} y={H - 6} textAnchor="end" className="ph-axis">
          oggi
        </text>
        <path d={d} className="ph-line" />
        {points.map((p, i) => (
          <g key={p.id}>
            <circle cx={X(xs[i]!)} cy={Y(ys[i]!)} r={hover === i ? 6 : 4.5} className="ph-dot" />
            {/* area di aggancio più grande del punto */}
            <rect
              x={X(xs[i]!) - 14}
              y={pad.t}
              width={28}
              height={H - pad.t - pad.b}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onTouchStart={() => setHover(i)}
              onFocus={() => setHover(i)}
              tabIndex={0}
              aria-label={`${date(p.valid_from)}: ${euro(p.unitPrice, 2)} al ${unitWord(unit)}`}
            />
          </g>
        ))}
        {h && hover !== null ? <line x1={X(xs[hover]!)} x2={X(xs[hover]!)} y1={pad.t} y2={H - pad.b} className="ph-cross" /> : null}
      </svg>
      {h && hover !== null ? (
        <div className="ph-tip" style={{ left: `${(X(xs[hover]!) / W) * 100}%` }}>
          <strong>{euroPer(h.unitPrice, h.baseUnit, 2)}</strong>
          <span>dal {date(h.valid_from)}</span>
          {h.supplier ? <span>{h.supplier}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
