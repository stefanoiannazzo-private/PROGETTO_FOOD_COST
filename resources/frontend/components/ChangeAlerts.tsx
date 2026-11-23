'use client'

/**
 * NUOVO — Avvisi di variazione dei costi (niente email né notifiche push).
 * Ricette e prodotti cambiati dopo l'ultima volta che l'utente li ha aperti: badge negli elenchi e nel menu,
 * riquadro nella scheda. Aprire la scheda segna l'avviso come visto (per quell'utente).
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { dateTime, euro } from '@/lib/num'
import { useCan, useMe } from '@/lib/session'
import { Icon } from './ui'

export type AlertType = 'recipe' | 'ingredient'

interface Unseen {
  recipes: Array<{ id: string; count: number; lastAt: string }>
  ingredients: Array<{ id: string; count: number; lastAt: string }>
}

export interface Change {
  id: string
  lines: string[]
  source: string | null
  before: string | null
  after: string | null
  beforePortion: string | null
  afterPortion: string | null
  unit: string | null
  createdAt: string
  createdBy: string | null
}

export function useAlerts() {
  const can = useCan()
  const { data: me } = useMe()
  return useQuery({
    queryKey: ['alerts', me?.company?.id],
    queryFn: () => api.get<Unseen>('/alerts'),
    enabled: !!me?.company && can('costs.read'),
    staleTime: 10_000,
  })
}

export function useChangedSet(type: AlertType): Set<string> {
  const q = useAlerts()
  const list = type === 'recipe' ? q.data?.recipes : q.data?.ingredients
  return new Set((list ?? []).map((x) => x.id))
}

export function ChangedBadge({ changed, type }: { changed: boolean; type: AlertType }) {
  if (!changed) return null
  return (
    <span className="badge warn chg-badge" title="Cambiato dall’ultima volta che l’hai aperto">
      {type === 'recipe' ? 'Costo variato' : 'Prezzo variato'}
    </span>
  )
}

/** Riquadro in cima agli elenchi: quante ricette/prodotti sono cambiati e "segna tutte come viste". */
export function ChangedListBanner({ type }: { type: AlertType }) {
  const q = useAlerts()
  const qc = useQueryClient()
  const n = (type === 'recipe' ? q.data?.recipes : q.data?.ingredients)?.length ?? 0
  if (!n) return null
  const what = type === 'recipe' ? (n === 1 ? 'ricetta ha' : 'ricette hanno') : n === 1 ? 'prodotto ha' : 'prodotti hanno'
  return (
    <div className="alert warn chg-list" style={{ marginBottom: 12 }}>
      <Icon name="alert" />
      <div className="grow">
        <strong>
          {n} {what} {type === 'recipe' ? 'il costo cambiato' : 'il prezzo cambiato'}
        </strong>{' '}
        {type === 'recipe' ? 'dall’ultima volta che le hai aperte: sono segnate con' : 'dall’ultima volta che li hai aperti: sono segnati con'} «{type === 'recipe' ? 'Costo variato' : 'Prezzo variato'}». {type === 'recipe' ? 'Aprile' : 'Aprili'} per vedere cosa è cambiato.
      </div>
      <button
        className="btn sm"
        onClick={async () => {
          await api.post('/alerts/seen', { type })
          qc.invalidateQueries({ queryKey: ['alerts'] })
        }}
      >
        {type === 'recipe' ? 'Segna tutte come viste' : 'Segna tutti come visti'}
      </button>
    </div>
  )
}

const signed = (b: string | null, a: string | null) => {
  if (b === null || a === null) return null
  const d = Number(a) - Number(b)
  const p = Number(b) ? (d / Number(b)) * 100 : null
  return { d, p }
}

/**
 * Riquadro nella scheda: elenco delle variazioni non ancora viste e, per le ricette, costo prima → adesso.
 * Dopo averlo mostrato segna la scheda come vista: alla prossima apertura non ricompare.
 */
export function ChangesNotice({ type, id, changes: incoming }: { type: AlertType; id: string; changes: Change[] | undefined }) {
  const qc = useQueryClient()
  const done = useRef<string | null>(null)
  // resta visibile per tutta la visita anche se la scheda viene ricaricata (dopo "visto" arriva vuoto)
  const [changes, setChanges] = useState(incoming)
  useEffect(() => {
    if (incoming?.length) setChanges(incoming)
  }, [incoming])
  useEffect(() => {
    if (!changes?.length || done.current === id) return
    done.current = id
    void api.post('/alerts/seen', { type, id }).then(() => qc.invalidateQueries({ queryKey: ['alerts'] }))
  }, [changes, id, type, qc])
  if (!changes?.length) return null
  // dal valore più vecchio non visto al più recente
  const oldest = changes[changes.length - 1]!
  const newest = changes[0]!
  const tot = signed(oldest.before, newest.after)
  const por = signed(oldest.beforePortion, newest.afterPortion)
  const fmtDelta = (x: { d: number; p: number | null }) => `${x.d >= 0 ? '+' : '−'}${euro(Math.abs(x.d))}${x.p !== null ? ` (${x.p >= 0 ? '+' : '−'}${Math.abs(x.p).toLocaleString('it-IT', { maximumFractionDigits: 1 })}%)` : ''}`
  const up = (tot?.d ?? 0) > 0
  return (
    <div className={`alert ${up ? 'warn' : 'info'} chg-notice`} role="status">
      <Icon name="alert" />
      <div className="grow stack" style={{ gap: 6 }}>
        <strong>{type === 'recipe' ? 'Il costo di questa ricetta è cambiato dall’ultima volta che l’hai aperta' : 'Il prezzo di questo prodotto è cambiato dall’ultima volta che l’hai aperto'}</strong>
        {type === 'recipe' && tot && oldest.before !== null && newest.after !== null ? (
          <div>
            Totale {euro(oldest.before)} → <strong>{euro(newest.after)}</strong> {fmtDelta(tot)}
            {por && oldest.beforePortion !== null && newest.afterPortion !== null ? (
              <>
                {' '}
                · a porzione {euro(oldest.beforePortion)} → <strong>{euro(newest.afterPortion)}</strong> {fmtDelta(por)}
              </>
            ) : null}
          </div>
        ) : null}
        <ul className="chg-lines">
          {changes.map((c) => (
            <li key={c.id}>
              {c.lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
              <div className="small faint">
                {dateTime(c.createdAt)}
                {c.source ? ` · ${c.source}` : ''}
                {c.createdBy ? ` · ${c.createdBy}` : ''}
              </div>
            </li>
          ))}
        </ul>
        <div className="small faint">L’avviso non comparirà più alla prossima apertura.</div>
      </div>
    </div>
  )
}
