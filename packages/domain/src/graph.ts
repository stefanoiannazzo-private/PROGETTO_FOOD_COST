/**
 * Grafo delle dipendenze tra ricette (padre → sottoricette).
 * Usato per impedire cicli al salvataggio e per trovare le ricette interessate da una modifica.
 */
export type RecipeEdges = Map<string, Iterable<string>>

/**
 * Restituisce il percorso del ciclo che si creerebbe dando a `recipeId` i figli `children`,
 * oppure null se il grafo resta aciclico. Il percorso parte e termina con recipeId.
 * La deduplicazione dei nodi visitati serve solo alla ricerca: non incide sul conteggio dei fabbisogni.
 */
export function findCycle(edges: RecipeEdges, recipeId: string, children: Iterable<string>): string[] | null {
  const childrenOf = (id: string): Iterable<string> => (id === recipeId ? children : (edges.get(id) ?? []))
  const visited = new Set<string>()

  const dfs = (node: string, path: string[]): string[] | null => {
    for (const child of childrenOf(node)) {
      if (child === recipeId) return [...path, child]
      if (visited.has(child)) continue
      visited.add(child)
      const found = dfs(child, [...path, child])
      if (found) return found
    }
    return null
  }
  return dfs(recipeId, [recipeId])
}

/** Tutte le ricette che dipendono, direttamente o indirettamente, da uno dei nodi indicati. */
export function dependentsOf(edges: RecipeEdges, targets: Iterable<string>): Set<string> {
  const parents = new Map<string, string[]>()
  for (const [parent, kids] of edges) {
    for (const k of kids) {
      const list = parents.get(k) ?? []
      list.push(parent)
      parents.set(k, list)
    }
  }
  const result = new Set<string>()
  const queue = [...targets]
  while (queue.length) {
    const node = queue.shift()!
    for (const p of parents.get(node) ?? []) {
      if (!result.has(p)) {
        result.add(p)
        queue.push(p)
      }
    }
  }
  return result
}

/** Chiusura delle sottoricette raggiungibili da un insieme di ricette (incluse le radici). */
export function descendantsOf(edges: RecipeEdges, roots: Iterable<string>): Set<string> {
  const result = new Set<string>()
  const queue = [...roots]
  while (queue.length) {
    const node = queue.shift()!
    if (result.has(node)) continue
    result.add(node)
    for (const c of edges.get(node) ?? []) queue.push(c)
  }
  return result
}
