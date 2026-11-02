import type { ZodError } from 'zod'

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

export const notFound = (what = 'Risorsa') => new AppError(404, 'not_found', `${what} non trovata.`)
export const forbidden = (message = 'Non hai i permessi per questa operazione.') => new AppError(403, 'forbidden', message)
export const unauthorized = () => new AppError(401, 'unauthenticated', 'Sessione scaduta o non valida: effettua di nuovo l’accesso.')
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details)
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details)

/** Errori di validazione in formato { campo: messaggio } per la UI. */
export function validationError(err: ZodError): AppError {
  const fields: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_'
    if (!fields[key]) fields[key] = issue.message
  }
  return new AppError(422, 'validation_failed', 'Alcuni dati non sono validi.', { fields })
}
