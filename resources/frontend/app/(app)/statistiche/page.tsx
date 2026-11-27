'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { euro, num } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { Empty, ErrorBox, Skeleton } from '@/components/ui'

/** NUOVO — Statistiche di vendita dall'area Ordini: incassi, coperti, piatti, margini, orari, camerieri, tempi. */
interface Stats {
  from: string
  to: string
  costsVisible: boolean
  kpis: {
    revenue: string
    tables: number
    covers: number
    perCover: string | null
    dishes: number
    margin: string | null
    marginPercent: string | null
    missingCostQty: number
    avgTableMinutes: number | null
    avgPrepMinutes: number | null
    openTables: number
  }
  items: Array<{ name: string; section: string | null; qty: number; revenue: string; margin: string | null; marginPerDish: string | null }>
  sections: Array<{ name: string; qty: number; revenue: string }>
  byHour: Array<{ hour: number; qty: number }>
  byWeekday: Array<{ day: string; covers: number; revenue: string }>
  byDay: Array<{ date: string; revenue: string }>
  waiters: Array<{ name: string; items: number; revenue: string; tables: number }>
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
function range(kind: string): [string, string] {
  const t = new Date()
  const day = (t.getDay() + 6) % 7 // lunedì = 0
  const add = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
  switch (kind) {
    case 'yesterday':
      return [iso(add(t, -1)), iso(add(t, -1))]
    case 'week':
      return [iso(add(t, -day)), iso(add(t, 6 - day))]
    case 'lastweek':
      return [iso(add(t, -day - 7)), iso(add(t, -day - 1))]
    case 'month':
      return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(new Date(t.getFullYear(), t.getMonth() + 1, 0))]
    case 'lastmonth':
      return [iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), iso(new Date(t.getFullYear(), t.getMonth(), 0))]
    default:
      return [iso(t), iso(t)]
  }
}
const PERIODS: Array<[string, string]> = [
  ['today', 'Oggi'],
  ['yesterday', 'Ieri'],
  ['week', 'Questa settimana'],
  ['lastweek', 'Settimana scorsa'],
  ['month', 'Questo mese'],
  ['lastmonth', 'Mese scorso'],
]

export default function SalesStatsPage() {
  const [period, setPeriod] = useState('week')
  const [custom, setCustom] = useState<[string, string]>(range('week'))
  const [from, to] = period === 'custom' ? custom : range(period)
  const q = useQuery({ queryKey: ['sales', from, to], queryFn: () => api.get<Stats>(`/sales/stats?from=${from}&to=${to}`), refetchInterval: 60_000 })
  const d = q.data

  return (
    <>
      <PageHead title="Statistiche vendite" sub="Tutto quello che è stato ordinato in sala: incassi, coperti, piatti più venduti e guadagno. Per il pareggio settimanale guarda Redditività." />
      <div className="row wrap" style={{ gap: 6, marginBottom: 14 }}>
        <div className="section-chips" style={{ padding: 0 }} role="tablist">
          {PERIODS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={period === k} onClick={() => setPeriod(k)}>
              {l}
            </button>
          ))}
          <button role="tab" aria-selected={period === 'custom'} onClick={() => setPeriod('custom')}>
            Date…
          </button>
        </div>
        {period === 'custom' ? (
          <span className="row" style={{ gap: 6 }}>
            <input type="date" className="input" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="Dal" />
            <input type="date" className="input" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="Al" />
          </span>
        ) : null}
      </div>
      {q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !d ? (
        <Skeleton rows={8} />
      ) : !d.kpis.dishes && !d.kpis.tables ? (
        <div className="card">
          <Empty title="Nessuna vendita nel periodo">
            Le statistiche si riempiono da sole quando i camerieri prendono le comande in «Sala».{d.kpis.openTables ? ` Ora ci sono ${d.kpis.openTables} tavoli aperti: contano quando si chiudono.` : ''}
          </Empty>
        </div>
      ) : (
        <div className="stack loose">
          <div className="kpis">
            <Kpi label="Incasso" value={euro(d.kpis.revenue)} sub={`${num(d.kpis.tables)} tavoli chiusi${d.kpis.openTables ? ` · ${d.kpis.openTables} aperti` : ''}`} />
            <Kpi label="Coperti" value={num(d.kpis.covers)} sub={d.kpis.perCover ? `${euro(d.kpis.perCover)} a coperto` : undefined} />
            <Kpi label="Piatti venduti" value={num(d.kpis.dishes)} />
            {d.costsVisible ? <Kpi label="Guadagno sui piatti" value={euro(d.kpis.margin)} sub={d.kpis.marginPercent ? `${num(d.kpis.marginPercent)}% del venduto senza IVA` : undefined} /> : null}
            <Kpi label="Durata media del tavolo" value={d.kpis.avgTableMinutes !== null ? `${d.kpis.avgTableMinutes} min` : '—'} />
            <Kpi label="Tempo medio in cucina" value={d.kpis.avgPrepMinutes !== null ? `${d.kpis.avgPrepMinutes} min` : '—'} sub="dall’invio al «pronto»" />
          </div>
          {d.costsVisible && d.kpis.missingCostQty ? <div className="alert warn small">{num(d.kpis.missingCostQty)} piatti venduti non hanno un costo calcolabile: completa porzioni e prezzi delle loro ricette per vederne il guadagno.</div> : null}

          {d.byDay.length > 1 ? (
            <div className="card">
              <div className="card-head">
                <h2>Incasso per giorno</h2>
              </div>
              <div className="card-body">
                <Bars data={d.byDay.map((x) => ({ label: new Date(`${x.date}T12:00:00`).toLocaleDateString('it-IT', d.byDay.length > 10 ? { day: 'numeric' } : { weekday: 'short', day: 'numeric' }), value: Number(x.revenue), text: euro(x.revenue) }))} />
              </div>
            </div>
          ) : null}

          <div className="grid-2">
            <div className="card">
              <div className="card-head">
                <h2>Ore di punta</h2>
                <span className="small muted">piatti ordinati per ora</span>
              </div>
              <div className="card-body">
                <Bars data={hours(d.byHour)} />
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <h2>Giorni della settimana</h2>
                <span className="small muted">coperti</span>
              </div>
              <div className="card-body">
                <Bars data={d.byWeekday.map((x) => ({ label: x.day, value: x.covers, text: `${x.covers} coperti · ${euro(x.revenue)}` }))} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Piatti più venduti</h2>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Piatto</th>
                    <th className="num">Quantità</th>
                    <th className="num">Incasso</th>
                    {d.costsVisible ? <th className="num">Guadagno per piatto</th> : null}
                    {d.costsVisible ? <th className="num">Guadagno totale</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((i) => (
                    <tr key={i.name}>
                      <td>
                        <strong>{i.name}</strong>
                        {i.section ? <div className="small faint">{i.section}</div> : null}
                      </td>
                      <td className="num">{num(i.qty)}</td>
                      <td className="num">{euro(i.revenue)}</td>
                      {d.costsVisible ? <td className="num">{i.marginPerDish ? euro(i.marginPerDish) : '—'}</td> : null}
                      {d.costsVisible ? <td className="num">{i.margin ? euro(i.margin) : '—'}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-head">
                <h2>Per sezione del menu</h2>
              </div>
              <ul className="menu-items">
                {d.sections.map((x) => (
                  <li key={x.name}>
                    <span className="grow">{x.name}</span>
                    <span className="small muted">{num(x.qty)} piatti</span>
                    <strong className="num">{euro(x.revenue)}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card">
              <div className="card-head">
                <h2>Camerieri</h2>
              </div>
              <ul className="menu-items">
                {d.waiters.map((x) => (
                  <li key={x.name}>
                    <span className="grow">{x.name}</span>
                    <span className="small muted">
                      {num(x.tables)} tavoli · {num(x.items)} piatti
                    </span>
                    <strong className="num">{euro(x.revenue)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="k-label">{label}</div>
      <div className="k-value">{value}</div>
      {sub ? <div className="faint small">{sub}</div> : null}
    </div>
  )
}

/** Solo le ore con vendite, più un'ora prima e dopo, per non mostrare la notte vuota. */
function hours(byHour: Stats['byHour']) {
  const used = byHour.filter((h) => h.qty > 0).map((h) => h.hour)
  if (!used.length) return []
  const lo = Math.max(0, Math.min(...used) - 1)
  const hi = Math.min(23, Math.max(...used) + 1)
  return byHour.filter((h) => h.hour >= lo && h.hour <= hi).map((h) => ({ label: `${h.hour}`, value: h.qty, text: `ore ${h.hour}–${h.hour + 1}: ${h.qty} piatti` }))
}

/** Barre verticali semplici, una serie: valore al passaggio e sopra la barra più alta. */
function Bars({ data }: { data: Array<{ label: string; value: number; text?: string }> }) {
  const max = useMemo(() => Math.max(1, ...data.map((x) => x.value)), [data])
  const top = data.findIndex((x) => x.value === max)
  if (!data.length) return <div className="small muted">Nessun dato.</div>
  return (
    <div className="bars" role="list">
      {data.map((x, i) => (
        <div key={i} className="bar-col" role="listitem" title={x.text ?? `${x.label}: ${x.value}`} aria-label={x.text ?? `${x.label}: ${x.value}`}>
          <span className="bar-val">{i === top && x.value > 0 ? (x.text?.split(' ·')[0] ?? x.value) : ''}</span>
          <span className="bar" style={{ height: `${(x.value / max) * 100}%` }} />
          <span className="bar-label">{x.label}</span>
        </div>
      ))}
    </div>
  )
}
