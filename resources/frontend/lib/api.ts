/** Client HTTP verso l'API (stessa origine, tramite rewrite di Next). */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: { fields?: Record<string, string>; path?: string[] } | null = null,
  ) {
    super(message)
  }
  get fields(): Record<string, string> {
    return this.details?.fields ?? {}
  }
}

type Query = Record<string, string | number | boolean | null | undefined>

export function qs(params: Query = {}): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-Requested-With': 'foodcost' } : {}),
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'network', 'Connessione non disponibile: i dati inseriti restano nella pagina, riprova tra poco.')
  }
  const text = await res.text()
  const data = text ? safeJson(text) : null
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: ApiError['details'] } } | null)?.error
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('foodcost:unauthorized'))
    }
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Errore ${res.status}`, err?.details ?? null)
  }
  return data as T
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', `${path}${qs(query)}`, undefined, signal),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
}

/** Opzioni comuni per le liste paginate. */
export interface Paged<T> {
  data: T[]
  meta: { page: number; pageSize: number; total: number; [k: string]: unknown }
}

export interface AffectedRecipe {
  id: string
  code: string
  title: string
  status: string
}
