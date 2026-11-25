'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { useMe, useSwitchCompany } from '@/lib/session'
import { Icon, Skeleton } from './ui'
import { MobileTables } from './MobileTables'
import { Tour } from './Tour'
import { BrandLogo } from './Brand'
import { AccountMenu } from './AccountMenu'
import { BottomNav } from './BottomNav'
import { InstallButton, OfflineBanner } from './InstallApp'
import { useAlerts } from './ChangeAlerts'
import { trackPath } from '@/lib/nav-history'

const NAV: Array<{ href: string; label: string; icon: string; perm?: string; adminOnly?: boolean }> = [
  { href: '/', label: 'Dashboard', icon: 'home' },
  { href: '/ricette', label: 'Ricette', icon: 'book', perm: 'recipes.read' },
  { href: '/ingredienti', label: 'Ingredienti', icon: 'box', perm: 'recipes.read' },
  { href: '/strumenti', label: 'Strumenti', icon: 'tool', perm: 'recipes.read' },
  { href: '/utenze', label: 'Utenze', icon: 'bolt', perm: 'tariffs.read' },
  { href: '/dipendenti', label: 'Dipendenti', icon: 'users', perm: 'employees.read' },
  // NUOVO: coefficiente di redditività, solo per l'amministratore dell'azienda
  { href: '/redditivita', label: 'Redditività', icon: 'trend', adminOnly: true },
  { href: '/importazioni', label: 'Importazioni', icon: 'upload', perm: 'imports.manage' },
  { href: '/utenti', label: 'Utenti', icon: 'key', perm: 'users.manage' },
  { href: '/impostazioni', label: 'Impostazioni', icon: 'settings' },
  { href: '/assistenza', label: 'Assistenza', icon: 'lifebuoy' },
]

/** NUOVO: console del superadmin (piattaforma SaaS), visibile solo a chi ha is_platform_admin. */
const PLATFORM_NAV: Array<{ href: string; label: string; icon: string }> = [
  { href: '/piattaforma', label: 'Aziende', icon: 'layers' },
  { href: '/piattaforma/ricette', label: 'Tutte le ricette', icon: 'book' },
  { href: '/piattaforma/prodotti', label: 'Tutti i prodotti', icon: 'box' },
  { href: '/piattaforma/prezzi', label: 'Statistiche prezzi', icon: 'search' },
  { href: '/piattaforma/confronti', label: 'Confronti ricette', icon: 'copy' },
  { href: '/piattaforma/assistenza', label: 'Assistenza clienti', icon: 'lifebuoy' },
]

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const qc = useQueryClient()
  const { data: me, isLoading, error } = useMe()
  const switchCompany = useSwitchCompany()
  const [menuOpen, setMenuOpen] = useState(false)
  const fetching = useIsFetching()
  // NUOVO: guida del primo accesso (automatica per l'amministratore che non l'ha ancora vista)
  const [tourOpen, setTourOpen] = useState(false)
  // NUOVO: avvisi di variazione (contatori nel menu), riletti a ogni cambio di pagina
  const alerts = useAlerts()
  useEffect(() => {
    qc.invalidateQueries({ queryKey: ['alerts'] })
    qc.invalidateQueries({ queryKey: ['support', 'tickets'] })
    qc.invalidateQueries({ queryKey: ['support', 'platform-counts'] })
    trackPath(pathname)
  }, [pathname, qc])
  // NUOVO: assistenza — risposte da leggere (cliente) e richieste aperte (supporto)
  const myTickets = useQuery({
    queryKey: ['support', 'tickets'],
    queryFn: () => api.get<{ data: Array<{ status: string; unread: boolean }> }>('/support/tickets'),
    enabled: !!me?.company,
    staleTime: 30_000,
  })
  const staffTickets = useQuery({
    queryKey: ['support', 'platform-counts'],
    queryFn: () => api.get<{ counts: { open: number } }>('/platform/support?status=open'),
    enabled: !!me?.user?.isPlatformAdmin,
    staleTime: 30_000,
  })
  const answered = myTickets.data?.data.filter((t) => t.unread).length ?? 0
  const alertCount = (href: string) =>
    (href === '/ricette' ? alerts.data?.recipes.length : href === '/ingredienti' ? alerts.data?.ingredients.length : href === '/assistenza' ? answered : href === '/piattaforma/assistenza' ? staffTickets.data?.counts.open : 0) ?? 0
  useEffect(() => {
    if (me?.company && me.role === 'admin' && !me.assist && me.tourDone === false && !pathname.startsWith('/piattaforma')) {
      const t = setTimeout(() => setTourOpen(true), 700)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.company?.id, me?.tourDone])

  useEffect(() => {
    const onUnauth = () => {
      qc.clear()
      router.replace(`/accedi?next=${encodeURIComponent(pathname)}`)
    }
    const onNav = (e: Event) => router.push((e as CustomEvent<string>).detail)
    window.addEventListener('foodcost:unauthorized', onUnauth)
    window.addEventListener('foodcost:navigate', onNav)
    return () => {
      window.removeEventListener('foodcost:unauthorized', onUnauth)
      window.removeEventListener('foodcost:navigate', onNav)
    }
  }, [router, pathname, qc])

  useEffect(() => setMenuOpen(false), [pathname])

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace(`/accedi?next=${encodeURIComponent(pathname)}`)
  }, [error, router, pathname])

  // NUOVO: il superadmin senza aziende proprie lavora dalla console della piattaforma
  useEffect(() => {
    if (me?.user?.isPlatformAdmin && !me.company && me.companies.length === 0 && !pathname.startsWith('/piattaforma')) router.replace('/piattaforma')
  }, [me, pathname, router])

  if (isLoading || !me?.user) {
    return (
      <div className="auth-wrap">
        <div className="auth-card card">
          <Skeleton rows={3} />
        </div>
      </div>
    )
  }

  const platform = me.user.isPlatformAdmin
  const onPlatform = pathname === '/piattaforma' || pathname.startsWith('/piattaforma/')

  if (!me.company && !(platform && onPlatform)) {
    return (
      <div className="auth-wrap">
        <div className="auth-card card card-body stack">
          <h1>Scegli l’azienda</h1>
          <p className="muted">Lavori per più aziende: seleziona quella in cui operare. Potrai cambiarla in qualsiasi momento.</p>
          {me.companies.length === 0 ? <div className="alert warn">Il tuo account non è ancora associato a nessuna azienda attiva.</div> : null}
          {me.companies.map((c) => (
            <button key={c.id} className="btn" style={{ justifyContent: 'space-between', height: 44 }} onClick={() => switchCompany(c.id)}>
              <span>{c.name}</span>
              <span className="badge">{c.roleLabel}</span>
            </button>
          ))}
          {platform ? (
            <button className="btn primary" onClick={() => router.push('/piattaforma')}>
              Console piattaforma
            </button>
          ) : null}
          <button className="btn ghost" onClick={() => api.post('/auth/logout').then(() => router.replace('/accedi'))}>
            Esci
          </button>
        </div>
      </div>
    )
  }

  const perms = new Set(me.permissions)
  const isActive = (href: string) => (href === '/' || href === '/piattaforma' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`))

  // NUOVO: barra in basso su smartphone (solo dentro un'azienda; la console piattaforma usa il menu laterale)
  const sections = me.company ? NAV.filter((n) => (!n.perm || perms.has(n.perm)) && (!n.adminOnly || me.role === 'admin')) : []
  const fourth = me.role === 'admin' ? NAV.find((n) => n.href === '/redditivita')! : NAV[0]!
  const quick = [
    perms.has('recipes.manage') ? { key: 'r', label: 'Nuova ricetta', hint: 'Piatto o preparazione', icon: 'book', path: '/ricette/nuova' } : null,
    perms.has('ingredients.manage') ? { key: 'i', label: 'Nuovo prodotto', hint: 'Ingrediente con il suo prezzo', icon: 'box', path: '/ingredienti', action: 'nuovo-ingrediente' } : null,
    perms.has('imports.manage') && perms.has('ingredients.manage') && perms.has('costs.read')
      ? { key: 'f', label: 'Carica fatture XML', hint: 'Aggiorna i prezzi dalle fatture dei fornitori', icon: 'upload', path: '/importazioni', action: 'fattura' }
      : null,
    perms.has('tariffs.manage') ? { key: 't', label: 'Nuova tariffa', hint: 'Luce, gas o acqua', icon: 'bolt', path: '/utenze', action: 'nuova-tariffa' } : null,
  ].filter((q): q is NonNullable<typeof q> => q !== null)
  const bottomNav = !!me.company

  return (
    <div className={bottomNav ? 'shell has-bnav' : 'shell'}>
      {fetching > 0 ? <div className="progress-bar" aria-hidden="true" /> : null}
      {menuOpen ? <div className="scrim" onClick={() => setMenuOpen(false)} /> : null}
      <aside className="sidebar" data-open={menuOpen}>
        <Link href={me.company ? '/' : '/piattaforma'} className="brand" aria-label="Ricetta Quadra, vai alla dashboard">
          <BrandLogo height={38} />
        </Link>
        <nav className="nav" aria-label="Navigazione principale">
          {me.company
            ? sections.map((n) => (
                <Link key={n.href} href={n.href} prefetch aria-current={isActive(n.href) ? 'page' : undefined}>
                  <Icon name={n.icon} />
                  {n.label}
                  {alertCount(n.href) ? (
                    <span className="nav-count" title={n.href === '/ricette' ? 'Ricette con costo cambiato' : n.href === '/assistenza' ? 'Risposte dell’assistenza da leggere' : 'Prodotti con prezzo cambiato'}>
                      {alertCount(n.href)}
                    </span>
                  ) : null}
                </Link>
              ))
            : null}
          {platform ? (
            <>
              <div className="nav-section">Piattaforma</div>
              {PLATFORM_NAV.map((n) => (
                <Link key={n.href} href={n.href} prefetch aria-current={isActive(n.href) ? 'page' : undefined}>
                  <Icon name={n.icon} />
                  {n.label}
                  {alertCount(n.href) ? <span className="nav-count">{alertCount(n.href)}</span> : null}
                </Link>
              ))}
            </>
          ) : null}
        </nav>
        <div className="sidebar-foot stack tight">
          <div className="small">
            <div style={{ fontWeight: 600 }}>{me.user.name}</div>
            <div className="faint">{me.roleLabel ?? (platform ? 'Superadmin' : null)}</div>
          </div>
          <InstallButton />
          <button
            className="btn ghost sm"
            style={{ justifyContent: 'flex-start' }}
            onClick={async () => {
              await api.post('/auth/logout')
              qc.clear()
              router.replace('/accedi')
            }}
          >
            <Icon name="logout" /> Esci
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon menu-toggle" onClick={() => setMenuOpen(true)} aria-label="Apri menu">
            <Icon name="menu" />
          </button>
          {/* NUOVO (soluzione C): su smartphone il logo completo al centro della barra */}
          <Link href={me.company ? '/' : '/piattaforma'} className="topbar-logo" aria-label="Ricetta Quadra, vai alla dashboard">
            <BrandLogo height={30} />
          </Link>
          <div className="grow" />
          {me.assist ? (
            <span className="badge warn topbar-assist" title="Stai operando come amministratore di un'azienda cliente: ogni accesso è registrato">
              Assistenza
            </span>
          ) : null}
          {/* su computer il nome dell'azienda resta visibile accanto alle iniziali */}
          <span className="topbar-company muted ellipsis">{me.company ? me.company.name : 'Console piattaforma'}</span>
          <AccountMenu
            me={me}
            onGuide={() => {
              setMenuOpen(false)
              setTourOpen(true)
            }}
          />
        </header>
        <main className="content">{children}</main>
        <MobileTables />
        <OfflineBanner />
        {bottomNav ? (
          <BottomNav
            sections={sections}
            platform={platform ? PLATFORM_NAV : []}
            quick={quick}
            fourth={fourth}
            count={alertCount}
            isActive={isActive}
            onGuide={() => setTourOpen(true)}
          />
        ) : null}
        {tourOpen && me.company ? <Tour me={me} onClose={() => setTourOpen(false)} /> : null}
      </div>
    </div>
  )
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {actions ? <div className="row wrap">{actions}</div> : null}
    </div>
  )
}
