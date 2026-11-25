'use client'

/**
 * NUOVO — Pezzi condivisi dell'assistenza: chiamata (solo da smartphone), conversazione, risposta con allegato.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/num'
import { platform } from '@/lib/pwa'
import { Icon, errorMessage } from './ui'

export interface SupportInfo {
  phone: string
  hours: string
  areas: Record<string, string>
  kinds: Record<string, string>
  maxBytes: number
}

export interface SupportMessage {
  id: string
  fromStaff: boolean
  author: string | null
  body: string
  attachment: { name: string; mime: string; url: string } | null
  createdAt: string
}

export interface Ticket {
  id: string
  number: number
  area: string
  areaLabel: string
  kind: string
  kindLabel: string
  subject: string
  status: 'open' | 'answered' | 'closed'
  createdAt: string
  updatedAt: string
  messageCount: number
  unread?: boolean
  userName: string
  company?: string
  companyId?: string
  userEmail?: string
  contactPhone?: string | null
  pageUrl?: string | null
  userAgent?: string | null
  messages?: SupportMessage[]
}

export const STATUS: Record<Ticket['status'], { label: string; cls: string }> = {
  open: { label: 'In attesa di risposta', cls: 'warn' },
  answered: { label: 'Risposta ricevuta', cls: 'ok' },
  closed: { label: 'Chiusa', cls: '' },
}

export function useSupportInfo() {
  return useQuery({ queryKey: ['support', 'info'], queryFn: () => api.get<SupportInfo>('/support/info'), staleTime: 3600_000 })
}

/** "+393917326882" → "+39 391 732 6882" */
export function formatPhone(p: string): string {
  const d = p.replace(/[^\d+]/g, '')
  const m = d.match(/^(\+39)(\d{3})(\d{3})(\d{3,4})$/)
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : p
}

/** Su smartphone il numero è un pulsante che avvia la chiamata; su computer si mostra e si copia. */
export function CallSupport({ phone, hours }: { phone: string; hours?: string }) {
  const [mobile, setMobile] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => setMobile(platform() !== 'desktop'), [])
  const nice = formatPhone(phone)
  return (
    <div className="stack" style={{ gap: 8 }}>
      {mobile ? (
        <a className="btn primary call-btn" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>
          <Icon name="phone" /> Chiama {nice}
        </a>
      ) : (
        <div className="row wrap" style={{ alignItems: 'center', gap: 10 }}>
          <span className="call-number">{nice}</span>
          <button
            className="btn sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(phone)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              } catch {
                /* appunti non disponibili */
              }
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} /> {copied ? 'Copiato' : 'Copia'}
          </button>
        </div>
      )}
      <span className="small muted">
        {mobile ? 'Il pulsante avvia la chiamata.' : 'Dallo smartphone, nel pannello Assistenza, il numero avvia direttamente la chiamata.'}
        {hours ? ` Orari: ${hours}.` : ''}
      </span>
    </div>
  )
}

export function Thread({ messages }: { messages: SupportMessage[] }) {
  return (
    <ol className="thread">
      {messages.map((m) => (
        <li key={m.id} className={m.fromStaff ? 'from-staff' : 'from-user'}>
          <div className="thread-head">
            <strong>{m.author ?? '—'}</strong>
            <span className="faint small">{dateTime(m.createdAt)}</span>
          </div>
          <div className="thread-body">{m.body}</div>
          {m.attachment ? (
            m.attachment.mime.startsWith('image/') ? (
              <a href={m.attachment.url} target="_blank" rel="noreferrer" className="thread-img">
                <img src={m.attachment.url} alt={m.attachment.name} loading="lazy" />
              </a>
            ) : (
              <a className="link small" href={m.attachment.url} target="_blank" rel="noreferrer">
                <Icon name="download" size={14} /> {m.attachment.name}
              </a>
            )
          ) : null}
        </li>
      ))}
    </ol>
  )
}

/** Campo allegato (screenshot o PDF), con anteprima del nome e rimozione. */
export function AttachmentInput({ file, onChange, maxBytes }: { file: File | null; onChange: (f: File | null) => void; maxBytes: number }) {
  const [err, setErr] = useState('')
  return (
    <div className="stack" style={{ gap: 4 }}>
      {file ? (
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          <Icon name="check" size={14} /> <span className="small">{file.name}</span>
          <button type="button" className="btn ghost sm" onClick={() => onChange(null)}>
            Togli
          </button>
        </div>
      ) : (
        <label className="btn sm attach-btn">
          <Icon name="upload" size={14} /> Allega uno screenshot o un PDF
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              e.target.value = ''
              if (f && f.size > maxBytes) {
                setErr(`File troppo grande (massimo ${Math.round(maxBytes / 1048576)} MB).`)
                return
              }
              setErr('')
              onChange(f)
            }}
          />
        </label>
      )}
      {err ? <span className="error">{err}</span> : <span className="small faint">Facoltativo: uno screenshot spesso vale più di mille parole.</span>}
    </div>
  )
}

/** Risposta in una conversazione (cliente o supporto). */
export function ReplyBox({ endpoint, maxBytes, onSent, placeholder }: { endpoint: string; maxBytes: number; onSent: () => void; placeholder?: string }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!text.trim()) return
        setBusy(true)
        setError('')
        try {
          const fd = new FormData()
          fd.append('message', text)
          if (file) fd.append('attachment', file)
          await api.upload(endpoint, fd)
          setText('')
          setFile(null)
          onSent()
        } catch (err) {
          setError(errorMessage(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder ?? 'Scrivi un messaggio…'} aria-label="Messaggio" />
      <AttachmentInput file={file} onChange={setFile} maxBytes={maxBytes} />
      {error ? <div className="alert err">{error}</div> : null}
      <div>
        <button className="btn primary" disabled={busy || !text.trim()}>
          {busy ? <span className="spinner" /> : <Icon name="send" />} Invia
        </button>
      </div>
    </form>
  )
}
