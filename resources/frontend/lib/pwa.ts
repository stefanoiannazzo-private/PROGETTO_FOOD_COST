/**
 * NUOVO — Web app installabile (PWA): registrazione del service worker e richiesta di installazione.
 * L'evento "beforeinstallprompt" (Chrome, Edge, Samsung Internet su Android e computer) arriva presto:
 * lo catturiamo all'avvio e lo conserviamo per il pulsante «Installa l'app».
 */
import { useEffect, useState } from 'react'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

export function setupPwa() {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    try {
      localStorage.setItem('rq-installed', '1')
    } catch {
      /* archiviazione non disponibile */
    }
    notify()
  })
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        /* senza service worker l'app funziona comunque */
      })
    })
  }
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export type Platform = 'ios-safari' | 'ios-other' | 'android' | 'desktop'

export function platform(): Platform {
  const ua = navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (ios) return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari'
  if (/Android/i.test(ua)) return 'android'
  return 'desktop'
}

/** Stato dell'installazione per i componenti: già installata? si può mostrare la richiesta del browser? */
export function useInstall() {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    const mq = window.matchMedia('(display-mode: standalone)')
    mq.addEventListener?.('change', l)
    return () => {
      listeners.delete(l)
      mq.removeEventListener?.('change', l)
    }
  }, [])
  return {
    installed: isStandalone(),
    canPrompt: deferred !== null,
    platform: typeof navigator !== 'undefined' ? platform() : ('desktop' as Platform),
    prompt: async (): Promise<boolean> => {
      if (!deferred) return false
      const e = deferred
      await e.prompt()
      const r = await e.userChoice
      deferred = null
      notify()
      return r.outcome === 'accepted'
    },
  }
}

/** Connessione: per l'avviso "sei offline". */
export function useOnline(): boolean {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const up = () => setOn(true)
    const down = () => setOn(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return on
}
