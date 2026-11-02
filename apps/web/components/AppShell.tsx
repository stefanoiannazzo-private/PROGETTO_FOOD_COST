'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { useMe, useSwitchCompany } from '@/lib/session'
import { Icon, Skeleton } from './ui'

const NAV: Array<{ href: string; label: string; icon: string; perm?: string }> = [
  { href: '/', label: 'Dashboard', icon: 'home' },
  { href: '/ricette', label: 'Ricette', icon: 'book', perm: 'recipes.read' },
  { href: '/ingredienti', label: 'Ingredienti', icon: 'box', perm: 'recipes.read' },
  { href: '/strumenti', label: 'Strumenti', icon: 'tool', perm: 'recipes.read' },
  { href: '/utenze', label: 'Utenze', icon: 'bolt', perm: 'tariffs.read' },
  { href: '/dipendenti', label: 'Dipendenti', icon: 'users', perm: 'employees.read' },
  { href: '/importazioni', label: 'Importazioni', icon: 'upload', perm: 'imports.manage' },
  { href: '/utenti', label: 'Utenti', icon: 'key', perm: 'users.manage' },
  { href: '/impostazioni', label: 'Impostazioni', icon: 'settings' },
]

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const qc = useQueryClient()
  const { data: me, isLoading, error } = useMe()
  const switchCompany = useSwitchCompany()
  const [menuOpen, setMenuOpen] = useState(false)
  const fetching = useIsFetching()

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

  if (isLoading || !me?.user) {
    return (
      <div className="auth-wrap">
        <div className="auth-card card">
          <Skeleton rows={3} />
        </div>
      </div>
    )
  }

  if (!me.company) {
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
          <button className="btn ghost" onClick={() => api.post('/auth/logout').then(() => router.replace('/accedi'))}>
            Esci
          </button>
        </div>
      </div>
    )
  }

  const perms = new Set(me.permissions)
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`))

  return (
    <div className="shell">
      {fetching > 0 ? <div className="progress-bar" aria-hidden="true" /> : null}
      {menuOpen ? <div className="scrim" onClick={() => setMenuOpen(false)} /> : null}
      <aside className="sidebar" data-open={menuOpen}>
        <div className="brand">
          <span className="brand-mark">€</span>
          Food Cost
        </div>
        <nav className="nav" aria-label="Navigazione principale">
          {NAV.filter((n) => !n.perm || perms.has(n.perm)).map((n) => (
            <Link key={n.href} href={n.href} prefetch aria-current={isActive(n.href) ? 'page' : undefined}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot stack tight">
          <div className="small">
            <div style={{ fontWeight: 600 }}>{me.user.name}</div>
            <div className="faint">{me.roleLabel}</div>
          </div>
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
          <div className="grow" />
          {me.companies.length > 1 ? (
            <select
              className="input"
              style={{ width: 'auto', maxWidth: 260 }}
              value={me.company.id}
              aria-label="Azienda attiva"
              onChange={async (e) => {
                await switchCompany(e.target.value)
                router.push('/')
              }}
            >
              {me.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted" style={{ fontWeight: 600 }}>
              {me.company.name}
            </span>
          )}
        </header>
        <main className="content">{children}</main>
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
