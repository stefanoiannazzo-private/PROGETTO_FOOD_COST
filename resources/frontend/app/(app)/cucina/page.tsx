'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useMe } from '@/lib/session'
import { alertSound, audioReady, COURSE, since, unlockAudio, useWakeLock } from '@/lib/orders'
import { ErrorBox, errorMessage, Icon, Skeleton, useToast } from '@/components/ui'
import { ServiceDeviceButton } from '@/components/ServiceDevice'

/**
 * NUOVO — Cucina e bancone: comande della postazione, aggiornate ogni 3 secondi.
 * Ogni comanda nuova (o VIA) fa suonare un allarme forte e ripetuto, vibrare e lampeggiare lo schermo
 * finché qualcuno non tocca «Visto». Lo schermo resta acceso durante il servizio.
 */
interface Ticket {
  key: string
  sessionId: string
  table: string
  covers: number
  course: number
  stationId: string
  status: 'held' | 'new' | 'preparing' | 'ready' | 'cancelled'
  waiter: string | null
  sentAt: string | null
  readyAt: string | null
  items: Array<{ id: string; name: string; qty: number; notes: string | null; status: string }>
}
interface KitchenData {
  stations: Array<{ id: string; name: string; kind: string }>
  tickets: Ticket[]
}

const LS = 'rq-kitchen-stations'

export default function KitchenPage() {
  const me = useMe().data
  const qc = useQueryClient()
  const toast = useToast()
  const [started, setStarted] = useState(false)
  // NUOVO: il riquadro iniziale si può chiudere senza avviare il servizio (pagina aperta per sbaglio o solo per guardare)
  const [dismissed, setDismissed] = useState(false)
  const router = useRouter()
  const start = () => {
    unlockAudio()
    alertSound('ready', 0.6)
    setStarted(true)
  }
  const [chosen, setChosen] = useState<string[] | null>(null)
  const [alarm, setAlarm] = useState<string[]>([]) // comande nuove non ancora viste
  const [soldOut, setSoldOut] = useState(false)
  const seen = useRef<Map<string, string>>(new Map())
  const first = useRef(true)
  const wake = useWakeLock(started)

  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(LS) ?? 'null') as string[] | null
      setChosen(Array.isArray(v) ? v : [])
    } catch {
      setChosen([])
    }
  }, [])
  const stationsParam = (chosen ?? []).join(',')
  const q = useQuery({
    queryKey: ['orders', 'kitchen', stationsParam],
    queryFn: () => api.get<KitchenData>(`/orders/kitchen?stations=${encodeURIComponent(stationsParam)}`),
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
    enabled: chosen !== null,
  })

  // righe nuove (comanda nuova, aggiunta o VIA) → allarme sulla loro comanda
  useEffect(() => {
    if (!q.data) return
    const fresh: string[] = []
    for (const t of q.data.tickets) {
      for (const i of t.items) {
        const prev = seen.current.get(i.id)
        if (i.status === 'sent' && prev !== 'sent' && !first.current) fresh.push(t.key)
        seen.current.set(i.id, i.status)
      }
    }
    first.current = false
    if (fresh.length) setAlarm((a) => [...new Set([...a, ...fresh])])
  }, [q.data])
  useEffect(() => {
    if (!alarm.length || !started) return
    alertSound('new')
    const t = setInterval(() => alertSound('new'), 4000)
    return () => clearInterval(t)
  }, [alarm.length, started])
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 20_000)
    return () => clearInterval(t)
  }, [])

  const toggleStation = (id: string) => {
    const next = (chosen ?? []).includes(id) ? (chosen ?? []).filter((x) => x !== id) : [...(chosen ?? []), id]
    setChosen(next)
    try {
      localStorage.setItem(LS, JSON.stringify(next))
    } catch {
      /* niente */
    }
    first.current = true
  }
  const setStatus = async (t: Ticket, status: 'preparing' | 'ready' | 'sent' | 'served') => {
    setAlarm((a) => a.filter((k) => k !== t.key))
    try {
      await api.post('/orders/kitchen/status', { ids: t.items.filter((i) => i.status !== 'cancelled' && i.status !== 'held').map((i) => i.id), status })
      void qc.invalidateQueries({ queryKey: ['orders', 'kitchen'] })
    } catch (e) {
      toast(errorMessage(e))
    }
  }

  const data = q.data
  const active = data?.tickets.filter((t) => t.status === 'new' || t.status === 'preparing') ?? []
  const ready = data?.tickets.filter((t) => t.status === 'ready') ?? []
  const held = data?.tickets.filter((t) => t.status === 'held') ?? []
  const stationName = (id: string) => data?.stations.find((s) => s.id === id)?.name ?? ''
  const showStation = (chosen ?? []).length !== 1

  return (
    <div className={`kitchen ${alarm.length ? 'alarm' : ''}`}>
      <div className="kitchen-head">
        <div className="grow">
          <h1>Cucina e bancone</h1>
          <div className="station-chips">
            {data?.stations.map((s) => (
              <button key={s.id} type="button" aria-pressed={(chosen ?? []).includes(s.id)} onClick={() => toggleStation(s.id)}>
                {s.name}
              </button>
            ))}
            {data && !(chosen ?? []).length ? <span className="small muted">Tutte le postazioni · tocca per scegliere quella di questo schermo</span> : null}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className={`badge ${started && audioReady() ? 'ok' : 'warn'}`}>{started && audioReady() ? 'suono attivo' : 'suono spento'}</span>
          {!started && dismissed ? (
            <button className="btn sm primary" onClick={start}>
              <Icon name="bell" /> Inizia il servizio
            </button>
          ) : null}
          {started ? <span className={`badge ${wake ? 'ok' : ''}`}>{wake ? 'schermo sempre acceso' : 'schermo normale'}</span> : null}
          <button className="btn sm" onClick={() => setSoldOut(true)}>
            Esauriti
          </button>
          {me?.role === 'admin' || me?.serviceDevice ? <ServiceDeviceButton /> : null}
        </div>
      </div>

      {alarm.length ? (
        <button className="alarm-bar" onClick={() => setAlarm([])}>
          <Icon name="bell" /> {alarm.length === 1 ? 'Nuova comanda' : `${alarm.length} nuove comande`} · tocca per dire «visto»
        </button>
      ) : null}

      {q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !data ? (
        <Skeleton />
      ) : (
        <>
          {!active.length && !ready.length ? <div className="kitchen-empty">Nessuna comanda da preparare. Le nuove arriveranno qui con un segnale sonoro.</div> : null}
          <div className="tickets">
            {active.map((t) => (
              <TicketCard key={t.key} t={t} flash={alarm.includes(t.key)} station={showStation ? stationName(t.stationId) : null} onStatus={(st) => void setStatus(t, st)} />
            ))}
          </div>
          {ready.length ? (
            <>
              <h2 className="kitchen-sub">Pronti · da ritirare</h2>
              <div className="tickets">
                {ready.map((t) => (
                  <TicketCard key={t.key} t={t} station={showStation ? stationName(t.stationId) : null} onStatus={(st) => void setStatus(t, st)} />
                ))}
              </div>
            </>
          ) : null}
          {held.length ? (
            <>
              <h2 className="kitchen-sub">In attesa del VIA</h2>
              <div className="tickets">
                {held.map((t) => (
                  <TicketCard key={t.key} t={t} station={showStation ? stationName(t.stationId) : null} />
                ))}
              </div>
            </>
          ) : null}
        </>
      )}

      {!started && !dismissed ? (
        <div className="overlay center" style={{ zIndex: 80 }} onClick={(e) => e.target === e.currentTarget && setDismissed(true)}>
          <div className="dialog" role="dialog" aria-modal="true" style={{ position: 'relative' }}>
            <button className="btn ghost icon" style={{ position: 'absolute', top: 8, right: 8 }} aria-label="Chiudi" onClick={() => setDismissed(true)}>
              <Icon name="x" />
            </button>
            <div className="card-body stack" style={{ textAlign: 'center', alignItems: 'center' }}>
              <span className="reminder-ic" style={{ width: 64, height: 64 }}>
                <Icon name="bell" size={30} />
              </span>
              <h2 style={{ margin: 0 }}>Inizia il servizio</h2>
              <p className="muted" style={{ margin: 0 }}>
                Attiva l’allarme sonoro per le nuove comande e tieni lo schermo acceso. Alza il volume del dispositivo e lascia questa pagina aperta.
              </p>
              <button
                className="btn primary"
                style={{ height: 56, fontSize: 18, width: '100%' }}
                onClick={start}
              >
                Inizia il servizio
              </button>
              <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => setDismissed(true)}>
                  Guarda senza allarme
                </button>
                <button className="btn ghost" onClick={() => (window.history.length > 1 ? router.back() : router.push('/'))}>
                  ‹ Torna indietro
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {soldOut ? <SoldOut onClose={() => setSoldOut(false)} /> : null}
    </div>
  )
}

function TicketCard({ t, flash, station, onStatus }: { t: Ticket; flash?: boolean; station: string | null; onStatus?: (s: 'preparing' | 'ready' | 'sent' | 'served') => void }) {
  const mins = t.sentAt ? (Date.now() - new Date(t.sentAt).getTime()) / 60000 : 0
  const late = t.status !== 'ready' && t.status !== 'held' ? (mins > 25 ? 'late2' : mins > 15 ? 'late1' : '') : ''
  return (
    <div className={`ticket ${t.status} ${late} ${flash ? 'flash' : ''}`}>
      <div className="ticket-head">
        <strong className="ticket-table">{t.table}</strong>
        <span className="ticket-course">{COURSE(t.course)}</span>
        <span className="grow" />
        <span className="ticket-time">{t.status === 'held' ? 'attende' : t.status === 'ready' ? since(t.readyAt) === 'adesso' ? 'pronto adesso' : `pronto da ${since(t.readyAt)}` : since(t.sentAt)}</span>
      </div>
      <div className="ticket-meta small">
        {t.covers} coperti{t.waiter ? ` · ${t.waiter}` : ''}
        {station ? ` · ${station}` : ''}
      </div>
      <ul className="ticket-items">
        {t.items.map((i) => (
          <li key={i.id} className={i.status === 'cancelled' ? 'cancelled' : ''}>
            <span className="tq">{i.qty}</span>
            <span>
              {i.name}
              {i.status === 'cancelled' ? <em> · ANNULLATO</em> : null}
              {i.notes ? <span className="tnote">{i.notes}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {onStatus ? (
        <div className="ticket-actions">
          {t.status === 'new' ? (
            <>
              <button className="btn" onClick={() => onStatus('preparing')}>
                In preparazione
              </button>
              <button className="btn primary" onClick={() => onStatus('ready')}>
                Pronto
              </button>
            </>
          ) : t.status === 'preparing' ? (
            <button className="btn primary" style={{ flex: 1 }} onClick={() => onStatus('ready')}>
              Pronto
            </button>
          ) : t.status === 'ready' ? (
            <>
              <button className="btn ghost sm" onClick={() => onStatus('preparing')}>
                Non ancora
              </button>
              <button className="btn sm" onClick={() => onStatus('served')}>
                Ritirato
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function SoldOut({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['orders', 'menu'], queryFn: () => api.get<{ sections: Array<{ id: string; name: string; items: Array<{ id: string; name: string; isAvailable: boolean }> }> }>('/orders/menu') })
  const toggle = async (id: string, isAvailable: boolean) => {
    try {
      await api.patch(`/orders/setup/items/${id}/availability`, { isAvailable })
      void qc.invalidateQueries({ queryKey: ['orders', 'menu'] })
    } catch (e) {
      toast(errorMessage(e))
    }
  }
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Piatti esauriti">
        <div className="drawer-head">
          <h2>Piatti esauriti oggi</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Chiudi">
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">
          {!q.data ? (
            <Skeleton />
          ) : (
            q.data.sections.map((s) => (
              <div key={s.id} style={{ marginBottom: 12 }}>
                <div className="section-title">{s.name}</div>
                {s.items.map((i) => (
                  <label key={i.id} className="row between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ textDecoration: i.isAvailable ? 'none' : 'line-through' }}>{i.name}</span>
                    <span className="row small" style={{ gap: 6 }}>
                      <input type="checkbox" checked={!i.isAvailable} onChange={(e) => void toggle(i.id, !e.target.checked)} /> esaurito
                    </span>
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
