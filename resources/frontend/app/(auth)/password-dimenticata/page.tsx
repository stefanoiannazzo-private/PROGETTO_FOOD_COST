'use client'

import Link from 'next/link'
import { useState } from 'react'
import { api } from '@/lib/api'
import { errorMessage, Field } from '@/components/ui'

export default function ForgotPage() {
  const [email, setEmail] = useState('')
  const [done, setDone] = useState<{ message: string; devLink?: string } | null>(null)
  const [error, setError] = useState('')
  return (
    <div className="auth-wrap">
      <form
        className="auth-card card card-body stack"
        onSubmit={async (e) => {
          e.preventDefault()
          setError('')
          try {
            setDone(await api.post('/auth/password/forgot', { email }))
          } catch (err) {
            setError(errorMessage(err))
          }
        }}
      >
        <h1>Recupero password</h1>
        {done ? (
          <div className="alert ok">
            <div>
              {done.message}
              {done.devLink ? (
                <div className="small" style={{ marginTop: 6 }}>
                  Ambiente di sviluppo:{' '}
                  <a className="link" href={done.devLink}>
                    apri il link di reimpostazione
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <p className="muted">Inserisci l’email del tuo account: riceverai un link valido 60 minuti.</p>
            {error ? <div className="alert err">{error}</div> : null}
            <Field label="Email" htmlFor="email">
              <input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            <button className="btn primary" type="submit">
              Invia il link
            </button>
          </>
        )}
        <Link className="link small" href="/accedi">
          Torna all’accesso
        </Link>
      </form>
    </div>
  )
}
