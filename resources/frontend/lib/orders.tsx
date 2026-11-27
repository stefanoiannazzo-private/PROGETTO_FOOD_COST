'use client'

/**
 * NUOVO — Area Ordini: tipi e strumenti condivisi da sala e cucina.
 * - PIN dell'operatore sul tablet di servizio (ricordato per 2 minuti dall'ultima azione)
 * - avvisi sonori forti per il locale rumoroso (Web Audio: niente file da scaricare)
 * - schermo sempre acceso (Wake Lock) durante il servizio
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from './api'
import { useMe } from './session'

export interface SessionItem {
  id: string
  name: string
  qty: number
  unitPrice: string
  course: number
  notes: string | null
  status: 'held' | 'sent' | 'preparing' | 'ready' | 'served' | 'cancelled'
  station: string | null
  waiter: string | null
  createdAt: string
}
export interface Bill {
  label: string
  covers: number
  coverCharge: string
  coverTotal: string
  lines: Array<{ name: string; qty: number; unitPrice: string; total: string }>
  total: string
  openedAt: string
}
export interface TableSession {
  id: string
  label: string
  covers: number
  status: 'open' | 'closed' | 'cancelled'
  notes: string | null
  openedAt: string
  nextCourse: number
  heldCourse: number | null
  tables: Array<{ id: string; label: string; seats: number }>
  items: SessionItem[]
  bill: Bill
}

export const COURSE = (c: number) => (c === 0 ? 'Bevande' : c === 1 ? 'Subito' : `${c}ª uscita`)

/* ------------------------------- PIN ------------------------------- */

interface PinCtx {
  /** Esegue l'azione con il PIN dell'operatore (chiesto solo sul tablet di servizio). */
  withPin: <T>(fn: (pin: string | null) => Promise<T>) => Promise<T>
  operator: string | null
  forget: () => void
}
const Ctx = createContext<PinCtx>({ withPin: (fn) => fn(null), operator: null, forget: () => {} })
export const usePin = () => useContext(Ctx)

const REMEMBER_MS = 120_000

export function PinProvider({ children }: { children: ReactNode }) {
  const me = useMe().data
  const service = !!me?.serviceDevice
  const [asking, setAsking] = useState<null | { resolve: (pin: string) => void; reject: () => void }>(null)
  const [operator, setOperator] = useState<string | null>(null)
  const pinRef = useRef<{ pin: string; at: number } | null>(null)

  const ask = () =>
    new Promise<string>((resolve, reject) => {
      setAsking({ resolve, reject })
    })

  const withPin = useCallback(
    async <T,>(fn: (pin: string | null) => Promise<T>): Promise<T> => {
      if (!service) return fn(null)
      let pin = pinRef.current && Date.now() - pinRef.current.at < REMEMBER_MS ? pinRef.current.pin : null
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!pin) pin = await ask()
        try {
          const out = await fn(pin)
          pinRef.current = { pin, at: Date.now() }
          return out
        } catch (e) {
          if (e instanceof ApiError && (e.code === 'pin_invalid' || e.code === 'pin_required')) {
            pinRef.current = null
            setOperator(null)
            pin = null
            continue
          }
          throw e
        }
      }
      throw new Error('PIN non riconosciuto.')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service],
  )

  const forget = () => {
    pinRef.current = null
    setOperator(null)
  }

  return (
    <Ctx.Provider value={{ withPin, operator: service ? operator : null, forget }}>
      {children}
      {asking ? (
        <PinPad
          onCancel={() => {
            asking.reject()
            setAsking(null)
          }}
          onDone={async (pin) => {
            try {
              const r = await api.post<{ name: string }>('/orders/device/whoami', { pin })
              setOperator(r.name)
              pinRef.current = { pin, at: Date.now() }
              asking.resolve(pin)
              setAsking(null)
              return null
            } catch (e) {
              return e instanceof ApiError ? e.message : 'PIN non riconosciuto.'
            }
          }}
        />
      ) : null}
    </Ctx.Provider>
  )
}

function PinPad({ onDone, onCancel }: { onDone: (pin: string) => Promise<string | null>; onCancel: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const press = (d: string) => {
    setError('')
    setPin((p) => (p.length < 6 ? p + d : p))
  }
  const submit = async () => {
    if (pin.length < 4) return
    setBusy(true)
    const err = await onDone(pin)
    setBusy(false)
    if (err) {
      setError(err)
      setPin('')
      if (navigator.vibrate) navigator.vibrate(200)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1))
      else if (e.key === 'Enter') void submit()
      else if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <div className="overlay center" style={{ zIndex: 90 }} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog pinpad" role="dialog" aria-modal="true" aria-label="Inserisci il PIN">
        <div className="card-body stack" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Chi sei?</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Inserisci il tuo PIN
          </p>
          <div className="pin-dots" aria-live="polite">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={i < pin.length ? 'on' : i >= 4 ? 'opt' : ''} />
            ))}
          </div>
          {error ? <div className="small" style={{ color: 'var(--danger, #c0392b)' }}>{error}</div> : null}
          <div className="pin-keys">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} type="button" onClick={() => press(d)}>
                {d}
              </button>
            ))}
            <button type="button" onClick={onCancel} className="muted">
              Annulla
            </button>
            <button type="button" onClick={() => press('0')}>
              0
            </button>
            <button type="button" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Cancella">
              ⌫
            </button>
          </div>
          <button className="btn primary" style={{ width: '100%', height: 52, fontSize: 17 }} disabled={pin.length < 4 || busy} onClick={() => void submit()}>
            {busy ? <span className="spinner" /> : null} Conferma
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ SUONI ------------------------------ */

let ctx: AudioContext | null = null
/** Va chiamato da un tocco dell'utente: i browser suonano solo dopo un'interazione. */
export function unlockAudio() {
  try {
    ctx = ctx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    if (ctx.state === 'suspended') void ctx.resume()
    return true
  } catch {
    return false
  }
}
export const audioReady = () => !!ctx && ctx.state === 'running'

/** Segnale forte: tre note acute ripetute (comanda nuova) o due note (pronto / VIA). */
export function alertSound(kind: 'new' | 'ready' = 'new', volume = 1) {
  if (!ctx) return
  const notes = kind === 'new' ? [1046, 1318, 1568, 1046, 1318, 1568] : [880, 1175]
  const t0 = ctx.currentTime + 0.02
  notes.forEach((f, i) => {
    const o = ctx!.createOscillator()
    const g = ctx!.createGain()
    o.type = 'square'
    o.frequency.value = f
    const at = t0 + i * 0.16
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(0.35 * volume, at + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.14)
    o.connect(g).connect(ctx!.destination)
    o.start(at)
    o.stop(at + 0.15)
  })
  if (navigator.vibrate) navigator.vibrate(kind === 'new' ? [300, 120, 300, 120, 300] : [200, 100, 200])
}

/* -------------------------- SCHERMO ACCESO -------------------------- */

export function useWakeLock(active: boolean) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    const get = async () => {
      try {
        lock = await navigator.wakeLock.request('screen')
        setOn(true)
        lock.addEventListener('release', () => setOn(false))
      } catch {
        setOn(false)
      }
    }
    void get()
    const onVis = () => document.visibilityState === 'visible' && void get()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      void lock?.release().catch(() => {})
    }
  }, [active])
  return on
}

/** Minuti trascorsi, per «da 12 min». */
export function since(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return ''
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
  return m < 1 ? 'adesso' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}
