'use client'

/**
 * NUOVO — Cerchio con le iniziali nella barra in alto: azienda attiva (e cambio azienda), Guida, Assistenza,
 * Installa l'app, Esci. Sostituisce «Guida» e il nome dell'azienda nella barra (soluzione C).
 */
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useInstall } from '@/lib/pwa'
import { useSwitchCompany, type Me } from '@/lib/session'
import { InstallDialog } from './InstallApp'
import { Icon } from './ui'

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 || /\p{N}/u.test(w))
  const stop = new Set(['di', 'da', 'del', 'della', 'il', 'la', 'lo', 'le', 'e', 'srl', 'snc', 'sas', 'spa'])
  const main = words.filter((w) => !stop.has(w.toLowerCase()))
  const pick = (main.length ? main : words).slice(0, 2)
  return (pick.map((w) => w[0]).join('') || '?').toUpperCase()
}

export function AccountMenu({ me, onGuide }: { me: Me; onGuide: () => void }) {
  const router = useRouter()
  const qc = useQueryClient()
  const switchCompany = useSwitchCompany()
  const ins = useInstall()
  const [open, setOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const label = me.company?.name ?? me.user?.name ?? 'Account'

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('touchstart', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('touchstart', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const go = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  return (
    <div className="account" ref={box}>
      <button
        type="button"
        className={`avatar-btn${me.assist ? ' assist' : ''}`}
        data-tour="help"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: menu account, guida e assistenza`}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {initials(label)}
      </button>
      {open ? (
        <div className="account-menu" role="menu">
          <div className="account-head">
            <div className="avatar-btn static" aria-hidden="true">
              {initials(label)}
            </div>
            <div style={{ minWidth: 0 }}>
              <strong className="ellipsis">{label}</strong>
              <div className="small muted ellipsis">
                {me.user?.name}
                {me.roleLabel ? ` · ${me.roleLabel}` : ''}
              </div>
              {me.assist ? <span className="badge warn">Modalità assistenza</span> : null}
            </div>
          </div>

          {me.company && me.companies.length > 1 && !me.assist ? (
            <div className="account-section">
              <div className="account-title">Cambia azienda</div>
              {me.companies.map((c) => (
                <button
                  key={c.id}
                  role="menuitemradio"
                  aria-checked={c.id === me.company?.id}
                  className="account-item"
                  onClick={async () => {
                    setOpen(false)
                    if (c.id === me.company?.id) return
                    await switchCompany(c.id)
                    router.push('/')
                  }}
                >
                  <Icon name={c.id === me.company?.id ? 'check' : 'layers'} size={16} /> <span className="ellipsis">{c.name}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="account-section">
            {me.company ? (
              <>
                <button
                  role="menuitem"
                  className="account-item"
                  onClick={() => {
                    setOpen(false)
                    onGuide()
                  }}
                >
                  <Icon name="help" size={16} /> Guida all’uso
                </button>
                <button role="menuitem" className="account-item" onClick={() => go('/assistenza')}>
                  <Icon name="lifebuoy" size={16} /> Assistenza
                </button>
                <button role="menuitem" className="account-item" onClick={() => go('/assistenza/faq')}>
                  <Icon name="book" size={16} /> Domande frequenti
                </button>
              </>
            ) : (
              <Link role="menuitem" className="account-item" href="/piattaforma" onClick={() => setOpen(false)}>
                <Icon name="layers" size={16} /> Console piattaforma
              </Link>
            )}
            {!ins.installed ? (
              <button
                role="menuitem"
                className="account-item"
                onClick={async () => {
                  setOpen(false)
                  if (ins.canPrompt && (await ins.prompt())) return
                  setInstallOpen(true)
                }}
              >
                <Icon name="download" size={16} /> Installa l’app
              </button>
            ) : null}
          </div>

          <div className="account-section">
            <button
              role="menuitem"
              className="account-item"
              onClick={async () => {
                setOpen(false)
                await api.post('/auth/logout')
                qc.clear()
                router.replace('/accedi')
              }}
            >
              <Icon name="logout" size={16} /> Esci
            </button>
          </div>
        </div>
      ) : null}
      {installOpen ? <InstallDialog onClose={() => setInstallOpen(false)} /> : null}
    </div>
  )
}
