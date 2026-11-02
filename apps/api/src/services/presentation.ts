import { d } from '@foodcost/domain'
import type { AuthContext } from '../http/context'
import type { SerializedCost } from './costing'

/**
 * Applica i permessi a un risultato di valorizzazione:
 * - senza costs.read nessun importo viene restituito;
 * - senza salaries.read le righe di manodopera non riportano costo al minuto né costo nominativo
 *   (resta il solo subtotale aggregato della manodopera).
 */
export function redactCost(cost: SerializedCost | null, ctx: AuthContext): SerializedCost | null {
  if (!cost) return null
  if (!ctx.permissions.has('costs.read')) return null
  if (ctx.permissions.has('salaries.read')) return cost
  return stripSalaries(cost)
}

function stripSalaries(cost: SerializedCost): SerializedCost {
  return {
    ...cost,
    laborLines: cost.laborLines.map((l) => ({ ...l, costPerMinute: null, cost: null })),
    subrecipeLines: cost.subrecipeLines.map((s) => ({ ...s, sub: s.sub ? stripSalaries(s.sub) : null })),
  }
}

export interface Comparison {
  snapshotId: string
  snapshotCreatedAt: Date
  snapshotDate: string
  snapshotLabel: string | null
  snapshotTotal: string
  currentTotal: string
  deltaTotal: string
  deltaPercent: string | null
  deltaPerKg: string | null
  deltaPerPortion: string | null
  reasons: string[]
}

/** Confronto tra valorizzazione corrente e ultimo snapshot, con i motivi principali della variazione. */
export function compare(
  current: SerializedCost,
  snap: { id: string; created_at: Date; valuation_date: string; label: string | null; data: unknown },
  salariesVisible: boolean,
): Comparison {
  const old = snap.data as SerializedCost
  const reasons: string[] = []
  if (old.revisionId !== current.revisionId) reasons.push(`Composizione modificata: revisione ${old.revisionNumber ?? '?'} → ${current.revisionNumber ?? '?'}.`)
  if (old.finalWeightKg !== current.finalWeightKg || old.portions !== current.portions) reasons.push('Resa finale o numero di porzioni modificati.')

  const oldIng = new Map(old.ingredientLines.map((l) => [l.ingredientId, l]))
  for (const l of current.ingredientLines) {
    const o = oldIng.get(l.ingredientId)
    if (o && o.unitPrice && l.unitPrice && !d(o.unitPrice).eq(l.unitPrice)) {
      reasons.push(`Prezzo di ${l.name}: ${fmt(o.unitPrice)} → ${fmt(l.unitPrice)} €/${l.baseUnit ?? ''}.`)
    }
  }
  const oldTariffs = new Map(old.equipmentLines.flatMap((l) => l.sources).filter((s) => s.tariffId).map((s) => [s.tariffId, s.tariffPrice]))
  const seenTariffs = new Set<string>()
  for (const s of current.equipmentLines.flatMap((l) => l.sources)) {
    if (!s.tariffId || seenTariffs.has(s.tariffId)) continue
    seenTariffs.add(s.tariffId)
    const o = oldTariffs.get(s.tariffId)
    if (o && s.tariffPrice && !d(o).eq(s.tariffPrice)) reasons.push(`Tariffa energetica variata: ${fmt(o, 4)} → ${fmt(s.tariffPrice, 4)} €/${s.tariffUnit}.`)
  }
  if (!d(old.labor).eq(current.labor)) {
    const oldLab = new Map(old.laborLines.map((l) => [l.employeeId, l.costPerMinute]))
    const changed = current.laborLines.some((l) => oldLab.has(l.employeeId) && oldLab.get(l.employeeId) !== l.costPerMinute)
    reasons.push(changed ? (salariesVisible ? 'Costo orario di uno o più dipendenti variato.' : 'Costo del lavoro variato.') : 'Manodopera della ricetta variata.')
  }
  const oldSub = new Map(old.subrecipeLines.map((l) => [l.recipeId, l]))
  for (const l of current.subrecipeLines) {
    const o = oldSub.get(l.recipeId)
    if (o && o.unitCost && l.unitCost && !d(o.unitCost).eq(l.unitCost)) reasons.push(`Costo del semilavorato ${l.name}: ${fmt(o.unitCost)} → ${fmt(l.unitCost)} € per unità.`)
  }
  if (reasons.length === 0 && !d(old.total).eq(current.total)) reasons.push('Variazione dovuta ai dati di costo alla data di valorizzazione.')

  const delta = d(current.total).minus(old.total)
  return {
    snapshotId: snap.id,
    snapshotCreatedAt: snap.created_at,
    snapshotDate: snap.valuation_date,
    snapshotLabel: snap.label,
    snapshotTotal: old.total,
    currentTotal: current.total,
    deltaTotal: delta.toFixed(),
    deltaPercent: d(old.total).isZero() ? null : delta.div(old.total).times(100).toFixed(),
    deltaPerKg: old.costPerKg && current.costPerKg ? d(current.costPerKg).minus(old.costPerKg).toFixed() : null,
    deltaPerPortion: old.costPerPortion && current.costPerPortion ? d(current.costPerPortion).minus(old.costPerPortion).toFixed() : null,
    reasons,
  }
}

function fmt(v: string, places = 2) {
  return d(v).toDecimalPlaces(places).toFixed(places).replace('.', ',')
}
