'use client'

/**
 * NUOVO — Tablet di servizio: l'amministratore trasforma questo dispositivo in un tablet condiviso
 * di sala o cucina. Da lì si vedono solo Sala e Cucina; chi prende un ordine si identifica con il PIN.
 * Per uscire serve di nuovo la password.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useMe } from '@/lib/session'
import { Field, fieldErrors, errorMessage, Icon } from './ui'

export function ServiceDeviceButton() {
  const me = useMe().data
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const on = !!me?.serviceDevice
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await api.post(on ? '/orders/device/disable' : '/orders/device/enable', { password })
      await qc.invalidateQueries()
      setOpen(false)
      setPassword('')
    } catch (e) {
      setError(fieldErrors(e).password ?? errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button className="btn ghost sm" onClick={() => setOpen(true)} title={on ? 'Esci dalla modalità tablet di servizio' : 'Usa questo dispositivo come tablet condiviso'}>
        <Icon name="key" /> {on ? 'Esci da tablet' : 'Tablet di servizio'}
      </button>
      {open ? (
        <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <form
            className="dialog"
            role="dialog"
            aria-modal="true"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div className="card-body stack">
              <h2 style={{ margin: 0 }}>{on ? 'Esci dalla modalità tablet' : 'Usa come tablet di servizio'}</h2>
              {on ? (
                <p className="muted" style={{ margin: 0 }}>
                  Torna all’uso normale del portale con il tuo account. Serve la password di chi ha attivato il tablet.
                </p>
              ) : (
                <div className="small muted stack" style={{ gap: 6 }}>
                  <span>Questo dispositivo resterà collegato al locale e mostrerà solo <strong>Sala</strong> e <strong>Cucina e bancone</strong>: niente costi, ricette o impostazioni.</span>
                  <span>Ogni cameriere si identifica con il suo <strong>PIN</strong> (lo imposti in «Menu e tavoli → Personale»), così le statistiche sanno chi ha preso l’ordine.</span>
                  <span>Per uscire servirà di nuovo la tua password.</span>
                </div>
              )}
              <Field label="La tua password" htmlFor="sd-pw" error={error}>
                <input id="sd-pw" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
              </Field>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setOpen(false)}>
                  Annulla
                </button>
                <button className="btn primary" disabled={!password || busy}>
                  {busy ? <span className="spinner" /> : null} {on ? 'Esci' : 'Attiva'}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </>
  )
}
