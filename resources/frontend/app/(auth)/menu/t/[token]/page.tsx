'use client'

import { useParams } from 'next/navigation'
import { PublicMenu } from '@/components/PublicMenu'

/** NUOVO — menu digitale dal QR di un tavolo. */
export default function PublicTableMenuPage() {
  const { token } = useParams<{ token: string }>()
  return <PublicMenu path={`/public/menu/t/${encodeURIComponent(token)}`} />
}
