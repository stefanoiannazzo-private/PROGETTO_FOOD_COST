'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { date, euro, unitLabel, todayIso } from '@/lib/num'
import { useCan } from '@/lib/session'
import { KIND_LABEL } from '@/lib/labels'
import { PageHead } from '@/components/AppShell'
import { Drawer, Empty, ErrorBox, errorMessage, Field, fieldErrors, Icon, NumberInput, Skeleton } from '@/components/ui'

interface TariffRow {
  id: string
  name: string
  kind: 'electricity' | 'gas' | 'water'
  unit: 'kwh' | 'm3' | 'smc'
  notes: string | null
  archived: boolean
  current: { pricePerUnit: string; validFrom: string; origin: string; m3ToSmc: string | null; smcToKwh: string | null } | null
}

export default function TariffsPage() {
  const can = useCan()
  const [archived, setArchived] = useState('0')
  const [creating, setCreating] = useState(false)
  const q = useQuery({ queryKey: ['tariffs', archived], queryFn: () => api.get<{ data: TariffRow[] }>('/tariffs', { archived }) })
  return (
    <>
      <PageHead
        title="Utenze e tariffe"
        sub="Elettricità in €/kWh (energia consumata, non kW di potenza); gas in €/m³, €/Smc o €/kWh. Valori netti IVA."
        actions={
          can('tariffs.manage') ? (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Nuova tariffa
            </button>
          ) : null
        }
      />
      <div className="card">
        <div className="toolbar">
          <select className="input" value={archived} onChange={(e) => setArchived(e.target.value)} aria-label="Stato">
            <option value="0">Attive</option>
            <option value="1">Archiviate</option>
            <option value="all">Tutte</option>
          </select>
        </div>
        {q.error ? (
          <div className="card-body">
            <ErrorBox error={q.error} retry={() => q.refetch()} />
          </div>
        ) : !q.data ? (
          <Skeleton />
        ) : q.data.data.length === 0 ? (
          <Empty title="Nessuna tariffa" action={can('tariffs.manage') ? <button className="btn primary" onClick={() => setCreating(true)}>Crea la prima tariffa</button> : null}>
            Le tariffe servono a valorizzare il consumo energetico di forni, piastre e altri strumenti.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tipo</th>
                <th className="num">Valore corrente</th>
                <th>Valido dal</th>
                <th>Origine</th>
              </tr>
            </thead>
            <tbody>
              {q.data.data.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link className="link" href={`/utenze/${t.id}`}>
                      {t.name}
                    </Link>
                  </td>
                  <td>{KIND_LABEL[t.kind]}</td>
                  <td className="num">{t.current ? `${euro(t.current.pricePerUnit, 4)}/${unitLabel(t.unit)}` : <span className="badge err">Nessun valore</span>}</td>
                  <td>{date(t.current?.validFrom)}</td>
                  <td>{t.current ? (t.current.origin === 'bill' ? <span className="badge info">Media da bolletta</span> : 'Diretta') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating ? <CreateTariff onClose={() => setCreating(false)} /> : null}
    </>
  )
}

function CreateTariff({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [v, setV] = useState({ name: '', kind: 'electricity' as TariffRow['kind'], unit: 'kwh' as TariffRow['unit'], price: null as string | null, validFrom: todayIso() })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const units = v.kind === 'electricity' ? ['kwh'] : v.kind === 'gas' ? ['m3', 'smc', 'kwh'] : ['m3']
  return (
    <Drawer
      title="Nuova tariffa"
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
                const t = await api.post<{ id: string }>('/tariffs', {
                  name: v.name,
                  kind: v.kind,
                  unit: v.unit,
                  ...(v.price !== null ? { firstVersion: { mode: 'direct', pricePerUnit: v.price, validFrom: v.validFrom } } : {}),
                })
                qc.invalidateQueries({ queryKey: ['tariffs'] })
                router.push(`/utenze/${t.id}`)
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
        <Field label="Nome" htmlFor="t-name" required error={errors.name}>
          <input id="t-name" className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="es. Energia elettrica laboratorio" autoFocus />
        </Field>
        <div className="grid-2">
          <Field label="Tipo" htmlFor="t-kind">
            <select
              id="t-kind"
              className="input"
              value={v.kind}
              onChange={(e) => {
                const kind = e.target.value as TariffRow['kind']
                setV({ ...v, kind, unit: kind === 'electricity' ? 'kwh' : 'm3' })
              }}
            >
              <option value="electricity">Elettricità</option>
              <option value="gas">Gas</option>
              <option value="water">Acqua</option>
            </select>
          </Field>
          <Field label="Unità di prezzo" htmlFor="t-unit" error={errors.unit} hint={v.kind === 'gas' ? 'm³ e Smc non sono equivalenti' : undefined}>
            <select id="t-unit" className="input" value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value as TariffRow['unit'] })}>
              {units.map((u) => (
                <option key={u} value={u}>
                  €/{unitLabel(u)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="section-title">Primo valore (facoltativo)</div>
        <p className="small muted">Se conosci il prezzo unitario inseriscilo qui; per calcolarlo da una bolletta apri la tariffa dopo averla creata.</p>
        <div className="grid-2">
          <Field label="Prezzo unitario (netto IVA)" htmlFor="t-price">
            <NumberInput id="t-price" value={v.price} onChange={(x) => setV({ ...v, price: x })} suffix={`€/${unitLabel(v.unit)}`} />
          </Field>
          <Field label="Valido dal" htmlFor="t-vf">
            <input id="t-vf" type="date" className="input" value={v.validFrom} onChange={(e) => setV({ ...v, validFrom: e.target.value })} />
          </Field>
        </div>
      </div>
    </Drawer>
  )
}
