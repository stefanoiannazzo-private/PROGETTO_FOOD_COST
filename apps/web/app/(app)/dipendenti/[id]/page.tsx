'use client'

import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AffectedRecipe } from '@/lib/api'
import { date, euro, num } from '@/lib/num'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { costPayload, emptyCost, EmployeeCostFields, type CostValue } from '@/components/EmployeeCostForm'
import { AffectedNotice, ErrorBox, errorMessage, Field, fieldErrors, Icon, Skeleton, useToast } from '@/components/ui'

interface Cost {
  id: string
  validFrom: string
  grossMonthly: string
  contributionsMode: 'none' | 'amount' | 'percent'
  contributionsValue: string | null
  otherMonthlyCosts: string
  productiveHours: string
  companyHourly: string
  costPerMinute: string
  basis: 'company_cost' | 'gross_only'
  current: boolean
  future: boolean
}
interface Detail {
  id: string
  code: string
  firstName: string
  lastName: string
  jobTitle: string | null
  status: 'active' | 'inactive'
  archived: boolean
  salariesVisible: boolean
  hasCost: boolean
  costs?: Cost[]
}

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['employees', id], queryFn: () => api.get<Detail>(`/employees/${id}`) })
  const [v, setV] = useState<{ code: string; firstName: string; lastName: string; jobTitle: string; status: 'active' | 'inactive' } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [cost, setCost] = useState<CostValue>(emptyCost())
  const [costErrors, setCostErrors] = useState<Record<string, string>>({})
  const [affected, setAffected] = useState<AffectedRecipe[]>([])
  const [showCost, setShowCost] = useState(false)
  useEffect(() => {
    if (q.data) setV({ code: q.data.code, firstName: q.data.firstName, lastName: q.data.lastName, jobTitle: q.data.jobTitle ?? '', status: q.data.status })
  }, [q.data])
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data || !v) return <Skeleton rows={8} />
  const d = q.data
  const editable = can('employees.manage')
  const mode = (c: Cost) => (c.contributionsMode === 'none' ? 'non inseriti' : c.contributionsMode === 'amount' ? euro(c.contributionsValue) : `${num(c.contributionsValue, 2)}% del lordo`)
  return (
    <>
      <PageHead title={`${d.firstName} ${d.lastName}`} sub={<span className="mono">{d.code}</span>} />
      <div className="stack loose">
        <AffectedNotice recipes={affected} />
        <form
          className="card card-body stack"
          onSubmit={async (e) => {
            e.preventDefault()
            setErrors({})
            try {
              await api.patch(`/employees/${id}`, { ...v, jobTitle: v.jobTitle || null })
              toast('Dati salvati.')
              await q.refetch()
              qc.invalidateQueries({ queryKey: ['employees'] })
            } catch (err) {
              setErrors(fieldErrors(err))
              toast(errorMessage(err), 'err')
            }
          }}
        >
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="grid-4">
              <Field label="Nome" htmlFor="d-fn" error={errors.firstName}>
                <input id="d-fn" className="input" value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
              </Field>
              <Field label="Cognome" htmlFor="d-ln" error={errors.lastName}>
                <input id="d-ln" className="input" value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
              </Field>
              <Field label="Mansione" htmlFor="d-job">
                <input id="d-job" className="input" value={v.jobTitle} onChange={(e) => setV({ ...v, jobTitle: e.target.value })} />
              </Field>
              <Field label="Stato" htmlFor="d-st">
                <select id="d-st" className="input" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value as 'active' | 'inactive' })}>
                  <option value="active">Attivo</option>
                  <option value="inactive">Non attivo</option>
                </select>
              </Field>
            </div>
          </fieldset>
          {editable ? (
            <div>
              <button className="btn primary">Salva</button>
            </div>
          ) : null}
        </form>

        {d.salariesVisible ? (
          <div className="card">
            <div className="card-head">
              <h2>Costo del lavoro</h2>
              {editable && !showCost ? (
                <button className="btn sm primary" onClick={() => setShowCost(true)}>
                  <Icon name="plus" /> Nuova configurazione
                </button>
              ) : null}
            </div>
            <div className="card-body stack">
              {showCost ? (
                <form
                  className="card card-pad stack"
                  style={{ background: 'var(--surface-2)' }}
                  onSubmit={async (e) => {
                    e.preventDefault()
                    setCostErrors({})
                    try {
                      const r = await api.post<{ affectedRecipes: AffectedRecipe[] }>(`/employees/${id}/costs`, costPayload(cost))
                      setAffected(r.affectedRecipes)
                      setShowCost(false)
                      setCost(emptyCost())
                      toast('Configurazione registrata; lo storico resta consultabile.')
                      await q.refetch()
                      qc.invalidateQueries({ queryKey: ['recipes'] })
                    } catch (err) {
                      setCostErrors(fieldErrors(err))
                      toast(errorMessage(err), 'err')
                    }
                  }}
                >
                  <EmployeeCostFields v={cost} set={(p) => setCost((c) => ({ ...c, ...p }))} errors={costErrors} />
                  <div className="row">
                    <button className="btn primary">Registra</button>
                    <button type="button" className="btn" onClick={() => setShowCost(false)}>
                      Annulla
                    </button>
                  </div>
                </form>
              ) : null}
              {d.costs && d.costs.length ? (
                <div className="table-wrap">
                  <table className="table compact">
                    <thead>
                      <tr>
                        <th>Decorrenza</th>
                        <th className="num">Lordo mensile</th>
                        <th>Oneri</th>
                        <th className="num">Altri costi</th>
                        <th className="num">Ore produttive</th>
                        <th className="num">Costo orario</th>
                        <th className="num">Al minuto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.costs.map((c) => (
                        <tr key={c.id}>
                          <td>
                            {date(c.validFrom)} {c.current ? <span className="badge ok">corrente</span> : c.future ? <span className="badge info">futura</span> : null}
                          </td>
                          <td className="num">{euro(c.grossMonthly)}</td>
                          <td>{mode(c)}</td>
                          <td className="num">{euro(c.otherMonthlyCosts)}</td>
                          <td className="num">{num(c.productiveHours, 2)}</td>
                          <td className="num">
                            {euro(c.companyHourly, 4)} {c.basis === 'gross_only' ? <span className="badge warn">solo lordo</span> : null}
                          </td>
                          <td className="num">{euro(c.costPerMinute, 4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : !showCost ? (
                <div className="alert warn">Costo del lavoro non configurato: le ricette in cui lavora questo dipendente risultano incomplete.</div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="card card-body muted">{d.hasCost ? 'Costo del lavoro configurato.' : 'Costo del lavoro non configurato.'} Le retribuzioni non sono visibili con il tuo ruolo.</div>
        )}
      </div>
    </>
  )
}
