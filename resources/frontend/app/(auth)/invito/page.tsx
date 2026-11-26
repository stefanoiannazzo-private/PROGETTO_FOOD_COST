'use client'

import { useRouter } from 'next/navigation'
import { BrandLogo } from '@/components/Brand'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import type { Me } from '@/lib/session'
import { tidyPromo } from '@/lib/promo'
import { useQueryParam } from '@/lib/hooks'
import { ErrorBox, errorMessage, Field, fieldErrors, Skeleton, PasswordInput } from '@/components/ui'

export default function InvitePage() {
  const token = useQueryParam('token')
  const router = useRouter()
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [promoCode, setPromoCode] = useState('')
  const [promoError, setPromoError] = useState('')
  const [error, setError] = useState('')
  const info = useQuery({
    queryKey: ['invite', token],
    enabled: !!token,
    queryFn: () => api.get<{ email: string; name: string; company: string; roleLabel: string; existingUser: boolean; askPromo?: boolean }>(`/auth/invitations/${token}`),
  })
  return (
    <div className="auth-wrap">
      <div className="auth-card card card-body stack">
        <div className="auth-brand">
          <BrandLogo height={56} />
        </div>
        <h1>Invito a Ricetta Quadra</h1>
        {token === null ? <div className="alert err">Link di invito non valido.</div> : null}
        {info.isLoading ? <Skeleton rows={3} /> : null}
        {info.error ? <ErrorBox error={info.error} /> : null}
        {info.data ? (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault()
              setError('')
              setPromoError('')
              try {
                const me = await api.post<Me>('/auth/invitations/accept', { token, password, promoCode: promoCode.trim() || null })
                qc.clear()
                qc.setQueryData(['me'], me)
                router.replace('/')
              } catch (err) {
                const f = fieldErrors(err)
                if (f.promoCode) setPromoError(f.promoCode)
                else setError(errorMessage(err))
              }
            }}
          >
            <p>
              <strong>{info.data.name}</strong>, sei stato invitato in <strong>{info.data.company}</strong> come {info.data.roleLabel}.
            </p>
            {error ? <div className="alert err">{error}</div> : null}
            <Field label={info.data.existingUser ? 'La password del tuo account' : 'Scegli una password'} htmlFor="pw" hint={info.data.existingUser ? `Account esistente: ${info.data.email}` : 'Almeno 10 caratteri.'}>
              <PasswordInput id="pw" className="input" autoComplete={info.data.existingUser ? 'current-password' : 'new-password'} required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {info.data.askPromo ? (
              <Field label="Codice promo" htmlFor="promo" error={promoError} hint="Facoltativo: se qualcuno ti ha consigliato Ricetta Quadra, inserisci il suo codice.">
                <input id="promo" className="input mono" value={promoCode} onChange={(e) => setPromoCode(tidyPromo(e.target.value))} spellCheck={false} autoCapitalize="characters" autoComplete="off" placeholder="es. MARIO24" />
              </Field>
            ) : null}
            <button className="btn primary" type="submit">
              Accetta l’invito
            </button>
          </form>
        ) : null}
      </div>
    </div>
  )
}
