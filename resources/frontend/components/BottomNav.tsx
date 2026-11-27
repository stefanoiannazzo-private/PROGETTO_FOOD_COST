'use client'

/**
 * NUOVO — Barra di navigazione in basso per smartphone (variante 3 «pillola con +»).
 * Ricette · Prodotti · [+] · Redditività (o Dashboard) · Altro.
 * «+» apre le azioni rapide, «Altro» il menu completo come foglio dal basso.
 * Su computer resta nascosta: c'è il menu laterale.
 */
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Icon } from './ui'
import { QUICK_EVENT } from '@/lib/quick'

export interface NavItem {
  href: string
  label: string
  icon: string
}

interface Quick {
  key: string
  label: string
  hint: string
  icon: string
  path: string
  /** pagina e azione: se la pagina è già aperta basta l'evento */
  action?: string
}

export function BottomNav({
  sections,
  platform,
  quick,
  main,
  fourth,
  count,
  isActive,
  onGuide,
}: {
  sections: NavItem[]
  platform: NavItem[]
  quick: Quick[]
  /** NUOVO: le due voci a sinistra (Ricette/Prodotti, oppure Sala/Cucina per chi lavora in servizio) */
  main: NavItem[]
  fourth: NavItem
  count: (href: string) => number
  isActive: (href: string) => boolean
  onGuide: () => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [sheet, setSheet] = useState<null | 'quick' | 'more'>(null)

  useEffect(() => setSheet(null), [pathname])
  useEffect(() => {
    if (!sheet) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheet(null)
    window.addEventListener('keydown', onKey)
    document.body.classList.add('sheet-open')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('sheet-open')
    }
  }, [sheet])

  const runQuick = (q: Quick) => {
    setSheet(null)
    if (!q.action) return router.push(q.path)
    if (pathname === q.path) window.dispatchEvent(new CustomEvent(QUICK_EVENT, { detail: q.action }))
    else router.push(`${q.path}?azione=${q.action}`)
  }

  // «Altro» è attivo quando la pagina aperta non è una delle voci della barra
  const inBar = [...main, fourth].some((n) => isActive(n.href))
  const moreCount = sections.filter((s) => !main.some((m) => m.href === s.href) && s.href !== fourth.href).reduce((a, s) => a + count(s.href), 0)

  const tab = (n: NavItem) => {
    const c = count(n.href)
    return (
      <Link href={n.href} className="bn-tab" aria-label={n.label} aria-current={isActive(n.href) ? 'page' : undefined}>
        <Icon name={n.icon} />
        {c ? <span className="bn-badge" aria-label={`${c} novità`}>{c > 9 ? '9+' : c}</span> : null}
      </Link>
    )
  }

  return (
    <>
      {sheet ? <div className="bn-scrim" onClick={() => setSheet(null)} /> : null}

      {sheet === 'quick' ? (
        <div className="bn-sheet" role="dialog" aria-label="Azioni rapide">
          <div className="bn-grab" />
          <div className="bn-title">Crea o carica</div>
          <div className="bn-quick">
            {quick.map((q) => (
              <button key={q.key} className="bn-qa" onClick={() => runQuick(q)}>
                <span className="bn-qa-ic">
                  <Icon name={q.icon} />
                </span>
                <span>
                  <strong>{q.label}</strong>
                  <span className="small muted">{q.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {sheet === 'more' ? (
        <div className="bn-sheet" role="dialog" aria-label="Menu completo">
          <div className="bn-grab" />
          {sections.length ? (
            <>
              <div className="bn-title">Tutte le sezioni</div>
              <div className="bn-grid">
                {sections.filter((n) => n.href !== '/assistenza').map((n) => (
                  <Link key={n.href} href={n.href} className="bn-cell" aria-current={isActive(n.href) ? 'page' : undefined}>
                    <span className="bn-cell-ic">
                      <Icon name={n.icon} />
                      {count(n.href) ? <span className="bn-badge">{count(n.href)}</span> : null}
                    </span>
                    {n.label}
                  </Link>
                ))}
              </div>
            </>
          ) : null}
          {platform.length ? (
            <>
              <div className="bn-title">Piattaforma</div>
              <div className="bn-grid">
                {platform.map((n) => (
                  <Link key={n.href} href={n.href} className="bn-cell" aria-current={isActive(n.href) ? 'page' : undefined}>
                    <span className="bn-cell-ic">
                      <Icon name={n.icon} />
                      {count(n.href) ? <span className="bn-badge">{count(n.href)}</span> : null}
                    </span>
                    {n.label}
                  </Link>
                ))}
              </div>
            </>
          ) : null}
          <div className="bn-title">Aiuto</div>
          <div className="bn-grid">
            {sections.length ? (
              <button
                className="bn-cell"
                onClick={() => {
                  setSheet(null)
                  onGuide()
                }}
              >
                <span className="bn-cell-ic">
                  <Icon name="help" />
                </span>
                Guida
              </button>
            ) : null}
            <Link href="/assistenza" className="bn-cell">
              <span className="bn-cell-ic">
                <Icon name="lifebuoy" />
                {count('/assistenza') ? <span className="bn-badge">{count('/assistenza')}</span> : null}
              </span>
              Assistenza
            </Link>
            <Link href="/assistenza/faq" className="bn-cell">
              <span className="bn-cell-ic">
                <Icon name="book" />
              </span>
              Domande frequenti
            </Link>
          </div>
        </div>
      ) : null}

      <nav className="bottom-nav" aria-label="Navigazione rapida">
        {main[0] ? tab(main[0]) : <span />}
        {main[1] ? tab(main[1]) : <span />}
        {quick.length ? (
          <button className="bn-fab" aria-label="Crea o carica" aria-expanded={sheet === 'quick'} onClick={() => setSheet(sheet === 'quick' ? null : 'quick')}>
            <Icon name={sheet === 'quick' ? 'x' : 'plus'} />
          </button>
        ) : (
          <span />
        )}
        {tab(fourth)}
        <button
          className="bn-tab"
          aria-label="Menu completo"
          aria-expanded={sheet === 'more'}
          aria-current={sheet === 'more' || (!inBar && !sheet) ? 'page' : undefined}
          onClick={() => setSheet(sheet === 'more' ? null : 'more')}
        >
          <Icon name={sheet === 'more' ? 'x' : 'menu'} />
          {moreCount && sheet !== 'more' ? <span className="bn-dot" aria-label="Novità nel menu" /> : null}
        </button>
      </nav>
    </>
  )
}
