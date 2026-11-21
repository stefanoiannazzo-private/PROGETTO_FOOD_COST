'use client'

/** NUOVO: piccoli elementi condivisi dalla console del superadmin. */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { euro, euroPer, num, percent } from '@/lib/num'
import type { Company, Stats } from '@/lib/platform'

export function CompanySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const q = useQuery({ queryKey: ['platform', 'companies'], queryFn: () => api.get<{ data: Company[] }>('/platform/companies') })
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Azienda">
      <option value="">Tutte le aziende</option>
      {(q.data?.data ?? []).map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  )
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="table-foot">
      <span>
        {total.toLocaleString('it-IT')} {total === 1 ? 'elemento' : 'elementi'}
      </span>
      <div className="row">
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Pagina precedente">
          ‹
        </button>
        <span>
          {page} / {pages}
        </span>
        <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Pagina successiva">
          ›
        </button>
      </div>
    </div>
  )
}

/** Riga di statistiche: minimo, massimo, media, mediana e scarto % tra minimo e massimo. */
export function StatCells({ s, unit, decimals = 2 }: { s: Stats; unit?: string; decimals?: number }) {
  const v = (x: string | null) => (x === null ? '—' : unit ? euroPer(x, unit, decimals) : euro(x, decimals))
  return (
    <>
      <td className="num">{num(s.count)}</td>
      <td className="num">{v(s.min)}</td>
      <td className="num">{v(s.max)}</td>
      <td className="num">{v(s.avg)}</td>
      <td className="num">{v(s.median)}</td>
      <td className="num">{s.spreadPercent === null ? '—' : percent(s.spreadPercent)}</td>
    </>
  )
}

export const STAT_HEAD = ['N.', 'Minimo', 'Massimo', 'Media', 'Mediana', 'Scarto']
