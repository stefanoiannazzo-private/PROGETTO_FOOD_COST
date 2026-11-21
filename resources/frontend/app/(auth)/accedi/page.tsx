'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Me } from '@/lib/session'
import { useQueryParam } from '@/lib/hooks'
import { errorMessage, Field } from '@/components/ui'

export default function LoginPage() {
  const router = useRouter()
  const qc = useQueryClient()
  const next = useQueryParam('next')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div className="auth-wrap">
      <form
        className="auth-card card card-body stack"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          try {
            const me = await api.post<Me>('/auth/login', { email, password })
            qc.clear()
            qc.setQueryData(['me'], me)
            router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/')
          } catch (err) {
            setError(errorMessage(err))
            setBusy(false)
          }
        }}
      >
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">€</span> Food Cost
        </div>
        <h1>Accedi</h1>
        {error ? (
          <div className="alert err" role="alert">
            {error}
          </div>
        ) : null}
        <Field label="Email" htmlFor="email">
          <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password" htmlFor="password">
          <input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : null} Accedi
        </button>
        <Link className="link small" href="/password-dimenticata">
          Password dimenticata?
        </Link>
      </form>
    </div>
  )
}
