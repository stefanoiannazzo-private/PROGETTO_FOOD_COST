import { z } from 'zod'
import { parseDec, MEASURE_UNITS } from '@foodcost/domain'

/**
 * Decimale in ingresso alle API: numero oppure stringa normalizzata ("1234.56").
 * È tollerata la sola virgola decimale ("0,9"); i separatori delle migliaia sono rifiutati
 * perché ambigui ("2.400"): il formato italiano completo è interpretato da UI e importazioni.
 * Restituisce una stringa normalizzata col punto. Mai float nei calcoli.
 */
function parseApiNumber(v: string | number) {
  if (typeof v === 'number') return parseDec(v)
  const s = v.trim()
  if (/^[-+]?\d+([.,]\d+)?$/.test(s)) return parseDec(s.replace(',', '.'))
  return null
}

export function dec(opts: { min?: number; gt?: number; max?: number; label?: string } = {}) {
  const label = opts.label ?? 'Il valore'
  return z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      const parsed = parseApiNumber(v)
      if (!parsed) {
        ctx.addIssue({ code: 'custom', message: `${label} non è un numero valido (usa il formato 1234.56).` })
        return z.NEVER
      }
      if (opts.gt !== undefined && !parsed.gt(opts.gt)) ctx.addIssue({ code: 'custom', message: `${label} deve essere maggiore di ${opts.gt}.` })
      if (opts.min !== undefined && parsed.lt(opts.min)) ctx.addIssue({ code: 'custom', message: `${label} non può essere inferiore a ${opts.min}.` })
      if (opts.max !== undefined && parsed.gt(opts.max)) ctx.addIssue({ code: 'custom', message: `${label} non può superare ${opts.max}.` })
      return parsed.toFixed()
    })
}

/** Decimale facoltativo: stringa vuota o null diventano null. */
export function decOpt(opts: Parameters<typeof dec>[0] = {}) {
  return z.preprocess((v) => (v === '' || v === undefined ? null : v), dec(opts).nullable())
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (formato aaaa-mm-gg).').refine((s) => !Number.isNaN(Date.parse(s)), 'Data non valida.')
export const measureUnit = z.enum(MEASURE_UNITS)
export const optText = (max = 2000) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable().optional())
export const reqText = (label: string, max = 200) => z.string({ error: `${label} è obbligatorio.` }).trim().min(1, `${label} è obbligatorio.`).max(max)

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).default('asc'),
  archived: z.enum(['0', '1', 'all']).default('0'),
  category: z.string().trim().max(100).optional(),
})
export type ListQuery = z.infer<typeof listQuery>

export function today(): string {
  const d = new Date()
  const tz = process.env.APP_TZ ?? 'Europe/Rome'
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

/** Ricerca testuale sicura per LIKE. */
export function likePattern(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}
