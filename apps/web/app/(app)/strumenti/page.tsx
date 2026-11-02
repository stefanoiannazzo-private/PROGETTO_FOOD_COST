'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { POWER_LABEL } from '@/lib/labels'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { DataTable, useList, useListState, type Column } from '@/components/DataTable'
import { EquipmentFields, emptyEquipment, equipmentPayload, type EquipmentValue } from '@/components/EquipmentForm'
import { Drawer, Empty, errorMessage, fieldErrors, Icon, StatusBadge, useToast } from '@/components/ui'

interface Row {
  id: string
  code: string
  name: string
  category: string | null
  powerType: string
  status: string
  capacity: string | null
  archived: boolean
}

export default function EquipmentPage() {
  const can = useCan()
  const [state, update] = useListState('equipment', { sort: 'name' })
  const query = useList<Row>('equipment', '/equipment', state)
  const [creating, setCreating] = useState(false)
  const columns: Column<Row>[] = [
    { key: 'code', label: 'Codice', sortable: true, render: (r) => <span className="mono">{r.code}</span> },
    {
      key: 'name',
      label: 'Nome',
      sortable: true,
      render: (r) => (
        <Link className="link" href={`/strumenti/${r.id}`}>
          {r.name}
        </Link>
      ),
    },
    { key: 'category', label: 'Categoria', sortable: true, render: (r) => r.category ?? <span className="faint">—</span> },
    { key: 'power', label: 'Alimentazione', render: (r) => POWER_LABEL[r.powerType] },
    { key: 'capacity', label: 'Capacità', render: (r) => r.capacity ?? <span className="faint">—</span> },
    { key: 'status', label: 'Stato', render: (r) => (r.status === 'active' ? <span className="badge ok">Attivo</span> : <StatusBadge status={r.status} />) },
  ]
  return (
    <>
      <PageHead
        title="Strumenti e macchinari"
        actions={
          can('equipment.manage') ? (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Nuovo strumento
            </button>
          ) : null
        }
      />
      <DataTable
        columns={columns}
        query={query}
        state={state}
        update={update}
        rowHref={(r) => `/strumenti/${r.id}`}
        toolbar={
          <>
            <select className="input" value={state.filters.powerType ?? ''} onChange={(e) => update({ filters: { ...state.filters, powerType: e.target.value } })} aria-label="Alimentazione">
              <option value="">Tutte le alimentazioni</option>
              {Object.entries(POWER_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <select className="input" value={state.filters.archived ?? '0'} onChange={(e) => update({ filters: { ...state.filters, archived: e.target.value } })} aria-label="Archiviati">
              <option value="0">Attivi</option>
              <option value="1">Archiviati</option>
              <option value="all">Tutti</option>
            </select>
          </>
        }
        empty={<Empty title="Nessuno strumento">Aggiungi forni, piastre, planetarie e abbattitori per valorizzarne il consumo nelle ricette.</Empty>}
      />
      {creating ? <CreateEquipment onClose={() => setCreating(false)} /> : null}
    </>
  )
}

function CreateEquipment({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState<EquipmentValue>(emptyEquipment())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  return (
    <Drawer
      title="Nuovo strumento"
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
                const r = await api.post<{ id: string; warnings: string[] }>('/equipment', equipmentPayload(v))
                qc.invalidateQueries({ queryKey: ['equipment'] })
                if (r.warnings.length) toast(`Salvato con avvisi: ${r.warnings[0]}`)
                else toast('Strumento creato.')
                router.push(`/strumenti/${r.id}`)
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
      {error ? <div className="alert err" style={{ marginBottom: 12 }}>{error}</div> : null}
      <EquipmentFields v={v} set={(p) => setV((x) => ({ ...x, ...p }))} errors={errors} />
    </Drawer>
  )
}
