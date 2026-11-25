'use client'

/**
 * NUOVO — «Installa l'app» (PWA): su Android e computer apre la richiesta del browser,
 * su iPhone/iPad spiega i passaggi di Safari (Apple non permette di avviarla dal sito).
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useInstall, useOnline, type Platform } from '@/lib/pwa'
import { BrandMark } from './Brand'
import { Icon } from './ui'

const SHARE_ICON = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="ios-share">
    <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Istruzioni passo passo per la piattaforma indicata (usate nella finestra e nella pagina /installa). */
export function InstallSteps({ platform, canPrompt, onPrompt }: { platform: Platform; canPrompt: boolean; onPrompt?: () => void }) {
  if (platform === 'ios-safari') {
    return (
      <ol className="install-steps">
        <li>
          Tocca il pulsante <strong>Condividi</strong> {SHARE_ICON} in basso (su iPad in alto a destra).
        </li>
        <li>
          Scorri e scegli <strong>Aggiungi alla schermata Home</strong>.
        </li>
        <li>
          Tocca <strong>Aggiungi</strong>: l’icona di Ricetta Quadra comparirà tra le tue app.
        </li>
      </ol>
    )
  }
  if (platform === 'ios-other') {
    return (
      <ol className="install-steps">
        <li>
          Tocca il pulsante <strong>Condividi</strong> {SHARE_ICON} del browser (su Chrome è nella barra dell’indirizzo).
        </li>
        <li>
          Scegli <strong>Aggiungi alla schermata Home</strong>. Se non c’è, apri <strong>ricettaquadra.it</strong> in <strong>Safari</strong> e ripeti.
        </li>
      </ol>
    )
  }
  if (canPrompt && onPrompt) {
    return (
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Il browser installa Ricetta Quadra come un’app: icona sulla schermata Home{platform === 'desktop' ? ' o sul desktop' : ''}, si apre a tutto schermo.
        </p>
        <button className="btn primary" onClick={onPrompt}>
          <Icon name="download" /> Installa adesso
        </button>
      </div>
    )
  }
  return platform === 'android' ? (
    <ol className="install-steps">
      <li>
        Apri il menu del browser <strong>⋮</strong> (in alto a destra in Chrome).
      </li>
      <li>
        Scegli <strong>Installa app</strong> oppure <strong>Aggiungi a schermata Home</strong>.
      </li>
    </ol>
  ) : (
    <ol className="install-steps">
      <li>
        In <strong>Chrome</strong> o <strong>Edge</strong> clicca l’icona di installazione nella barra dell’indirizzo, oppure il menu → <strong>Installa Ricetta Quadra</strong>.
      </li>
      <li>
        Su Mac con <strong>Safari</strong>: menu <strong>File → Aggiungi al Dock</strong>.
      </li>
    </ol>
  )
}

export function InstallDialog({ onClose }: { onClose: () => void }) {
  const ins = useInstall()
  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="install-title">
        <div className="card-body stack">
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            <BrandMark size={44} />
            <div>
              <h2 id="install-title" style={{ margin: 0 }}>
                Installa Ricetta Quadra
              </h2>
              <div className="small muted">Gratis, senza passare dagli store. Si aggiorna da sola.</div>
            </div>
          </div>
          {ins.installed ? (
            <div className="alert ok">È già installata su questo dispositivo.</div>
          ) : (
            <InstallSteps
              platform={ins.platform}
              canPrompt={ins.canPrompt}
              onPrompt={async () => {
                if (await ins.prompt()) onClose()
              }}
            />
          )}
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Link className="small link" href="/installa" onClick={onClose}>
              Istruzioni per altri dispositivi
            </Link>
            <button className="btn" onClick={onClose} autoFocus>
              Chiudi
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Pulsante nella barra laterale: nascosto quando l'app è già installata. */
export function InstallButton() {
  const ins = useInstall()
  const [open, setOpen] = useState(false)
  if (ins.installed) return null
  return (
    <>
      <button
        className="btn ghost sm"
        style={{ justifyContent: 'flex-start' }}
        onClick={async () => {
          if (ins.canPrompt && (await ins.prompt())) return
          setOpen(true)
        }}
      >
        <Icon name="download" /> Installa l’app
      </button>
      {open ? <InstallDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/** Invito una tantum sugli smartphone (chiudibile per sempre). */
export function InstallBanner() {
  const ins = useInstall()
  const [hidden, setHidden] = useState(true)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try {
      setHidden(localStorage.getItem('rq-install-banner') === 'no' || localStorage.getItem('rq-installed') === '1')
    } catch {
      setHidden(false)
    }
  }, [])
  if (hidden || ins.installed || ins.platform === 'desktop') return null
  const dismiss = () => {
    try {
      localStorage.setItem('rq-install-banner', 'no')
    } catch {
      /* archiviazione non disponibile */
    }
    setHidden(true)
  }
  return (
    <>
      <div className="install-banner" role="region" aria-label="Installa l'app">
        <BrandMark size={36} />
        <div className="grow">
          <strong>Ricetta Quadra sul telefono</strong>
          <div className="small muted">Aggiungila alla schermata Home: si apre come un’app.</div>
        </div>
        <button
          className="btn primary sm"
          onClick={async () => {
            if (ins.canPrompt && (await ins.prompt())) return
            setOpen(true)
          }}
        >
          Installa
        </button>
        <button className="btn ghost icon sm" aria-label="Non mostrare più" onClick={dismiss}>
          <Icon name="x" />
        </button>
      </div>
      {open ? <InstallDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/** Avviso quando manca la connessione. */
export function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return (
    <div className="offline-banner" role="status">
      <Icon name="alert" /> Sei offline: i dati non si aggiornano finché non torna la connessione.
    </div>
  )
}
