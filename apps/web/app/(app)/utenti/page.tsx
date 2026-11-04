'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { Drawer, ErrorBox, errorMessage, Field, fieldErrors, Icon, Skeleton, useToast } from '@/components/ui'

interface Member {
  id: string
  name: string
  email: string
  role: string
  roleLabel: string
  extraPermissions: string[]
  isActive: boolean
  lastLoginAt: string | null
  isSelf: boolean
}
interface Catalog {
  roles: Array<{ value: string; label: string; permissions: string[] }>
  permissions: Array<{ value: string; label: string; grantable: boolean }>
}

export default function UsersPage() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ data: Member[]; invitations: Array<{ id: string; email: string; name: string; roleLabel: string; expires_at: string; expired: boolean }> }>('/users') })
  const cat = useQuery({ queryKey: ['users', 'catalog'], queryFn: () => api.get<Catalog>('/users/catalog'), staleTime: Infinity })
  const [editing, setEditing] = useState<Member | 'new' | null>(null)
  if (q.error) return <ErrorBox error={q.error} />
  return (
    <>
      <PageHead
        title="Utenti e ruoli"
        sub="Gli utenti sono account di accesso; i dipendenti sono risorse di produzione e si gestiscono a parte."
        actions={
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" /> Invita utente
          </button>
        }
      />
      {!q.data ? (
        <Skeleton />
      ) : (
        <div className="stack loose">
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Email</th>
                  <th>Ruolo</th>
                  <th>Permessi aggiuntivi</th>
                  <th>Ultimo accesso</th>
                  <th>Stato</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {q.data.data.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.name} {m.isSelf ? <span className="badge">tu</span> : null}
                    </td>
                    <td>{m.email}</td>
                    <td>{m.roleLabel}</td>
                    <td className="small">{m.extraPermissions.map((p) => cat.data?.permissions.find((x) => x.value === p)?.label ?? p).join(', ') || '—'}</td>
                    <td className="small faint">{dateTime(m.lastLoginAt)}</td>
                    <td>{m.isActive ? <span className="badge ok">Attivo</span> : <span className="badge">Disattivato</span>}</td>
                    <td className="num">
                      <button className="btn sm" onClick={() => setEditing(m)}>
                        Modifica
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.data.invitations.length ? (
            <div className="card">
              <div className="card-head">
                <h2>Inviti in attesa</h2>
              </div>
              <table className="table compact">
                <tbody>
                  {q.data.invitations.map((i) => (
                    <tr key={i.id}>
                      <td>{i.name}</td>
                      <td>{i.email}</td>
                      <td>{i.roleLabel}</td>
                      <td className="small">{i.expired ? <span className="badge warn">Scaduto</span> : `scade ${dateTime(i.expires_at)}`}</td>
                      <td className="num">
                        <button
                          className="btn sm ghost"
                          onClick={async () => {
                            await api.del(`/users/invitations/${i.id}`)
                            qc.invalidateQueries({ queryKey: ['users'] })
                            toast('Invito revocato.')
                          }}
                        >
                          Revoca
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
      {editing && cat.data ? <MemberDrawer member={editing === 'new' ? null : editing} catalog={cat.data} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

function MemberDrawer({ member, catalog, onClose }: { member: Member | null; catalog: Catalog; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState({ name: member?.name ?? '', email: member?.email ?? '', role: member?.role ?? 'operator', extra: member?.extraPermissions ?? [], isActive: member?.isActive ?? true })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [devLink, setDevLink] = useState('')
  const [mailSent, setMailSent] = useState(false)
  const rolePerms = new Set(catalog.roles.find((r) => r.value === v.role)?.permissions ?? [])
  const save = async () => {
    setErrors({})
    setError('')
    try {
      if (member) {
        await api.patch(`/users/${member.id}`, { role: v.role, extraPermissions: v.extra, isActive: v.isActive })
        toast('Utente aggiornato.')
        onClose()
      } else {
        const r = await api.post<{ inviteLink?: string; mail: 'sent' | 'outbox' | 'failed' }>('/users/invitations', { name: v.name, email: v.email, role: v.role, extraPermissions: v.extra })
        toast(r.mail === 'sent' ? 'Invito inviato per email.' : 'Invito creato.')
        if (r.inviteLink) {
          setMailSent(r.mail === 'sent')
          setDevLink(r.inviteLink)
        }
        else onClose()
      }
      qc.invalidateQueries({ queryKey: ['users'] })
    } catch (e) {
      setErrors(fieldErrors(e))
      setError(errorMessage(e))
    }
  }
  return (
    <Drawer
      title={member ? `Modifica ${member.name}` : 'Invita utente'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Chiudi
          </button>
          {!devLink ? (
            <button className="btn primary" onClick={save}>
              {member ? 'Salva' : 'Invia invito'}
            </button>
          ) : null}
        </>
      }
    >
      <div className="stack">
        {error ? <div className="alert err">{error}</div> : null}
        {devLink ? (
          <div className={`alert ${mailSent ? 'ok' : 'warn'}`}>
            <div className="stack tight">
              <span>{mailSent ? 'Email inviata. Link dell’invito:' : 'L’email non è stata inviata (server di posta non configurato o non raggiungibile). Consegna tu questo link alla persona invitata, è valido 7 giorni:'}</span>
              <input className="input mono" readOnly value={devLink} onFocus={(e) => e.target.select()} aria-label="Link di invito" />
              <button className="btn sm" type="button" onClick={() => navigator.clipboard?.writeText(devLink).then(() => toast('Link copiato.'))}>
                Copia link
              </button>
            </div>
          </div>
        ) : null}
        {!member ? (
          <div className="grid-2">
            <Field label="Nome e cognome" htmlFor="u-name" required error={errors.name}>
              <input id="u-name" className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
            </Field>
            <Field label="Email" htmlFor="u-email" required error={errors.email}>
              <input id="u-email" className="input" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
            </Field>
          </div>
        ) : null}
        <Field label="Ruolo" htmlFor="u-role">
          <select id="u-role" className="input" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })}>
            {catalog.roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="stack tight">
          <div className="label">Permessi</div>
          {catalog.permissions.map((p) => {
            const fromRole = rolePerms.has(p.value)
            const checked = fromRole || v.extra.includes(p.value)
            return (
              <label key={p.value} className="checkbox" style={{ opacity: !fromRole && !p.grantable ? 0.5 : 1 }}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={fromRole || !p.grantable}
                  onChange={(e) => setV({ ...v, extra: e.target.checked ? [...v.extra, p.value] : v.extra.filter((x) => x !== p.value) })}
                />
                {p.label} {fromRole ? <span className="faint small">(dal ruolo)</span> : null}
              </label>
            )
          })}
        </div>
        {member && !member.isSelf ? (
          <label className="checkbox">
            <input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} /> Accesso attivo per questa azienda
          </label>
        ) : null}
      </div>
    </Drawer>
  )
}
