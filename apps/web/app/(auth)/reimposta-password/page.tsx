'use client'

import Link from 'next/link'
import { useState } from 'react'
import { api } from '@/lib/api'
import { useQueryParam } from '@/lib/hooks'
import { errorMessage, Field, fieldErrors } from '@/components/ui'

export default function ResetPage() {
  const token = useQueryParam('token')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [done, setDone] = useState(false)
  return (
    <div className="auth-wrap">
      <form
        className="auth-card card card-body stack"
        onSubmit={async (e) => {
          e.preventDefault()
          setError('')
          if (password !== confirm) return setFields({ confirm: 'Le password non coincidono.' })
          try {
            await api.post('/auth/password/reset', { token, password })
            setDone(true)
          } catch (err) {
            setError(errorMessage(err))
            setFields(fieldErrors(err))
          }
        }}
      >
        <h1>Nuova password</h1>
        {token === null ? <div className="alert err">Link non valido.</div> : null}
        {done ? (
          <div className="alert ok">Password aggiornata. Ora puoi accedere.</div>
        ) : (
          <>
            {error ? <div className="alert err">{error}</div> : null}
            <Field label="Nuova password" htmlFor="pw" hint="Almeno 10 caratteri." error={fields.password}>
              <input id="pw" className="input" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Ripeti la password" htmlFor="pw2" error={fields.confirm}>
              <input id="pw2" className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <button className="btn primary" type="submit" disabled={!token}>
              Salva password
            </button>
          </>
        )}
        <Link className="link small" href="/accedi">
          Vai all’accesso
        </Link>
      </form>
    </div>
  )
}
