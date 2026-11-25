/**
 * Punto d'ingresso della build Vite. Riproduce l'albero delle rotte dell'app Next.js originale
 * (cartella app/): gruppo (auth) senza menu, gruppo (app) dentro AppShell. Le pagine sono quelle
 * originali, importate senza modifiche; next/link e next/navigation sono sostituiti da shims/.
 */
import { StrictMode, useEffect, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Outlet, RouterProvider, useLocation } from 'react-router'
import '../app/globals.css'
import { Providers } from '../app/providers'
import AppLayout from '../app/(app)/layout'

// pagine caricate subito (come il prefetch di Next.js): nessuna attesa né stato intermedio durante la navigazione
const pages = import.meta.glob<{ default: ComponentType }>('../app/**/page.tsx', { eager: true })

/** "../app/(app)/ricette/[id]/page.tsx" → "/ricette/:id" */
function routePath(file: string): string {
  const segs = file.replace('../app/', '').replace(/\/?page\.tsx$/, '').split('/').filter((s) => s && !/^\(.*\)$/.test(s))
  return '/' + segs.map((s) => s.replace(/^\[(.+)\]$/, ':$1')).join('/')
}

function page(file: string) {
  const C = pages[file]!.default
  return <C />
}

function ScrollToTop() {
  const { pathname } = useLocation()
  // blocco esplicito: nei browser recenti scrollTo restituisce una Promise, che React non accetta come pulizia
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

function Root() {
  useEffect(() => {
    document.title = 'Ricetta Quadra'
  }, [])
  return (
    <Providers>
      <ScrollToTop />
      <Outlet />
    </Providers>
  )
}

function Shell() {
  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  )
}

const files = Object.keys(pages)
const group = (g: string) => files.filter((f) => f.includes(`/(${g})/`)).map((f) => ({ path: routePath(f), element: page(f) }))

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      ...group('auth'),
      { element: <Shell />, children: [...group('app'), { path: '*', element: <NotFound /> }] },
    ],
  },
])

function NotFound() {
  return (
    <div className="card" style={{ padding: 24 }}>
      <h1>Pagina non trovata</h1>
      <p className="muted">L’indirizzo richiesto non esiste.</p>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
