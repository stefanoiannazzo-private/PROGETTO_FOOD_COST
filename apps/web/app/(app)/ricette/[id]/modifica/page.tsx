'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead } from '@/components/AppShell'
import { editorFromRecipe, RecipeEditor } from '@/components/RecipeEditor'
import { ErrorBox, Skeleton } from '@/components/ui'

export default function EditRecipePage() {
  const { id } = useParams<{ id: string }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = useQuery({ queryKey: ['recipes', id], queryFn: () => api.get<any>(`/recipes/${id}`), staleTime: 0 })
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  if (!q.data) return <Skeleton rows={10} />
  return (
    <>
      <PageHead
        title={`Modifica: ${q.data.title}`}
        sub={
          <>
            Revisione corrente {q.data.revision?.number ?? '—'}: il salvataggio crea una nuova revisione, gli snapshot esistenti non cambiano.{' '}
            <Link className="link" href={`/ricette/${id}`}>
              Torna alla scheda
            </Link>
          </>
        }
      />
      <RecipeEditor key={`${id}-${q.data.lockVersion}`} recipeId={id} initial={editorFromRecipe(q.data)} lockVersion={q.data.lockVersion} />
    </>
  )
}
