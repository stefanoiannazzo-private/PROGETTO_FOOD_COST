'use client'

import { useEffect, useRef } from 'react'

/**
 * NUOVO — azioni rapide del pulsante «+» della barra in basso.
 * Se la pagina di destinazione è già aperta si invia un evento; altrimenti si apre
 * la pagina con ?azione=<nome> e la pagina esegue l'azione appena montata.
 */
export const QUICK_EVENT = 'foodcost:quick'

export function useQuickAction(name: string, run: () => void) {
  const ref = useRef(run)
  ref.current = run
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('azione') === name) {
      params.delete('azione')
      const qs = params.toString()
      window.history.replaceState(window.history.state, '', window.location.pathname + (qs ? `?${qs}` : ''))
      ref.current()
    }
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === name) ref.current()
    }
    window.addEventListener(QUICK_EVENT, on)
    return () => window.removeEventListener(QUICK_EVENT, on)
  }, [name])
}
