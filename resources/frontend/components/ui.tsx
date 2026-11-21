'use client'

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { toApiNumber, toInputText } from '@/lib/num'
import { ApiError } from '@/lib/api'

/* ============================== icone ============================== */
const paths: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  menu: 'M3 6h18M3 12h18M3 18h18',
  up: 'm18 15-6-6-6 6',
  down: 'm6 9 6 6 6-6',
  chevron: 'm9 18 6-6-6-6',
  copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  check: 'M20 6 9 17l-5-5',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
}
export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? ''} />
    </svg>
  )
}

/* ============================== campi ============================== */
export function Field({ label, hint, error, children, htmlFor, required }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  )
}

/**
 * Campo numerico all'italiana: mostra e accetta "1.234,5" e restituisce il valore normalizzato ("1234.5").
 * Un testo non valido resta visibile e segnalato, senza perdere quanto digitato.
 */
export function NumberInput({
  value,
  onChange,
  suffix,
  id,
  invalid,
  placeholder,
  ariaLabel,
  disabled,
  onBlur,
}: {
  value: string | null | undefined
  onChange: (v: string | null) => void
  suffix?: ReactNode
  id?: string
  invalid?: boolean
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  onBlur?: () => void
}) {
  const [text, setText] = useState(toInputText(value))
  const [bad, setBad] = useState(false)
  const last = useRef(value)
  useEffect(() => {
    if (value !== last.current) {
      last.current = value
      setText(toInputText(value))
      setBad(false)
    }
  }, [value])
  const input = (
    <input
      id={id}
      className="input num-input"
      inputMode="decimal"
      autoComplete="off"
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-invalid={invalid || bad}
      disabled={disabled}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        const n = toApiNumber(t)
        setBad(n === null)
        const next = n === null ? null : n === '' ? null : n
        last.current = next
        if (n !== null) onChange(next)
      }}
      onBlur={() => {
        if (!bad) setText(toInputText(last.current))
        onBlur?.()
      }}
    />
  )
  if (!suffix) return input
  return (
    <div className="input-group">
      {input}
      {typeof suffix === 'string' ? <span className="addon">{suffix}</span> : suffix}
    </div>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props
  return <input className={`input ${className ?? ''}`} aria-invalid={invalid || undefined} {...rest} />
}

/* ============================== stati ============================== */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  )
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : 'Si è verificato un errore imprevisto.'
  return (
    <div className="alert err" role="alert">
      <Icon name="alert" />
      <div className="grow">{msg}</div>
      {retry ? (
        <button className="btn sm" onClick={retry}>
          Riprova
        </button>
      ) : null}
    </div>
  )
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 16 }} aria-busy="true" aria-label="Caricamento">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ width: `${70 + ((i * 13) % 30)}%` }} />
      ))}
    </div>
  )
}

/* ============================== drawer/dialog ============================== */
export function Drawer({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const id = useId()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="drawer-head">
          <h2 id={id}>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Chiudi">
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Confirm({ title, message, confirmLabel = 'Conferma', danger, onConfirm, onCancel, busy }: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="alertdialog" aria-modal="true">
        <div className="card-body stack">
          <h2>{title}</h2>
          <div className="muted">{message}</div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onCancel} autoFocus>
              Annulla
            </button>
            <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============================== toast ============================== */
type Toast = { id: number; text: ReactNode; kind: 'ok' | 'err' }
const ToastCtx = createContext<(text: ReactNode, kind?: 'ok' | 'err') => void>(() => {})
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: ReactNode, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, text, kind }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 3500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx)

/* ============================== varie ============================== */
export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    draft: ['Bozza', ''],
    active: ['Attiva', 'ok'],
    archived: ['Archiviata', 'warn'],
    inactive: ['Non attivo', ''],
    maintenance: ['In manutenzione', 'warn'],
  }
  const [label, cls] = map[status] ?? [status, '']
  return <span className={`badge ${cls}`}>{label}</span>
}

export function CompletenessBadge({ complete, errors }: { complete: boolean; errors?: number }) {
  return complete ? <span className="badge ok">Completo</span> : <span className="badge err" title="Valorizzazione incompleta">Incompleto{errors ? ` · ${errors}` : ''}</span>
}

/** Errori di validazione dal server, campo per campo. */
export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError ? e.fields : {}
}
export function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Si è verificato un errore imprevisto.'
}

export function AffectedNotice({ recipes }: { recipes: Array<{ id: string; code: string; title: string }> }) {
  if (!recipes.length) return null
  return (
    <div className="alert info">
      <Icon name="layers" />
      <div>
        <strong>Ricette interessate dalla modifica ({recipes.length}):</strong> {recipes.slice(0, 8).map((r) => r.title).join(', ')}
        {recipes.length > 8 ? ` e altre ${recipes.length - 8}` : ''}. Le valorizzazioni correnti sono state aggiornate; gli snapshot salvati restano invariati.
      </div>
    </div>
  )
}
