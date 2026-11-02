import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Invio email. In questa versione i messaggi vengono scritti nella cartella storage/outbox
 * (verificabili in locale). Il collegamento a un server SMTP è un limite dichiarato nel README.
 */
export async function sendMail(storageDir: string, to: string, subject: string, body: string): Promise<string> {
  const dir = join(storageDir, 'outbox')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${to.replace(/[^a-z0-9@.]/gi, '_')}.eml`)
  await writeFile(file, `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`, { mode: 0o600 })
  return file
}
