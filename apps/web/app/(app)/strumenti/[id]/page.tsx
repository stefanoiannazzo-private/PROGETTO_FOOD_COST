'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AffectedRecipe } from '@/lib/api'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { EquipmentFields, equipmentPayload, type EquipmentValue } from '@/components/EquipmentForm'
import { AffectedNotice, ErrorBox, errorMessage, fieldErrors, Icon, Skeleton, StatusBadge, useToast } from '@/components/ui'

type Detail = EquipmentValue & { id: string; archived: boolean; lockVersion: number; usedIn: Array<{ id: string; code: string; title: string; status: string }> }

export default function EquipmentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['equipment', id], queryFn: () => api.get<Detail>(`/equipment/${id}`) })
  const [v, setV] = useState<EquipmentValue | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [warnings, setWarnings] = useState<string[]>([])
  const [affected, setAffected] = useState<AffectedRecipe[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.data) {
      const d = q.data
      setV({
        ...d,
        category: d.category ?? '',
        description: d.description ?? '',
        capacity: d.capacity ?? '',
        gasMode: d.gasMode ?? 'flow',
        gasFlowUnit: d.gasFlowUnit ?? 'm3',
      })
    }
  }, [q.data])
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data || !v) return <Skeleton rows={8} />
  const d = q.data
  const editable = can('equipment.manage')
  return (
    <>
      <PageHead
        title={d.name}
        sub={<span className="mono">{d.code}</span>}
        actions={
          editable ? (
            <button
              className="btn"
              onClick={async () => {
                await api.post(`/equipment/${id}/${d.archived ? 'restore' : 'archive'}`)
                await q.refetch()
                qc.invalidateQueries({ queryKey: ['equipment'] })
              }}
            >
              <Icon name="archive" /> {d.archived ? 'Ripristina' : 'Archivia'}
            </button>
          ) : null
        }
      />
      <div className="stack loose">
        <AffectedNotice recipes={affected} />
        {warnings.length ? (
          <div className="alert warn">
            <Icon name="alert" />
            <ul style={{ margin: 0 }}>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <form
          className="card card-body stack"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setErrors({})
            try {
              const r = await api.patch<{ warnings: string[]; affectedRecipes: AffectedRecipe[] }>(`/equipment/${id}`, { ...equipmentPayload(v), code: v.code, lockVersion: d.lockVersion })
              setWarnings(r.warnings)
              setAffected(r.affectedRecipes)
              toast('Strumento salvato.')
              await q.refetch()
              qc.invalidateQueries({ queryKey: ['recipes'] })
            } catch (err) {
              setErrors(fieldErrors(err))
              toast(errorMessage(err), 'err')
            } finally {
              setBusy(false)
            }
          }}
        >
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
            <EquipmentFields v={v} set={(p) => setV((x) => ({ ...x!, ...p }))} errors={errors} />
          </fieldset>
          {editable ? (
            <div>
              <button className="btn primary" disabled={busy}>
                {busy ? <span className="spinner" /> : null} Salva modifiche
              </button>
            </div>
          ) : null}
        </form>
        <div className="card">
          <div className="card-head">
            <h2>Usato nelle ricette</h2>
          </div>
          {d.usedIn.length === 0 ? (
            <div className="card-body muted">Non ancora usato.</div>
          ) : (
            <table className="table compact">
              <tbody>
                {d.usedIn.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="link" href={`/ricette/${r.id}`}>
                        {r.title}
                      </Link>
                    </td>
                    <td className="num">
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  )
}
