'use client'

import { PageHead } from '@/components/AppShell'
import { emptyEditor, RecipeEditor } from '@/components/RecipeEditor'

export default function NewRecipePage() {
  return (
    <>
      <PageHead title="Nuova ricetta" sub="La bozza si può salvare anche incompleta: i dati mancanti restano evidenziati." />
      <RecipeEditor recipeId={null} initial={emptyEditor()} lockVersion={null} />
    </>
  )
}
