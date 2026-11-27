'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { api } from '@/lib/api'
import { useMe } from '@/lib/session'
import { BrandMark } from '@/components/Brand'
import { ErrorBox, Icon, Skeleton } from '@/components/ui'

/** NUOVO — foglio da stampare con il QR di ogni tavolo (e quello generale del locale). */
interface Setup {
  tables: Array<{ id: string; label: string; isActive: boolean; qrUrl: string }>
  settings: { publicUrl: string; publicMode: string }
}

export default function QrSheet() {
  const me = useMe().data
  const q = useQuery({ queryKey: ['orders', 'setup'], queryFn: () => api.get<Setup>('/orders/setup') })
  const [codes, setCodes] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!q.data) return
    const all = [{ id: 'general', url: q.data.settings.publicUrl }, ...q.data.tables.filter((t) => t.isActive).map((t) => ({ id: t.id, url: t.qrUrl }))]
    void Promise.all(all.map(async (x) => [x.id, await QRCode.toDataURL(x.url, { margin: 1, width: 480, errorCorrectionLevel: 'M' })] as const)).then((r) => setCodes(Object.fromEntries(r)))
  }, [q.data])

  if (q.error) return <ErrorBox error={q.error} />
  if (!q.data) return <Skeleton />
  const company = me?.company?.name ?? ''
  const cards = [{ id: 'general', label: null as string | null }, ...q.data.tables.filter((t) => t.isActive).map((t) => ({ id: t.id, label: t.label }))]
  return (
    <>
      <div className="no-print row between wrap" style={{ marginBottom: 16, gap: 8 }}>
        <div>
          <h1 style={{ margin: 0 }}>QR da stampare</h1>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Un QR per tavolo, più uno generale per vetrina e bancone. Stampa su A4 e ritaglia.
            {q.data.settings.publicMode === 'off' ? ' Attenzione: il menu digitale è spento (Menu e tavoli → Menu digitale).' : ''}
          </p>
        </div>
        <button className="btn primary" onClick={() => window.print()}>
          <Icon name="download" /> Stampa
        </button>
      </div>
      <div className="qr-sheet">
        {cards.map((c) => (
          <div className="qr-card" key={c.id}>
            <div className="qr-top">
              <BrandMark size={22} />
              <span>{company}</span>
            </div>
            {codes[c.id] ? <img src={codes[c.id]} alt={`QR ${c.label ?? 'menu'}`} /> : <div className="qr-ph" />}
            <strong className="qr-label">{c.label ? `Tavolo ${c.label}` : 'Il nostro menu'}</strong>
            <span className="qr-hint">Inquadra con la fotocamera per vedere il menu</span>
          </div>
        ))}
      </div>
    </>
  )
}
