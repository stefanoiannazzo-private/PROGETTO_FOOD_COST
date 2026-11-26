'use client'

/**
 * NUOVO — Promemoria mensile «carica fatture e bollette».
 * Dal 10 del mese compare all'apertura dell'app (o del sito) e alle 3 aperture successive.
 * Un'«apertura» è una nuova sessione della scheda o dell'app: cambiare pagina o ricaricare non conta.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { dateTime } from '@/lib/num'
import { Icon } from './ui'

interface Reminder {
  due: boolean
  period: string
  monthLabel: string
  timesLeft: number
  canInvoices: boolean
  canBills: boolean
  status: { invoicesThisMonth: number | null; lastInvoiceAt: string | null; billsThisMonth: number | null; lastBillAt: string | null }
}

const KEY = 'rq-reminder-checked'

export function MonthlyReminder({ companyId, blocked }: { companyId: string; blocked: boolean }) {
  const router = useRouter()
  const [r, setR] = useState<Reminder | null>(null)

  useEffect(() => {
    if (blocked) return
    let checked = ''
    try {
      checked = sessionStorage.getItem(KEY) ?? ''
    } catch {
      /* sessione privata */
    }
    if (checked === companyId) return
    let alive = true
    const t = setTimeout(async () => {
      try {
        const cur = await api.get<Reminder>('/reminders/current')
        try {
          sessionStorage.setItem(KEY, companyId)
        } catch {
          /* niente */
        }
        if (alive && cur.due) {
          setR(cur)
          void api.post('/reminders/seen', { period: cur.period }).catch(() => {})
        }
      } catch {
        /* nessun promemoria se la rete non risponde */
      }
    }, 1200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [companyId, blocked])

  useEffect(() => {
    if (!r) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setR(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [r])

  if (!r) return null
  const go = (href: string) => {
    setR(null)
    router.push(href)
  }
  const done = () => {
    void api.post('/reminders/done', { period: r.period }).catch(() => {})
    setR(null)
  }
  const s = r.status

  return (
    <div className="overlay center reminder-overlay" onMouseDown={(e) => e.target === e.currentTarget && setR(null)}>
      <div className="dialog reminder" role="dialog" aria-modal="true" aria-labelledby="rem-title">
        <div className="card-body stack">
          <div className="reminder-head">
            <span className="reminder-ic">
              <Icon name="alert" />
            </span>
            <div>
              <h2 id="rem-title">È ora di aggiornare i costi di {r.monthLabel}</h2>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Fatture e bollette nuove cambiano il costo delle ricette: caricale così i prezzi restano giusti.
              </p>
            </div>
          </div>
          <div className="reminder-items">
            {r.canInvoices ? (
              <div className="reminder-item">
                <div>
                  <strong>Fatture dei fornitori</strong>
                  <div className="small muted">
                    {s.invoicesThisMonth ? `${s.invoicesThisMonth} caricate questo mese` : 'Nessuna caricata questo mese'}
                    {s.lastInvoiceAt ? ` · ultima il ${dateTime(s.lastInvoiceAt)}` : ''}
                  </div>
                </div>
                <button className="btn primary" onClick={() => go('/importazioni?azione=fattura')}>
                  <Icon name="upload" /> Carica fatture
                </button>
              </div>
            ) : null}
            {r.canBills ? (
              <div className="reminder-item">
                <div>
                  <strong>Bollette di luce, gas e acqua</strong>
                  <div className="small muted">
                    {s.billsThisMonth ? `${s.billsThisMonth} caricate questo mese` : 'Nessuna caricata questo mese'}
                    {s.lastBillAt ? ` · ultima il ${dateTime(s.lastBillAt)}` : ''}
                  </div>
                </div>
                <button className="btn" onClick={() => go('/utenze')}>
                  <Icon name="bolt" /> Carica bolletta
                </button>
              </div>
            ) : null}
          </div>
          <div className="row between wrap" style={{ gap: 8 }}>
            <span className="small faint">{r.timesLeft > 0 ? `Te lo ricorderemo ancora ${r.timesLeft === 1 ? 'una volta' : `${r.timesLeft} volte`} questo mese.` : 'È l’ultimo promemoria di questo mese.'}</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost" onClick={done}>
                Ho già fatto
              </button>
              <button className="btn" onClick={() => setR(null)} autoFocus>
                Più tardi
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
