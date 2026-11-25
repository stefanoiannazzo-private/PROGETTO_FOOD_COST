'use client'

/**
 * NUOVO — «È disponibile una nuova versione». Quando l'app torna in primo piano (e ogni 10 minuti mentre è
 * aperta) confronta la propria build con /app/version.json: se sul sito ce n'è una più recente lo dice,
 * e «Aggiorna» ricarica la pagina. Serve soprattutto all'app installata su iPhone, che non si ricarica da sola.
 */
import { useEffect, useState } from 'react'
import { Icon } from './ui'

const CHECK_EVERY_MS = 10 * 60 * 1000

export function UpdateBanner() {
  const [newBuild, setNewBuild] = useState<string | null>(null)
  const [snoozed, setSnoozed] = useState<string | null>(null)

  useEffect(() => {
    if (!import.meta.env.PROD) return
    let last = 0
    let busy = false
    const check = async () => {
      if (busy || document.visibilityState !== 'visible' || Date.now() - last < 30_000) return
      busy = true
      last = Date.now()
      try {
        const r = await fetch(`/app/version.json?t=${Date.now()}`, { cache: 'no-store' })
        if (r.ok) {
          const v = (await r.json()) as { build?: string }
          if (v.build && v.build !== __BUILD_ID__ && v.build > __BUILD_ID__) setNewBuild(v.build)
        }
        // anche il service worker si aggiorna, se è cambiato (senza aspettarlo)
        void navigator.serviceWorker
          ?.getRegistration('/')
          .then((reg) => reg?.update())
          .catch(() => undefined)
      } catch {
        /* offline o sito non raggiungibile: si riprova più tardi */
      } finally {
        busy = false
      }
    }
    const onVisible = () => void check()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener('online', onVisible)
    const timer = window.setInterval(onVisible, CHECK_EVERY_MS)
    void check()
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('online', onVisible)
      window.clearInterval(timer)
    }
  }, [])

  if (!newBuild || snoozed === newBuild) return null
  return (
    <div className="update-banner" role="status">
      <Icon name="download" />
      <div className="grow">
        <strong>È disponibile una nuova versione di Ricetta Quadra.</strong>
        <div className="small">Se stai modificando qualcosa, salva prima di aggiornare.</div>
      </div>
      <div className="update-actions">
        <button className="btn ghost sm" onClick={() => setSnoozed(newBuild)}>
          Più tardi
        </button>
        <button className="btn sm update-go" onClick={() => window.location.reload()}>
          Aggiorna
        </button>
      </div>
    </div>
  )
}
