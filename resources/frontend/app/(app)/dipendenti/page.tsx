'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { euro } from '@/lib/num'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { DataTable, useList, useListState, type Column } from '@/components/DataTable'
import { costPayload, emptyCost, EmployeeCostFields, type CostValue } from '@/components/EmployeeCostForm'
import { Drawer, Empty, errorMessage, Field, fieldErrors, Icon, useToast } from '@/components/ui'

interface Row {
  id: string
  code: string
  name: string
  jobTitle: string | null
  status: string
  hasCost: boolean
  cost?: { companyHourly: string; costPerMinute: string; basis: string; grossMonthly: string }
}

export default function EmployeesPage() {
  const can = useCan()
  const [state, update] = useListState('employees', { sort: 'name' })
  const query = useList<Row>('employees', '/employees', state)
  const [creating, setCreating] = useState(false)
  const salaries = can('salaries.read')
  const columns: Column<Row>[] = [
    { key: 'code', label: 'Codice', sortable: true, render: (r) => <span className="mono">{r.code}</span> },
    {
      key: 'name',
      label: 'Nome',
      sortable: true,
      render: (r) => (
        <Link className="link" href={`/dipendenti/${r.id}`}>
          {r.name}
        </Link>
      ),
    },
    { key: 'job', label: 'Mansione', sortable: true, render: (r) => r.jobTitle ?? <span className="faint">—</span> },
    { key: 'status', label: 'Stato', render: (r) => (r.status === 'active' ? <span className="badge ok">Attivo</span> : <span className="badge">Non attivo</span>) },
    ...(salaries
      ? ([
          { key: 'gross', label: 'Lordo mensile', num: true, render: (r) => (r.cost ? euro(r.cost.grossMonthly) : '—') },
          {
            key: 'hourly',
            label: 'Costo orario',
            num: true,
            render: (r) =>
              r.cost ? (
                <>
                  {euro(r.cost.companyHourly)} {r.cost.basis === 'gross_only' ? <span className="badge warn">solo lordo</span> : null}
                </>
              ) : (
                <span className="badge err">Non configurato</span>
              ),
          },
        ] as Column<Row>[])
      : [{ key: 'cost', label: 'Costo del lavoro', render: (r: Row) => (r.hasCost ? <span className="badge ok">Configurato</span> : <span className="badge err">Mancante</span>) }]),
  ]
  return (
    <>
      <PageHead
        title="Dipendenti"
        sub={salaries ? 'Le retribuzioni sono visibili solo a chi ha il permesso dedicato.' : 'Le retribuzioni non sono visibili con il tuo ruolo.'}
        actions={
          can('employees.manage') ? (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Nuovo dipendente
            </button>
          ) : null
        }
      />
      <DataTable
        columns={columns}
        query={query}
        state={state}
        update={update}
        rowHref={(r) => `/dipendenti/${r.id}`}
        toolbar={
          <select className="input" value={state.filters.status ?? ''} onChange={(e) => update({ filters: { ...state.filters, status: e.target.value } })} aria-label="Stato">
            <option value="">Tutti</option>
            <option value="active">Attivi</option>
            <option value="inactive">Non attivi</option>
          </select>
        }
        empty={<Empty title="Nessun dipendente">I dipendenti sono le risorse di produzione: possono esistere senza un account di accesso.</Empty>}
      />
      {creating ? <CreateEmployee onClose={() => setCreating(false)} withCost={salaries} /> : null}
    </>
  )
}

function CreateEmployee({ onClose, withCost }: { onClose: () => void; withCost: boolean }) {
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState({ code: '', firstName: '', lastName: '', jobTitle: '' })
  const [addCost, setAddCost] = useState(withCost)
  const [cost, setCost] = useState<CostValue>(emptyCost())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const costErrors = Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith('firstCost.')).map(([k, m]) => [k.slice(10), m]))
  return (
    <Drawer
      title="Nuovo dipendente"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              setErrors({})
              setError('')
              try {
                const r = await api.post<{ id: string }>('/employees', { ...v, code: v.code || null, jobTitle: v.jobTitle || null, ...(addCost ? { firstCost: costPayload(cost) } : {}) })
                qc.invalidateQueries({ queryKey: ['employees'] })
                toast('Dipendente creato.')
                router.push(`/dipendenti/${r.id}`)
              } catch (e) {
                setErrors(fieldErrors(e))
                setError(errorMessage(e))
              }
            }}
          >
            Crea
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? <div className="alert err">{error}</div> : null}
        <div className="grid-2">
          <Field label="Nome" htmlFor="e-fn" required error={errors.firstName}>
            <input id="e-fn" className="input" value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} autoFocus />
          </Field>
          <Field label="Cognome" htmlFor="e-ln" required error={errors.lastName}>
            <input id="e-ln" className="input" value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
          </Field>
          <Field label="Mansione" htmlFor="e-job">
            <input id="e-job" className="input" value={v.jobTitle} onChange={(e) => setV({ ...v, jobTitle: e.target.value })} />
          </Field>
          <Field label="Codice dipendente" htmlFor="e-code" hint="Vuoto = generato" error={errors.code}>
            <input id="e-code" className="input mono" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} />
          </Field>
        </div>
        {withCost ? (
          <>
            <label className="checkbox">
              <input type="checkbox" checked={addCost} onChange={(e) => setAddCost(e.target.checked)} /> Inserisci subito il costo del lavoro
            </label>
            {addCost ? <EmployeeCostFields v={cost} set={(p) => setCost((c) => ({ ...c, ...p }))} errors={costErrors} /> : null}
          </>
        ) : null}
      </div>
    </Drawer>
  )
}
