'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { BrandLogo } from '@/components/Brand'
import { api } from '@/lib/api'
import { useQueryParam } from '@/lib/hooks'
import { tidyPromo, usePromoCheck } from '@/lib/promo'
import { errorMessage, Field, fieldErrors, Icon } from '@/components/ui'

/**
 * NUOVO — Richiesta di attivazione pubblica. Il link di un promotore (/registrati?promo=CODICE)
 * apre questa pagina con il codice già compilato; la richiesta arriva al superadmin che la approva.
 */
export default function SignupRequestPage() {
  const fromLink = tidyPromo(useQueryParam('promo') ?? '')
  const [v, setV] = useState({ businessName: '', contactName: '', email: '', phone: '', city: '', message: '', promoCode: fromLink, website: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const check = usePromoCheck(v.promoCode)
  // il codice del link arriva dopo il primo disegno: lo inseriamo appena c'è (se il campo è ancora vuoto)
  useEffect(() => {
    if (fromLink) setV((x) => (x.promoCode ? x : { ...x, promoCode: fromLink }))
  }, [fromLink])

  if (done) {
    return (
      <div className="auth-wrap">
        <div className="auth-card card card-body stack">
          <div className="auth-brand">
            <BrandLogo height={56} />
          </div>
          <h1>Richiesta inviata</h1>
          <p>
            Grazie {v.contactName.split(' ')[0]}! Abbiamo ricevuto la richiesta per <strong>{v.businessName}</strong>. Appena attivata riceverai un’email all’indirizzo{' '}
            <strong>{v.email}</strong> con il link per scegliere la password ed entrare.
          </p>
          <Link className="btn" href="/accedi">
            Torna all’accesso
          </Link>
        </div>
      </div>
    )
  }

  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value })

  return (
    <div className="auth-wrap">
      <form
        className="auth-card card card-body stack"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          setErrors({})
          try {
            await api.post('/public/signup-requests', { ...v, promoCode: v.promoCode.trim() || null, phone: v.phone.trim() || null, city: v.city.trim() || null, message: v.message.trim() || null })
            setDone(true)
          } catch (err) {
            const f = fieldErrors(err)
            setErrors(f)
            if (!Object.keys(f).length) setError(errorMessage(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="auth-brand">
          <BrandLogo height={56} />
        </div>
        <h1>Prova Ricetta Quadra</h1>
        <p className="muted" style={{ marginTop: -6 }}>
          Lascia i dati del tuo locale: attiviamo l’account e ti mandiamo il link per entrare.
        </p>
        {error ? (
          <div className="alert err" role="alert">
            {error}
          </div>
        ) : null}
        <Field label="Nome del locale" htmlFor="su-biz" required error={errors.businessName}>
          <input id="su-biz" className="input" value={v.businessName} onChange={set('businessName')} required autoComplete="organization" />
        </Field>
        <Field label="Nome e cognome" htmlFor="su-name" required error={errors.contactName}>
          <input id="su-name" className="input" value={v.contactName} onChange={set('contactName')} required autoComplete="name" />
        </Field>
        <Field label="Email" htmlFor="su-email" required error={errors.email}>
          <input id="su-email" type="email" className="input" value={v.email} onChange={set('email')} required autoComplete="email" />
        </Field>
        <div className="grid-2">
          <Field label="Telefono" htmlFor="su-phone" error={errors.phone}>
            <input id="su-phone" type="tel" className="input" value={v.phone} onChange={set('phone')} autoComplete="tel" />
          </Field>
          <Field label="Città" htmlFor="su-city" error={errors.city}>
            <input id="su-city" className="input" value={v.city} onChange={set('city')} autoComplete="address-level2" />
          </Field>
        </div>
        <Field
          label="Codice promo"
          htmlFor="su-promo"
          error={errors.promoCode ?? (check.status === 'invalid' ? 'Codice non riconosciuto: controlla di averlo scritto giusto.' : undefined)}
          hint={check.status === 'valid' ? undefined : 'Facoltativo: il codice del collega che ti ha consigliato Ricetta Quadra.'}
        >
          <input
            id="su-promo"
            className="input mono"
            value={v.promoCode}
            onChange={(e) => setV({ ...v, promoCode: tidyPromo(e.target.value) })}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="es. MARIO24"
          />
          {check.status === 'valid' ? (
            <span className="small" style={{ color: 'var(--ok, #2f9a62)', display: 'inline-flex', gap: 4, alignItems: 'center', marginTop: 4 }}>
              <Icon name="check" size={14} /> Codice valido{check.official && check.official !== v.promoCode ? ` (${check.official})` : ''}
            </span>
          ) : null}
        </Field>
        <Field label="Messaggio" htmlFor="su-msg" error={errors.message}>
          <textarea id="su-msg" className="input" rows={3} value={v.message} onChange={set('message')} placeholder="Facoltativo: che tipo di locale hai, quando ci possiamo sentire…" />
        </Field>
        {/* trappola per i bot: nascosta alle persone */}
        <input type="text" name="website" value={v.website} onChange={set('website')} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }} />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : null} Invia la richiesta
        </button>
        <div className="row small" style={{ justifyContent: 'center' }}>
          Hai già un account?&nbsp;
          <Link className="link" href="/accedi">
            Accedi
          </Link>
        </div>
      </form>
    </div>
  )
}
