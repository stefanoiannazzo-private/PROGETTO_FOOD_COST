'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useMe } from '@/lib/session'
import { alertSound, PinProvider, since, unlockAudio, usePin, type TableSession } from '@/lib/orders'
import { PageHead } from '@/components/AppShell'
import { Empty, ErrorBox, errorMessage, Icon, Skeleton, useToast } from '@/components/ui'
import { ServiceDeviceButton } from '@/components/ServiceDevice'

/** NUOVO — Sala: mappa dei tavoli, apertura con i coperti, unione di più tavoli. */
interface Floor {
  areas: Array<{ id: string; name: string }>
  tables: Array<{ id: string; label: string; seats: number; areaId: string | null; sessionId: string | null }>
  sessions: Array<{ id: string; label: string; covers: number; openedAt: string; held: number; inKitchen: number; ready: number }>
}

export default function SalaPage() {
  return (
    <PinProvider>
      <Sala />
    </PinProvider>
  )
}

function Sala() {
  const router = useRouter()
  const me = useMe().data
  const { operator, forget } = usePin()
  const [area, setArea] = useState<string>('all')
  const [opening, setOpening] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['orders', 'floor'], queryFn: () => api.get<Floor>('/orders/floor'), refetchInterval: 5000, refetchIntervalInBackground: false })
  const readyTotal = q.data?.sessions.reduce((a, s) => a + s.ready, 0) ?? 0
  const lastReady = useRef(readyTotal)
  useEffect(() => {
    if (readyTotal > lastReady.current) alertSound('ready', 0.7)
    lastReady.current = readyTotal
  }, [readyTotal])
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const data = q.data
  const sess = new Map(data?.sessions.map((s) => [s.id, s]))
  const tables = data?.tables.filter((t) => area === 'all' || t.areaId === area || (area === 'none' && !t.areaId)) ?? []
  const busy = data?.sessions.length ?? 0

  return (
    <div onPointerDown={() => unlockAudio()}>
      <PageHead
        title="Sala"
        sub={data ? `${busy} tavoli aperti · ${data.sessions.reduce((a, s) => a + s.covers, 0)} coperti${readyTotal ? ` · ${readyTotal} ${readyTotal === 1 ? 'piatto pronto' : 'piatti pronti'} da portare` : ''}` : undefined}
        actions={
          <div className="row" style={{ gap: 6 }}>
            {operator ? (
              <button className="btn ghost sm" onClick={forget} title="Cambia operatore">
                <Icon name="users" /> {operator} · cambia
              </button>
            ) : null}
            {me?.role === 'admin' || me?.serviceDevice ? <ServiceDeviceButton /> : null}
          </div>
        }
      />
      {data && data.areas.length ? (
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={area === 'all'} onClick={() => setArea('all')}>
            Tutte
          </button>
          {data.areas.map((a) => (
            <button key={a.id} role="tab" aria-selected={area === a.id} onClick={() => setArea(a.id)}>
              {a.name}
            </button>
          ))}
        </div>
      ) : null}
      {q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !data ? (
        <Skeleton />
      ) : !data.tables.length ? (
        <div className="card">
          <Empty title="Nessun tavolo">Chiedi all’amministratore di creare i tavoli in «Menu e tavoli».</Empty>
        </div>
      ) : (
        <div className="floor">
          {tables.map((t) => {
            const s = t.sessionId ? sess.get(t.sessionId) : undefined
            return (
              <button
                key={t.id}
                type="button"
                className={`floor-table ${s ? 'busy' : 'free'} ${s?.ready ? 'ready' : ''}`}
                onClick={() => (s ? router.push(`/sala/${s.id}`) : setOpening(t.id))}
              >
                <span className="ft-label">{s ? s.label : t.label}</span>
                {s ? (
                  <>
                    <span className="ft-meta">
                      {s.covers} <Icon name="users" size={13} /> · {since(s.openedAt)}
                    </span>
                    <span className="ft-badges">
                      {s.ready ? <span className="badge ok">{s.ready} {s.ready === 1 ? 'pronto' : 'pronti'}</span> : null}
                      {s.held ? <span className="badge warn">VIA</span> : null}
                      {s.inKitchen ? <span className="badge info">{s.inKitchen} in cucina</span> : null}
                    </span>
                  </>
                ) : (
                  <span className="ft-meta">{t.seats} posti · libero</span>
                )}
              </button>
            )
          })}
        </div>
      )}
      {opening && data ? <OpenTable floor={data} first={opening} onClose={() => setOpening(null)} onOpened={(id) => router.push(`/sala/${id}`)} /> : null}
    </div>
  )
}

function OpenTable({ floor, first, onClose, onOpened }: { floor: Floor; first: string; onClose: () => void; onOpened: (id: string) => void }) {
  const toast = useToast()
  const { withPin } = usePin()
  const [covers, setCovers] = useState<number | null>(null)
  const [more, setMore] = useState<string[]>([])
  const [joining, setJoining] = useState(false)
  const [busy, setBusy] = useState(false)
  const table = floor.tables.find((t) => t.id === first)!
  const free = floor.tables.filter((t) => !t.sessionId && t.id !== first)
  const seats = [table, ...free.filter((t) => more.includes(t.id))].reduce((a, t) => a + t.seats, 0)
  const labels = [table, ...free.filter((t) => more.includes(t.id))].map((t) => t.label)
  const open = async () => {
    if (covers === null) return
    setBusy(true)
    try {
      const s = await withPin((pin) => api.post<TableSession>('/orders/sessions', { tableIds: [first, ...more], covers, pin }))
      onOpened(s.id)
    } catch (e) {
      if (e instanceof Error && e.message) toast(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog open-table" role="dialog" aria-modal="true" aria-labelledby="ot-title">
        <div className="card-body stack">
          <h2 id="ot-title" style={{ margin: 0 }}>
            Apri il tavolo {labels.sort((a, b) => a.localeCompare(b, 'it', { numeric: true })).join('-')}
          </h2>
          <div className="small muted">Quante persone? {seats} posti</div>
          <div className="covers-grid">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <button key={n} type="button" aria-pressed={covers === n} onClick={() => setCovers(n)}>
                {n}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="small">Altro:</span>
            <input className="input" style={{ width: 90 }} inputMode="numeric" value={covers && covers > 12 ? covers : ''} onChange={(e) => setCovers(Number(e.target.value.replace(/\D/g, '')) || null)} placeholder="es. 18" />
          </div>
          {joining ? (
            <div>
              <div className="small" style={{ marginBottom: 6 }}>
                Unisci anche (tavoli liberi):
              </div>
              <div className="join-grid">
                {free.map((t) => (
                  <button key={t.id} type="button" aria-pressed={more.includes(t.id)} onClick={() => setMore((m) => (m.includes(t.id) ? m.filter((x) => x !== t.id) : [...m, t.id]))}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setJoining(true)} disabled={!free.length}>
              <Icon name="plus" /> Unisci altri tavoli (tavolata)
            </button>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={onClose}>
              Annulla
            </button>
            <button className="btn primary" disabled={covers === null || busy} onClick={() => void open()} style={{ minWidth: 140 }}>
              {busy ? <span className="spinner" /> : null} Apri tavolo
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
