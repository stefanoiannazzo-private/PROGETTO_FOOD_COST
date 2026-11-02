'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api'

export interface Me {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean } | null
  company: { id: string; name: string } | null
  role: 'admin' | 'manager' | 'operator' | null
  roleLabel: string | null
  permissions: string[]
  companies: Array<{ id: string; name: string; role: string; roleLabel: string }>
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), staleTime: 5 * 60_000, retry: false })
}

/** Verifica di permesso lato interfaccia (l'autorizzazione vera è sempre nel backend). */
export function useCan() {
  const { data } = useMe()
  const perms = new Set(data?.permissions ?? [])
  return (p: string) => perms.has(p)
}

export function useSwitchCompany() {
  const qc = useQueryClient()
  return async (companyId: string) => {
    const me = await api.post<Me>('/auth/company', { companyId })
    // i dati in cache appartengono all'azienda precedente
    qc.clear()
    qc.setQueryData(['me'], me)
    return me
  }
}
