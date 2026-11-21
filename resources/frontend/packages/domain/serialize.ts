import { Dec } from './decimal'

/**
 * Converte ricorsivamente un risultato del motore in JSON puro: i decimali diventano stringhe con il punto.
 * Usato per le risposte API e per gli snapshot immutabili.
 */
export type Serialized<T> = T extends Dec
  ? string
  : T extends Array<infer U>
    ? Array<Serialized<U>>
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T

export function serialize<T>(value: T): Serialized<T> {
  if (value instanceof Dec) return value.toFixed() as Serialized<T>
  if (Array.isArray(value)) return value.map((v) => serialize(v)) as Serialized<T>
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v)
    return out as Serialized<T>
  }
  return value as Serialized<T>
}
