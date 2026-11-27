'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { euro } from '@/lib/num'
import { alertSound, COURSE, PinProvider, since, unlockAudio, usePin, type Bill, type SessionItem, type TableSession } from '@/lib/orders'
import { ErrorBox, errorMessage, Icon, Skeleton, useToast } from '@/components/ui'

/** NUOVO — Tavolo aperto: comanda con portate («subito» / «a seguire»), bevande e note, VIA, unione tavoli, preconto e chiusura. */
interface MenuData {
  sections: Array<{ id: string; name: string; isDrinks: boolean; items: Array<{ id: string; name: string; description: string | null; price: string; isAvailable: boolean }> }>
  coverCharge: string
}
interface CartLine {
  key: string
  menuItemId: string
  name: string
  price: string
  qty: number
  course: number
  isDrinks: boolean
  notes: string
}

const STATUS: Record<SessionItem['status'], { label: string; cls: string }> = {
  held: { label: 'attende il VIA', cls: 'warn' },
  sent: { label: 'in cucina', cls: 'info' },
  preparing: { label: 'in preparazione', cls: 'info' },
  ready: { label: 'pronto', cls: 'ok' },
  served: { label: 'servito', cls: '' },
  cancelled: { label: 'annullato', cls: '' },
}

export default function TablePage() {
  return (
    <PinProvider>
      <Table />
    </PinProvider>
  )
}

function Table() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const { withPin, operator } = usePin()
  const q = useQuery({ queryKey: ['orders', 'session', id], queryFn: () => api.get<TableSession>(`/orders/sessions/${id}`), refetchInterval: 5000 })
  const menu = useQuery({ queryKey: ['orders', 'menu'], queryFn: () => api.get<MenuData>('/orders/menu'), staleTime: 30_000 })
  const [cart, setCart] = useState<CartLine[]>([])
  const [course, setCourse] = useState(1)
  const [section, setSection] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [joining, setJoining] = useState(false)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const s = q.data

  const readyCount = s?.items.filter((i) => i.status === 'ready').length ?? 0
  const lastReady = useRef(readyCount)
  useEffect(() => {
    if (readyCount > lastReady.current) alertSound('ready', 0.7)
    lastReady.current = readyCount
  }, [readyCount])
  useEffect(() => {
    if (!section && menu.data?.sections[0]) setSection(menu.data.sections[0].id)
  }, [menu.data, section])

  const set = (data: TableSession) => qc.setQueryData(['orders', 'session', id], data)
  const run = async (key: string, fn: (pin: string | null) => Promise<TableSession | void>) => {
    setBusy(key)
    try {
      const out = await withPin(fn)
      if (out) set(out)
      qc.invalidateQueries({ queryKey: ['orders', 'floor'] })
      return true
    } catch (e) {
      if (e instanceof ApiError || (e instanceof Error && e.message)) toast(errorMessage(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  const add = (it: MenuData['sections'][number]['items'][number], isDrinks: boolean) => {
    if (!it.isAvailable) return
    unlockAudio()
    const c = isDrinks ? 0 : course
    setCart((cur) => {
      const same = cur.find((l) => l.menuItemId === it.id && l.course === c && !l.notes)
      if (same) return cur.map((l) => (l === same ? { ...l, qty: l.qty + 1 } : l))
      return [...cur, { key: `${it.id}-${c}-${Date.now()}`, menuItemId: it.id, name: it.name, price: it.price, qty: 1, course: c, isDrinks, notes: '' }]
    })
  }
  const send = async () => {
    const ok = await run('send', (pin) =>
      api.post<TableSession>(`/orders/sessions/${id}/send`, { items: cart.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty, course: l.isDrinks ? 1 : l.course, notes: l.notes.trim() || null })), pin }),
    )
    if (ok) {
      setCart([])
      setCourse(1)
      toast('Comanda inviata.')
    }
  }
  const cartTotal = cart.reduce((a, l) => a + Number(l.price) * l.qty, 0)
  const byCourse = useMemo(() => {
    const m = new Map<number, SessionItem[]>()
    for (const it of s?.items ?? []) m.set(it.course, [...(m.get(it.course) ?? []), it])
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [s?.items])
  const heldCount = s?.items.filter((i) => i.status === 'held' && i.course === s.heldCourse).length ?? 0

  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!s) return <Skeleton />
  if (s.status !== 'open') {
    return (
      <div className="card card-body stack">
        <h2>Tavolo {s.label} chiuso</h2>
        <Link className="btn" href="/sala">
          Torna alla sala
        </Link>
      </div>
    )
  }
  const sec = menu.data?.sections.find((x) => x.id === section)

  return (
    <div className="order-page" onPointerDown={() => unlockAudio()}>
      <div className="order-head">
        <Link href="/sala" className="btn ghost sm">
          ‹ Sala
        </Link>
        <div className="grow">
          <h1>Tavolo {s.label}</h1>
          <div className="small muted">
            <button type="button" className="link-btn" style={{ fontWeight: 500 }} onClick={() => {
              const n = window.prompt('Quanti coperti?', String(s.covers))
              if (n !== null && /^\d+$/.test(n)) void run('covers', () => api.patch<TableSession>(`/orders/sessions/${id}`, { covers: Number(n) }))
            }}>
              {s.covers} coperti
            </button>{' '}
            · aperto da {since(s.openedAt)}
            {operator ? ` · ${operator}` : ''}
          </div>
        </div>
        <button className="btn ghost sm" onClick={() => setJoining(true)}>
          <Icon name="plus" /> Unisci
        </button>
        <button className="btn sm" onClick={() => setClosing(true)}>
          Conto
        </button>
      </div>

      {s.heldCourse !== null ? (
        <button className="go-btn" disabled={busy === 'go'} onClick={() => void run('go', (pin) => api.post<TableSession>(`/orders/sessions/${id}/go`, { pin }))}>
          {busy === 'go' ? <span className="spinner" /> : null} VIA {COURSE(s.heldCourse).toLowerCase()} · {heldCount} {heldCount === 1 ? 'piatto' : 'piatti'}
        </button>
      ) : null}
      {readyCount ? (
        <button className="ready-btn" onClick={() => void run('served', () => api.post<TableSession>(`/orders/sessions/${id}/served`))}>
          {readyCount === 1 ? '1 piatto pronto: tocca quando l’hai portato' : `${readyCount} piatti pronti: tocca quando li hai portati`}
        </button>
      ) : null}

      {s.items.length ? (
        <div className="card ordered">
          {byCourse.map(([c, items]) => (
            <div key={c} className="ordered-course">
              <div className="ordered-title">{COURSE(c)}</div>
              {items.map((it) => (
                <div key={it.id} className={`ordered-line ${it.status}`}>
                  <span className="qty">{it.qty}×</span>
                  <span className="grow">
                    {it.name}
                    {it.notes ? <span className="small muted"> · {it.notes}</span> : null}
                  </span>
                  <span className={`badge ${STATUS[it.status].cls}`}>{STATUS[it.status].label}</span>
                  {!['served', 'cancelled'].includes(it.status) ? (
                    <button
                      className="btn ghost sm"
                      aria-label={`Annulla ${it.name}`}
                      onClick={() => {
                        if (window.confirm(`Annullare ${it.qty}× ${it.name}?${it.status !== 'held' ? ' La cucina lo vedrà barrato.' : ''}`)) void run(`c${it.id}`, (pin) => api.post<TableSession>(`/orders/items/${it.id}/cancel`, { pin }))
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* ----------------------------- nuova comanda ----------------------------- */}
      <div className="card composer">
        <div className="composer-course">
          <span className="small muted">I piatti che tocchi vanno in:</span>
          <div className="seg">
            {[1, 2, 3].map((c) => (
              <button key={c} type="button" aria-pressed={course === c} onClick={() => setCourse(c)}>
                {c === 1 ? 'Subito' : c === 2 ? 'A seguire' : '3ª uscita'}
              </button>
            ))}
          </div>
        </div>
        {menu.error ? (
          <ErrorBox error={menu.error} />
        ) : !menu.data ? (
          <Skeleton rows={3} />
        ) : !menu.data.sections.length ? (
          <div className="card-body muted">Il menu è vuoto: l’amministratore lo prepara in «Menu e tavoli».</div>
        ) : (
          <>
            <div className="section-chips" role="tablist">
              {menu.data.sections.map((x) => (
                <button key={x.id} role="tab" aria-selected={x.id === section} onClick={() => setSection(x.id)}>
                  {x.name}
                </button>
              ))}
            </div>
            <div className="menu-pick">
              {sec?.items.map((it) => {
                const inCart = cart.filter((l) => l.menuItemId === it.id).reduce((a, l) => a + l.qty, 0)
                return (
                  <button key={it.id} type="button" className={`pick ${it.isAvailable ? '' : 'off'} ${inCart ? 'in' : ''}`} onClick={() => add(it, sec.isDrinks)} disabled={!it.isAvailable}>
                    <span className="pick-name">{it.name}</span>
                    <span className="pick-price">{it.isAvailable ? euro(it.price) : 'esaurito'}</span>
                    {inCart ? <span className="pick-count">{inCart}</span> : null}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      {cart.length ? (
        <div className="cart">
          <div className="cart-lines">
            {cart.map((l) => (
              <div key={l.key} className="cart-line">
                <span className="badge">{l.isDrinks ? 'bevanda' : COURSE(l.course).toLowerCase()}</span>
                <span className="grow">
                  {l.name}
                  {l.notes ? <span className="small muted"> · {l.notes}</span> : null}
                </span>
                <button className="btn ghost sm" aria-label="Nota" onClick={() => setNoteFor(l.key)}>
                  <Icon name="edit" />
                </button>
                <span className="stepper">
                  <button type="button" onClick={() => setCart((c) => c.flatMap((x) => (x.key !== l.key ? [x] : x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : [])))} aria-label="Meno">
                    −
                  </button>
                  <strong>{l.qty}</strong>
                  <button type="button" onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, qty: x.qty + 1 } : x)))} aria-label="Più">
                    +
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="row between" style={{ gap: 8 }}>
            <button className="btn ghost" onClick={() => setCart([])}>
              Svuota
            </button>
            <button className="btn primary send-btn" disabled={busy === 'send'} onClick={() => void send()}>
              {busy === 'send' ? <span className="spinner" /> : <Icon name="send" />} Invia comanda · {euro(String(cartTotal))}
            </button>
          </div>
        </div>
      ) : null}

      {noteFor ? (
        <NoteDialog
          value={cart.find((l) => l.key === noteFor)?.notes ?? ''}
          onClose={() => setNoteFor(null)}
          onSave={(v) => {
            setCart((c) => c.map((x) => (x.key === noteFor ? { ...x, notes: v } : x)))
            setNoteFor(null)
          }}
        />
      ) : null}
      {joining ? <JoinDialog session={s} onClose={() => setJoining(false)} onDone={(d) => { set(d); setJoining(false) }} /> : null}
      {closing ? (
        <CloseDialog
          bill={s.bill}
          busy={busy === 'close'}
          onClose={() => setClosing(false)}
          onConfirm={async () => {
            setBusy('close')
            try {
              const doClose = (force: boolean) => withPin((pin) => api.post<{ bill: Bill }>(`/orders/sessions/${id}/close`, { pin, force }))
              try {
                await doClose(false)
              } catch (e) {
                if (e instanceof ApiError && e.code === 'pending_items' && window.confirm(e.message)) await doClose(true)
                else throw e
              }
              qc.invalidateQueries({ queryKey: ['orders'] })
              toast(`Tavolo ${s.label} chiuso.`)
              router.push('/sala')
            } catch (e) {
              if (e instanceof Error && e.message) toast(errorMessage(e))
            } finally {
              setBusy(null)
            }
          }}
        />
      ) : null}
    </div>
  )
}

function NoteDialog({ value, onSave, onClose }: { value: string; onSave: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(value)
  const quick = ['senza glutine', 'senza lattosio', 'ben cotta', 'al sangue', 'senza cipolla', 'piccante', 'da dividere', 'per bambino']
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="card-body stack">
          <h2 style={{ margin: 0 }}>Nota per la cucina</h2>
          <textarea className="input" rows={2} value={v} onChange={(e) => setV(e.target.value)} autoFocus maxLength={300} />
          <div className="row wrap" style={{ gap: 6 }}>
            {quick.map((x) => (
              <button key={x} type="button" className="btn sm" onClick={() => setV((cur) => (cur ? `${cur}, ${x}` : x))}>
                {x}
              </button>
            ))}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={onClose}>
              Annulla
            </button>
            <button className="btn primary" onClick={() => onSave(v)}>
              Salva nota
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function JoinDialog({ session, onClose, onDone }: { session: TableSession; onClose: () => void; onDone: (s: TableSession) => void }) {
  const toast = useToast()
  const { withPin } = usePin()
  const floor = useQuery({ queryKey: ['orders', 'floor'], queryFn: () => api.get<{ tables: Array<{ id: string; label: string; sessionId: string | null }> }>('/orders/floor') })
  const [pick, setPick] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const mine = new Set(session.tables.map((t) => t.id))
  const others = floor.data?.tables.filter((t) => !mine.has(t.id)) ?? []
  const join = async () => {
    setBusy(true)
    try {
      onDone(await withPin((pin) => api.post<TableSession>(`/orders/sessions/${session.id}/tables`, { tableIds: pick, pin })))
    } catch (e) {
      if (e instanceof Error && e.message) toast(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (tableId: string) => {
    try {
      onDone(await api.del<TableSession>(`/orders/sessions/${session.id}/tables/${tableId}`))
    } catch (e) {
      toast(errorMessage(e))
    }
  }
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="card-body stack">
          <h2 style={{ margin: 0 }}>Unisci tavoli a {session.label}</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Se un tavolo scelto è già aperto, i suoi ordini e coperti passano qui.
          </p>
          <div className="join-grid">
            {others.map((t) => (
              <button key={t.id} type="button" className={t.sessionId ? 'busy' : ''} aria-pressed={pick.includes(t.id)} onClick={() => setPick((m) => (m.includes(t.id) ? m.filter((x) => x !== t.id) : [...m, t.id]))}>
                {t.label}
              </button>
            ))}
          </div>
          {session.tables.length > 1 ? (
            <div className="small">
              Tavoli uniti:{' '}
              {session.tables.map((t) => (
                <button key={t.id} type="button" className="btn ghost sm" onClick={() => window.confirm(`Togliere il tavolo ${t.label} dall’unione?`) && void remove(t.id)}>
                  {t.label} <Icon name="x" />
                </button>
              ))}
            </div>
          ) : null}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={onClose}>
              Chiudi
            </button>
            <button className="btn primary" disabled={!pick.length || busy} onClick={() => void join()}>
              Unisci
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CloseDialog({ bill, busy, onClose, onConfirm }: { bill: Bill; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog bill" role="dialog" aria-modal="true">
        <div className="card-body stack">
          <h2 style={{ margin: 0 }}>Preconto · tavolo {bill.label}</h2>
          <div className="bill-lines">
            {bill.lines.map((l, i) => (
              <div key={i} className="row between">
                <span>
                  {l.qty}× {l.name}
                </span>
                <span className="num">{euro(l.total)}</span>
              </div>
            ))}
            {Number(bill.coverTotal) > 0 ? (
              <div className="row between">
                <span>
                  Coperto {bill.covers} × {euro(bill.coverCharge)}
                </span>
                <span className="num">{euro(bill.coverTotal)}</span>
              </div>
            ) : null}
          </div>
          <div className="row between bill-total">
            <strong>Totale</strong>
            <strong className="num">{euro(bill.total)}</strong>
          </div>
          <p className="small faint" style={{ margin: 0 }}>
            Preconto non fiscale: lo scontrino lo emette il registratore di cassa.
          </p>
          <div className="row wrap" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={() => window.print()}>
              Stampa
            </button>
            <button className="btn" onClick={onClose}>
              Indietro
            </button>
            <button className="btn primary" disabled={busy} onClick={onConfirm}>
              {busy ? <span className="spinner" /> : null} Chiudi il tavolo
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
