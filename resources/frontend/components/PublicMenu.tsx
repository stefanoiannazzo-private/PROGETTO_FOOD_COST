'use client'

/**
 * NUOVO — Menu digitale pubblico (dal QR sul tavolo), pensato per il telefono del cliente.
 * Modalità: libero, registrazione facoltativa con omaggio, registrazione obbligatoria, spento.
 */
import { useEffect, useState } from 'react'
import { euro } from '@/lib/num'
import { BrandMark } from './Brand'

interface MenuPayload {
  company: string
  token: string
  mode: 'off' | 'open' | 'required' | 'optional'
  table: string | null
  tableQr: string | null
  giftText: string | null
  coverCharge: string
  guest: { firstName: string; gift: { text: string; code: string; redeemed: boolean } | null } | null
  locked: boolean
  sections: Array<{ id: string; name: string; items: Array<{ id: string; name: string; description: string | null; price: string; isAvailable: boolean }> }>
}

const key = (token: string) => `rq-guest-${token}`

async function call<T>(path: string, init: RequestInit = {}, guest?: string | null): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'foodcost', ...(guest ? { 'X-Guest-Token': guest } : {}), ...(init.headers ?? {}) },
  })
  const j = await r.json().catch(() => null)
  if (!r.ok) throw Object.assign(new Error(j?.error?.message ?? 'Errore'), { fields: j?.error?.details?.fields ?? {} })
  return j as T
}

export function PublicMenu({ path }: { path: string }) {
  const [data, setData] = useState<MenuPayload | null>(null)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)

  const load = async (g: string | null) => {
    try {
      setData(await call<MenuPayload>(path, {}, g))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Menu non disponibile.')
    }
  }
  useEffect(() => {
    // il gettone del cliente è legato al locale: lo leggiamo dopo aver saputo quale
    void (async () => {
      try {
        const first = await call<MenuPayload>(path)
        let g: string | null = null
        try {
          g = localStorage.getItem(key(first.token))
        } catch {
          /* navigazione privata */
        }
        if (g) await load(g)
        else setData(first)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Menu non disponibile.')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  if (error) return <div className="pm-wrap"><div className="pm-card pm-center">{error === 'Menu non trovato.' || /trovat/.test(error) ? 'Questo menu non esiste più. Chiedi al personale.' : error}</div></div>
  if (!data) return <div className="pm-wrap"><div className="pm-card pm-center"><span className="spinner" /></div></div>

  return (
    <div className="pm-wrap">
      <header className="pm-head">
        <h1>{data.company}</h1>
        {data.table ? <span className="pm-table">Tavolo {data.table}</span> : null}
        {data.guest ? <span className="pm-hello">Ciao {data.guest.firstName}!</span> : null}
      </header>

      {data.guest?.gift ? (
        <div className="pm-gift">
          <strong>🎁 {data.guest.gift.text}</strong>
          <span>Mostra questo codice al cameriere</span>
          <code>{data.guest.gift.code}</code>
          {data.guest.gift.redeemed ? <span className="pm-small">Omaggio già consegnato</span> : null}
        </div>
      ) : null}

      {data.mode === 'off' ? (
        <div className="pm-card pm-center">Il menu digitale non è disponibile in questo momento. Chiedi al personale.</div>
      ) : data.locked || showForm ? (
        <Register
          data={data}
          required={data.mode === 'required'}
          onCancel={data.mode === 'required' ? undefined : () => setShowForm(false)}
          onDone={async (g) => {
            try {
              localStorage.setItem(key(data.token), g)
            } catch {
              /* niente */
            }
            setShowForm(false)
            await load(g)
          }}
        />
      ) : (
        <>
          {data.mode === 'optional' && !data.guest && data.giftText ? (
            <button className="pm-offer" onClick={() => setShowForm(true)}>
              <span>🎁 Registrati e ricevi: <strong>{data.giftText}</strong></span>
              <span className="pm-small">Bastano nome, email e telefono · tocca qui</span>
            </button>
          ) : null}
          {data.sections.length > 1 ? (
            <nav className="pm-nav">
              {data.sections.map((s) => (
                <a key={s.id} href={`#s-${s.id}`}>
                  {s.name}
                </a>
              ))}
            </nav>
          ) : null}
          {data.sections.map((s) => (
            <section key={s.id} id={`s-${s.id}`} className="pm-section">
              <h2>{s.name}</h2>
              {s.items.map((i) => (
                <div key={i.id} className={`pm-item ${i.isAvailable ? '' : 'off'}`}>
                  <div>
                    <div className="pm-name">{i.name}</div>
                    {i.description ? <div className="pm-desc">{i.description}</div> : null}
                  </div>
                  <div className="pm-price">{i.isAvailable ? euro(i.price) : 'esaurito'}</div>
                </div>
              ))}
            </section>
          ))}
          {!data.sections.length ? <div className="pm-card pm-center">Il menu è in preparazione.</div> : null}
          <footer className="pm-foot">
            {Number(data.coverCharge) > 0 ? <div>Coperto {euro(data.coverCharge)} a persona.</div> : null}
            <div>Per allergeni e intolleranze chiedi al personale: ti diremo cosa contiene ogni piatto.</div>
            <div className="pm-brand">
              <BrandMark size={16} /> Ricetta Quadra
            </div>
          </footer>
        </>
      )}
    </div>
  )
}

function Register({ data, required, onDone, onCancel }: { data: MenuPayload; required: boolean; onDone: (guestToken: string) => void; onCancel?: () => void }) {
  const [v, setV] = useState({ firstName: '', lastName: '', email: '', phone: '', privacyOk: false, marketing: false, website: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  return (
    <form
      className="pm-card pm-form"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setErrors({})
        setError('')
        try {
          const r = await call<{ guestToken: string }>(`/public/menu/${data.token}/guests`, { method: 'POST', body: JSON.stringify({ ...v, tableQr: data.tableQr }) })
          onDone(r.guestToken)
        } catch (err) {
          const f = (err as { fields?: Record<string, string> }).fields ?? {}
          setErrors(f)
          if (!Object.keys(f).length) setError(err instanceof Error ? err.message : 'Errore')
        } finally {
          setBusy(false)
        }
      }}
    >
      <h2>{required ? 'Registrati per vedere il menu' : `Registrati e ricevi: ${data.giftText ?? ''}`}</h2>
      {error ? <div className="pm-error">{error}</div> : null}
      <div className="pm-row">
        <label>
          Nome
          <input value={v.firstName} onChange={set('firstName')} autoComplete="given-name" required />
          {errors.firstName ? <span className="pm-error">{errors.firstName}</span> : null}
        </label>
        <label>
          Cognome
          <input value={v.lastName} onChange={set('lastName')} autoComplete="family-name" required />
          {errors.lastName ? <span className="pm-error">{errors.lastName}</span> : null}
        </label>
      </div>
      <label>
        Email
        <input type="email" value={v.email} onChange={set('email')} autoComplete="email" required />
        {errors.email ? <span className="pm-error">{errors.email}</span> : null}
      </label>
      <label>
        Telefono
        <input type="tel" value={v.phone} onChange={set('phone')} autoComplete="tel" required />
        {errors.phone ? <span className="pm-error">{errors.phone}</span> : null}
      </label>
      <input name="website" value={v.website} onChange={set('website')} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: -10000, opacity: 0, width: 1, height: 1 }} />
      <label className="pm-check">
        <input type="checkbox" checked={v.privacyOk} onChange={set('privacyOk')} />
        <span>
          Ho letto l’informativa: i miei dati sono trattati da <strong>{data.company}</strong> (titolare) per registrarmi al menu digitale{data.giftText ? ' e consegnarmi l’omaggio' : ''}. Ricetta Quadra li conserva per conto del locale. Posso chiederne in ogni momento la cancellazione al locale.
        </span>
      </label>
      {errors.privacyOk ? <span className="pm-error">{errors.privacyOk}</span> : null}
      <label className="pm-check">
        <input type="checkbox" checked={v.marketing} onChange={set('marketing')} />
        <span>Facoltativo: voglio ricevere da {data.company} novità e promozioni via email o telefono.</span>
      </label>
      <button className="pm-btn" disabled={busy || !v.privacyOk}>
        {busy ? 'Un momento…' : required ? 'Vedi il menu' : 'Registrati'}
      </button>
      {onCancel ? (
        <button type="button" className="pm-link" onClick={onCancel}>
          No grazie, vai al menu
        </button>
      ) : null}
    </form>
  )
}
