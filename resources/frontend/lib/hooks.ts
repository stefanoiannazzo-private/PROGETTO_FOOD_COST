'use client'

import { useEffect, useState } from 'react'

/** Legge un parametro della query string dopo il montaggio (evita il rendering lato server dei parametri). */
export function useQueryParam(name: string): string | null | undefined {
  const [v, setV] = useState<string | null | undefined>(undefined)
  useEffect(() => setV(new URLSearchParams(window.location.search).get(name)), [name])
  return v
}

/** Bozza salvata nel browser: protegge quanto compilato da errori di rete o chiusure accidentali. */
export function useLocalDraft<T>(key: string | null, value: T, enabled: boolean) {
  useEffect(() => {
    if (!key || !enabled) return
    const t = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }))
      } catch {
        /* storage non disponibile */
      }
    }, 400)
    return () => clearTimeout(t)
  }, [key, value, enabled])
}

export function readLocalDraft<T>(key: string): { savedAt: number; value: T } | null {
  try {
    const s = localStorage.getItem(key)
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

export function clearLocalDraft(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignora */
  }
}
