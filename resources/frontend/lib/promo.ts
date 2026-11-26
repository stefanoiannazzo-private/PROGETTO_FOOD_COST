'use client'

import { useEffect, useState } from 'react'
import { api } from './api'

/** NUOVO — il codice si scrive come capita: lo mostriamo in maiuscolo e senza spazi; il server lo riconosce anche con O/0, I/1. */
export const tidyPromo = (v: string) => v.toUpperCase().replace(/\s+/g, '').slice(0, 30)

/** Controllo dal vivo del codice promo (con una piccola attesa mentre si scrive). */
export function usePromoCheck(code: string) {
  const [state, setState] = useState<{ status: 'empty' | 'checking' | 'valid' | 'invalid'; official?: string }>({ status: 'empty' })
  useEffect(() => {
    const c = code.trim()
    if (c.length < 3) {
      setState({ status: 'empty' })
      return
    }
    setState({ status: 'checking' })
    let alive = true
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ valid: boolean; code: string | null }>(`/public/promo/${encodeURIComponent(c)}`)
        if (alive) setState(r.valid ? { status: 'valid', official: r.code ?? c } : { status: 'invalid' })
      } catch {
        if (alive) setState({ status: 'empty' })
      }
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [code])
  return state
}
