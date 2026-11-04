import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import nodemailer, { type Transporter } from 'nodemailer'

/**
 * Invio email.
 * - Con SMTP_HOST configurato i messaggi partono dal server di posta (produzione).
 * - Senza SMTP i messaggi sono scritti in storage/outbox (sviluppo locale), mai inviati.
 */
let transporter: Transporter | null | undefined

function smtp(): Transporter | null {
  if (transporter !== undefined) return transporter
  const host = process.env.SMTP_HOST
  if (!host) return (transporter = null)
  const port = Number(process.env.SMTP_PORT || 587)
  transporter = nodemailer.createTransport({
    host,
    port,
    // 465 = TLS implicito; 587/25 = STARTTLS obbligatorio
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    requireTLS: port !== 465 && process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
    connectionTimeout: 15_000,
  })
  return transporter
}

export function mailConfigured(): boolean {
  return smtp() !== null
}

export async function sendMail(storageDir: string, to: string, subject: string, body: string): Promise<'sent' | 'outbox'> {
  const t = smtp()
  if (t) {
    await t.sendMail({
      from: process.env.MAIL_FROM || 'Food Cost <no-reply@localhost>',
      to,
      subject,
      text: body,
    })
    return 'sent'
  }
  const dir = join(storageDir, 'outbox')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${to.replace(/[^a-z0-9@.]/gi, '_')}.eml`)
  await writeFile(file, `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}\n`, { mode: 0o600 })
  return 'outbox'
}

/** Solo per i test. */
export function resetMailer() {
  transporter = undefined
}
