'use client'

import { useParams } from 'next/navigation'
import { PublicMenu } from '@/components/PublicMenu'

/** NUOVO — menu digitale del locale (QR generale). */
export default function PublicMenuPage() {
  const { token } = useParams<{ token: string }>()
  return <PublicMenu path={`/public/menu/${encodeURIComponent(token)}`} />
}
