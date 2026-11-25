/** NUOVO — Pagina precedente all'interno dell'app (per proporre l'area giusta nel modulo di assistenza). */
let current = ''
let previous = ''

export function trackPath(path: string) {
  if (path === current) return
  previous = current
  current = path
}

/** La pagina da cui si è arrivati a `here` (gli effetti della pagina partono prima di quelli del layout). */
export function previousPath(here?: string): string {
  if (here && current && current !== here) return current
  return previous
}
