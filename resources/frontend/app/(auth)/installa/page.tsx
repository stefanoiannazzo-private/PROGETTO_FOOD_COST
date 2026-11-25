'use client'

/** NUOVO — Pagina pubblica «Installa l'app» (PWA): istruzioni per iPhone, Android e computer, senza bisogno di accedere. */
import Link from 'next/link'
import { useState } from 'react'
import { BrandLogo } from '@/components/Brand'
import { InstallSteps } from '@/components/InstallApp'
import { useInstall, type Platform } from '@/lib/pwa'

const TABS: Array<{ id: Platform; label: string }> = [
  { id: 'ios-safari', label: 'iPhone e iPad' },
  { id: 'android', label: 'Android' },
  { id: 'desktop', label: 'Computer' },
]

export default function InstallPage() {
  const ins = useInstall()
  const mine = ins.platform === 'ios-other' ? 'ios-safari' : ins.platform
  const [tab, setTab] = useState<Platform>(mine)
  return (
    <div className="auth-wrap">
      <div className="auth-card card card-body stack">
        <div className="auth-brand">
          <BrandLogo height={56} />
        </div>
        <h1>Installa l’app</h1>
        <p className="muted" style={{ margin: 0 }}>
          Ricetta Quadra si installa direttamente dal sito, senza passare dagli store: icona sulla schermata Home, apertura a tutto schermo, aggiornamenti automatici.
        </p>
        {ins.installed ? <div className="alert ok">Stai già usando l’app installata.</div> : null}
        <div className="seg" role="tablist" aria-label="Dispositivo">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === mine ? ' (questo)' : ''}
            </button>
          ))}
        </div>
        <InstallSteps
          platform={tab === 'ios-safari' && ins.platform === 'ios-other' ? 'ios-other' : tab}
          canPrompt={tab === mine && ins.canPrompt}
          onPrompt={() => void ins.prompt()}
        />
        {tab === 'ios-safari' ? <p className="small faint" style={{ margin: 0 }}>Su iPhone l’installazione si fa da Safari: Apple non permette ai siti di avviarla con un pulsante.</p> : null}
        <Link className="btn" href="/accedi">
          Vai all’accesso
        </Link>
      </div>
    </div>
  )
}
