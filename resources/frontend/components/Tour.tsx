'use client'

import { useQueryClient } from '@tanstack/react-query'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/lib/api'
import type { Me } from '@/lib/session'

/**
 * NUOVO — guida del primo accesso: si sposta di pagina in pagina, evidenzia il pulsante giusto e
 * mostra una vignetta con descrizione, «N di M», Chiudi e Segui (Ho capito all'ultimo passo).
 * Al termine o alla chiusura viene registrata sull'utente (POST /auth/tour) e non ricompare.
 */
interface Step {
  path?: string
  target?: () => Element | null
  title: string
  body: string
  perm?: string
  adminOnly?: boolean
}

/** Pulsante o link dell'intestazione di pagina che contiene il testo indicato. */
const headAction = (text: string) => () => Array.from(document.querySelectorAll('.page-head a, .page-head button')).find((el) => el.textContent?.includes(text)) ?? null

const STEPS: Step[] = [
  {
    path: '/',
    title: 'Benvenuto in Ricetta Quadra',
    body: 'In pochi passi ti mostriamo come arrivare al costo reale di un piatto: energia, personale, ingredienti e ricetta. Ti spostiamo noi da una pagina all’altra. Puoi chiudere quando vuoi e riaprire la guida dal pulsante «Guida» in alto.',
  },
  {
    path: '/utenze',
    target: headAction('Nuova tariffa'),
    perm: 'tariffs.manage',
    title: 'Le bollette (luce e gas)',
    body: 'Parti da qui: crea l’utenza e carica il PDF della bolletta. Leggiamo periodo, consumi e totale e calcoliamo quanto paghi davvero al kWh. Serve per il costo dell’energia di forni e macchinari.',
  },
  {
    path: '/strumenti',
    target: headAction('Nuovo strumento'),
    perm: 'equipment.manage',
    title: 'Forni e macchinari',
    body: 'Inserisci gli strumenti che consumano energia: forno, impastatrice, fry top, fuochi. Bastano la potenza scritta sulla targhetta e la bolletta a cui sono collegati. Se non conosci i coefficienti di utilizzo li compiliamo noi.',
  },
  {
    path: '/dipendenti',
    target: headAction('Nuovo dipendente'),
    perm: 'employees.manage',
    title: 'Il personale',
    body: 'Per ogni dipendente bastano il costo mensile tutto compreso (la cifra del consulente), le mensilità pagate e le ore lavorate al mese: calcoliamo il costo al minuto da usare nelle ricette.',
  },
  {
    path: '/ingredienti',
    target: headAction('Nuovo ingrediente'),
    perm: 'ingredients.manage',
    title: 'I prodotti',
    body: 'Inseriscili come li trovi in fattura: al kg, al litro, al pezzo o a confezione, con il prezzo senza IVA. Il prezzo al kg lo calcoliamo noi e lo storico dei prezzi resta sempre consultabile.',
  },
  {
    path: '/importazioni',
    target: () => Array.from(document.querySelectorAll('.card')).find((el) => el.textContent?.includes('Carica il file')) ?? null,
    perm: 'imports.manage',
    title: 'Excel e fatture dei fornitori',
    body: 'Prodotti e dipendenti si caricano tutti insieme da Excel. Qui puoi anche caricare le fatture elettroniche (XML) dei fornitori: abbini ogni riga a un prodotto una volta sola e i prezzi si aggiornano da soli.',
  },
  {
    path: '/ricette',
    target: headAction('Nuova ricetta'),
    perm: 'recipes.manage',
    title: 'Le ricette',
    body: 'Qui nasce il costo del piatto. Aggiungi gli ingredienti (anche altre ricette, come l’impasto della pizza), poi le fasi di lavorazione: per ognuna strumenti, persone e durata, comprese le attese come la lievitazione. Il riepilogo dei costi si aggiorna mentre scrivi.',
  },
  {
    path: '/redditivita',
    target: () => document.getElementById('ref-dish'),
    adminOnly: true,
    title: 'Quanto devi vendere',
    body: 'Scegli un piatto e inserisci il suo prezzo in menu: ti diciamo quanti ne devi vendere a settimana per coprire affitto, personale e costi fissi, che inserisci più sotto in questa pagina.',
  },
  {
    target: () => document.querySelector('[data-tour="help"]'),
    title: 'Tutto pronto!',
    body: 'Ti consigliamo di cominciare dalla bolletta della luce, poi strumenti, dipendenti, prodotti e la prima ricetta. Questa guida, l’Assistenza e le Domande frequenti sono sempre qui, nel cerchio con le tue iniziali in alto a destra.',
  },
]

type Rect = { top: number; left: number; width: number; height: number }

export function Tour({ me, onClose }: { me: Me; onClose: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const qc = useQueryClient()
  const steps = useMemo(() => {
    const perms = new Set(me.permissions)
    return STEPS.filter((s) => (!s.perm || perms.has(s.perm)) && (!s.adminOnly || me.role === 'admin'))
  }, [me])
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [ready, setReady] = useState(false)
  const step = steps[i]!
  const last = i === steps.length - 1
  const [vw, setVw] = useState(typeof window === 'undefined' ? 1200 : window.innerWidth)

  const finish = useCallback(() => {
    onClose()
    qc.setQueryData<Me>(['me'], (m) => (m ? { ...m, tourDone: true } : m))
    void api.post('/auth/tour', { done: true }).catch(() => {})
  }, [onClose, qc])

  // vai alla pagina del passo
  useEffect(() => {
    setReady(false)
    setRect(null)
    if (step.path && pathname !== step.path) router.push(step.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i])

  // cerca l'elemento da evidenziare (la pagina può metterci un attimo a comparire)
  useEffect(() => {
    if (step.path && pathname !== step.path) return
    let tries = 0
    let el: Element | null = null
    const t = setInterval(() => {
      el = step.target ? step.target() : null
      tries++
      if (el || !step.target || tries > 40) {
        clearInterval(t)
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
          const r = el.getBoundingClientRect()
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
        }
        setReady(true)
      }
    }, 100)
    return () => clearInterval(t)
  }, [i, pathname, step])

  // segue scorrimento e ridimensionamento
  useEffect(() => {
    const onMove = () => {
      setVw(window.innerWidth)
      const el = step.target?.()
      if (!el) return
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
      if (e.key === 'ArrowRight' && ready) (last ? finish() : setI((x) => x + 1))
      if (e.key === 'ArrowLeft' && i > 0) setI((x) => x - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finish, last, ready, i])

  // posizione della vignetta: sotto l'elemento, sopra se non c'è spazio; su smartphone in basso o in alto
  const [pop, setPop] = useState<React.CSSProperties>({})
  useLayoutEffect(() => {
    const W = window.innerWidth
    const H = window.innerHeight
    const width = Math.min(380, W - 24)
    if (!rect) return setPop({ width, left: (W - width) / 2, top: Math.max(24, H / 2 - 140) })
    if (W < 720) {
      const below = rect.top + rect.height / 2 < H / 2
      return setPop(below ? { left: 12, right: 12, bottom: 12 } : { left: 12, right: 12, top: 12 })
    }
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), W - width - 12)
    const spaceBelow = H - (rect.top + rect.height)
    setPop(spaceBelow > 230 ? { width, left, top: rect.top + rect.height + 14 } : { width, left, bottom: H - rect.top + 14 })
  }, [rect, vw])

  if (typeof document === 'undefined') return null
  const pad = 6
  return createPortal(
    <div className="tour" aria-live="polite">
      {/* blocca i clic sulla pagina durante la guida */}
      <div className="tour-block" style={{ background: rect ? 'transparent' : 'rgba(15,15,20,.55)' }} onClick={(e) => e.stopPropagation()} />
      {rect ? <div className="tour-spot" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} /> : null}
      {ready ? (
        <div className="tour-pop" role="dialog" aria-modal="true" aria-labelledby="tour-title" style={pop}>
          <div className="tour-count">
            {i + 1} di {steps.length}
            <span className="tour-dots" aria-hidden="true">
              {steps.map((_, k) => (
                <span key={k} className={k === i ? 'on' : k < i ? 'done' : ''} />
              ))}
            </span>
          </div>
          <div id="tour-title" className="tour-title">
            {step.title}
          </div>
          <p className="tour-body">{step.body}</p>
          <div className="tour-actions">
            <button className="btn ghost sm" onClick={finish}>
              Chiudi
            </button>
            <span className="grow" />
            {i > 0 ? (
              <button className="btn sm" onClick={() => setI((x) => x - 1)}>
                Indietro
              </button>
            ) : null}
            <button className="btn primary sm" autoFocus onClick={() => (last ? finish() : setI((x) => x + 1))}>
              {last ? 'Ho capito' : 'Segui →'}
            </button>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
