/**
 * Sostituto di `next/navigation` per la build Vite: useRouter, useParams, usePathname
 * con la stessa semantica usata dalle pagine originali, basati su React Router.
 */
import { useMemo } from 'react'
import { useLocation, useNavigate, useParams as useRouterParams } from 'react-router'

export function useRouter() {
  const navigate = useNavigate()
  // come in Next.js i metodi non restituiscono nulla: le pagine originali li usano anche come
  // corpo di useEffect (`useEffect(() => router.replace(...))`) e un valore restituito sarebbe
  // scambiato da React per una funzione di pulizia
  return useMemo(
    () => ({
      push: (href: string): void => void navigate(href),
      replace: (href: string): void => void navigate(href, { replace: true }),
      back: (): void => void navigate(-1),
      forward: (): void => void navigate(1),
      refresh: (): void => void navigate(0),
      prefetch: (_href: string): void => undefined,
    }),
    [navigate],
  )
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useRouterParams() as T
}

export function usePathname(): string {
  return useLocation().pathname
}

export function useSearchParams(): URLSearchParams {
  const { search } = useLocation()
  return useMemo(() => new URLSearchParams(search), [search])
}
