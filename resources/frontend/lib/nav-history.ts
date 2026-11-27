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

/**
 * NUOVO — dopo «Salva» si torna dove si stava lavorando: la pagina precedente nell'app (es. l'elenco prodotti,
 * con i suoi filtri e la sua pagina, o la ricetta da cui si era aperto il prodotto), altrimenti `fallback`.
 */
export function backTarget(here: string, fallback: string): string {
  const p = previousPath(here)
  return p && p !== here && !/^\/(accedi|registrati|invito|reimposta)/.test(p) && !p.endsWith('/modifica') ? p : fallback
}

/** Testo del messaggio di salvataggio con le ricette ricalcolate, perché il riquadro della scheda non si vede più. */
export function savedMessage(base: string, affected: Array<{ title: string }> = []): string {
  if (!affected.length) return base
  const names = affected.slice(0, 3).map((r) => r.title).join(', ')
  return `${base} Ricalcolate ${affected.length === 1 ? 'la ricetta' : `${affected.length} ricette`}: ${names}${affected.length > 3 ? '…' : ''}.`
}
