'use client'

import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import type { Me } from '@/lib/session'
import { useQueryParam } from '@/lib/hooks'
import { ErrorBox, errorMessage, Field, Skeleton } from '@/components/ui'

export default function InvitePage() {
  const token = useQueryParam('token')
  const router = useRouter()
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const info = useQuery({
    queryKey: ['invite', token],
    enabled: !!token,
    queryFn: () => api.get<{ email: string; name: string; company: string; roleLabel: string; existingUser: boolean }>(`/auth/invitations/${token}`),
  })
  return (
    <div className="auth-wrap">
      <div className="auth-card card card-body stack">
        <h1>Invito a Food Cost</h1>
        {token === null ? <div className="alert err">Link di invito non valido.</div> : null}
        {info.isLoading ? <Skeleton rows={3} /> : null}
        {info.error ? <ErrorBox error={info.error} /> : null}
        {info.data ? (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault()
              setError('')
              try {
                const me = await api.post<Me>('/auth/invitations/accept', { token, password })
                qc.clear()
                qc.setQueryData(['me'], me)
                router.replace('/')
              } catch (err) {
                setError(errorMessage(err))
              }
            }}
          >
            <p>
              <strong>{info.data.name}</strong>, sei stato invitato in <strong>{info.data.company}</strong> come {info.data.roleLabel}.
            </p>
            {error ? <div className="alert err">{error}</div> : null}
            <Field label={info.data.existingUser ? 'La password del tuo account' : 'Scegli una password'} htmlFor="pw" hint={info.data.existingUser ? `Account esistente: ${info.data.email}` : 'Almeno 10 caratteri.'}>
              <input id="pw" className="input" type="password" autoComplete={info.data.existingUser ? 'current-password' : 'new-password'} required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <button className="btn primary" type="submit">
              Accetta l’invito
            </button>
          </form>
        ) : null}
      </div>
    </div>
  )
}
