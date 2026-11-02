import { Dec, ONE, ZERO, sum } from './decimal'
import { DomainError, employeeRates, energyForUse, ingredientUsageCost, laborCost } from './calculators'
import { convertToDimension, dimensionOf, toBase, UnitConversionError } from './units'
import type {
  CostBreakdown,
  EquipmentLine,
  IngredientLine,
  Issue,
  LaborLine,
  RecipeCost,
  RecipeInput,
  SubrecipeLine,
  ValuationContext,
} from './types'

const DEFAULT_MAX_DEPTH = 12
const DEFAULT_MAX_NODES = 2000

/**
 * Motore di valorizzazione delle ricette.
 *
 * - Una sottoricetta è valorizzata una sola volta per contesto (memoizzazione per azienda/revisione/data,
 *   garantita dal fatto che il contesto è già risolto per una data e un'azienda).
 * - Ogni riga che usa una sottoricetta è costata separatamente: due usi della stessa sottoricetta si sommano.
 * - Il costo di una sottoricetta entra nel padre solo come subtotale di riga; il dettaglio interno è informativo.
 */
export class RecipeCostEngine {
  private memo = new Map<string, RecipeCost>()
  private visits = 0

  constructor(private readonly ctx: ValuationContext) {}

  value(recipeId: string): RecipeCost {
    return this.visit(recipeId, [])
  }

  private visit(recipeId: string, stack: string[]): RecipeCost {
    const cached = this.memo.get(recipeId)
    if (cached) return cached

    const recipe = this.ctx.recipes.get(recipeId)
    if (!recipe) throw new DomainError('recipe_not_found', `Ricetta ${recipeId} non trovata nel contesto di calcolo.`)

    this.visits++
    if (this.visits > (this.ctx.maxNodes ?? DEFAULT_MAX_NODES)) {
      throw new DomainError('too_complex', 'La struttura delle ricette supera il limite di complessità ammesso.')
    }

    const result = this.compute(recipe, [...stack, recipeId])
    this.memo.set(recipeId, result)
    return result
  }

  private compute(recipe: RecipeInput, stack: string[]): RecipeCost {
    const issues: Issue[] = []
    const here = [recipe.title]
    const issue = (code: string, message: string, severity: Issue['severity'] = 'error', ref?: Issue['ref']) =>
      issues.push({ code, message, severity, path: here, ...(ref ? { ref } : {}) })

    /* ---------------- ingredienti diretti e semilavorati ---------------- */
    const ingredientLines: IngredientLine[] = []
    const subrecipeLines: SubrecipeLine[] = []
    const subExpanded: CostBreakdown[] = []

    for (const c of recipe.components) {
      const ref = { type: 'component' as const, id: c.id }
      const hasIng = !!c.ingredientId
      const hasRec = !!c.recipeId
      if (hasIng === hasRec) {
        issue('invalid_component', 'Ogni componente deve riferirsi a un ingrediente oppure a una ricetta, non a entrambi né a nessuno.', 'error', ref)
        continue
      }
      if (!c.quantity.isFinite() || c.quantity.lte(0)) {
        issue('invalid_quantity', 'Quantità mancante o pari a zero: il componente non è valorizzato.', 'error', ref)
      }

      if (hasIng) {
        const ing = this.ctx.ingredients.get(c.ingredientId!)
        const line: IngredientLine = {
          componentId: c.id,
          ingredientId: c.ingredientId!,
          code: ing?.code ?? null,
          name: ing?.name ?? 'Ingrediente non disponibile',
          quantity: c.quantity,
          unit: c.unit,
          netBaseQuantity: null,
          grossBaseQuantity: null,
          baseUnit: null,
          edibleYield: ing?.edibleYield ?? null,
          unitPrice: null,
          priceId: ing?.priceId ?? null,
          cost: null,
          zeroPrice: false,
        }
        ingredientLines.push(line)
        if (!ing) {
          issue('missing_ingredient', 'Ingrediente non trovato o non accessibile.', 'error', ref)
          continue
        }
        try {
          const u = ingredientUsageCost(ing, c.quantity, c.unit)
          line.netBaseQuantity = u.netBaseQuantity
          line.grossBaseQuantity = u.grossBaseQuantity
          line.baseUnit = u.baseUnit
          line.unitPrice = u.unitPrice
          if (u.unitPrice === null) {
            issue('missing_price', `${ing.name}: nessun prezzo valido alla data ${this.ctx.date}.`, 'error', { type: 'ingredient', id: ing.id })
          } else {
            line.zeroPrice = u.unitPrice.isZero()
            if (line.zeroPrice) issue('zero_price', `${ing.name}: prezzo esplicitamente pari a zero.`, 'info', { type: 'ingredient', id: ing.id })
            if (c.quantity.gt(0)) line.cost = u.cost
          }
        } catch (e) {
          if (e instanceof UnitConversionError || e instanceof DomainError) issue(e instanceof DomainError ? e.code : 'unit_conversion', `${ing.name}: ${e.message}`, 'error', ref)
          else throw e
        }
        continue
      }

      /* semilavorato */
      const subId = c.recipeId!
      const subInput = this.ctx.recipes.get(subId)
      const line: SubrecipeLine = {
        componentId: c.id,
        recipeId: subId,
        revisionId: subInput?.revisionId ?? null,
        code: subInput?.code ?? null,
        name: subInput?.title ?? 'Ricetta non disponibile',
        quantity: c.quantity,
        unit: c.unit,
        unitCost: null,
        basis: null,
        fraction: null,
        cost: null,
        sub: null,
      }
      subrecipeLines.push(line)
      if (!subInput) {
        issue('missing_subrecipe', 'Sottoricetta non trovata o non accessibile.', 'error', ref)
        continue
      }
      if (stack.includes(subId)) {
        issue('cycle', `Ciclo rilevato: ${subInput.title} contiene direttamente o indirettamente ${recipe.title}.`, 'error', ref)
        issues[issues.length - 1]!.path = [recipe.title, subInput.title]
        continue
      }
      if (stack.length >= (this.ctx.maxDepth ?? DEFAULT_MAX_DEPTH)) {
        issue('max_depth', 'Superato il numero massimo di livelli di annidamento.', 'error', ref)
        continue
      }

      const sub = this.visit(subId, stack)
      line.sub = sub
      for (const si of sub.issues) issues.push({ ...si, path: [recipe.title, ...si.path] })

      // Base di dosaggio: peso finale netto per unità di massa, altrimenti la resa dichiarata se compatibile.
      try {
        const qtyDim = dimensionOf(c.unit)
        let denominator: Dec | null = null
        let qtyBase: Dec | null = null
        if (qtyDim === 'mass' && sub.finalWeightKg && sub.finalWeightKg.gt(0)) {
          line.basis = 'weight'
          denominator = sub.finalWeightKg
          qtyBase = toBase(c.quantity, c.unit)
        } else if (sub.finalUnit && sub.finalQuantity && sub.finalQuantity.gt(0) && dimensionOf(sub.finalUnit) === qtyDim) {
          line.basis = 'yield'
          denominator = toBase(sub.finalQuantity, sub.finalUnit)
          qtyBase = convertToDimension(c.quantity, c.unit, qtyDim)
        }
        if (!denominator || !qtyBase) {
          issue(
            'incompatible_subrecipe_unit',
            `${sub.title}: impossibile dosare in ${c.unit}. Dichiara il peso finale netto della sottoricetta oppure usa l'unità della sua resa.`,
            'error',
            ref,
          )
          continue
        }
        line.unitCost = sub.total.div(denominator)
        line.fraction = qtyBase.div(denominator)
        if (c.quantity.gt(0)) {
          line.cost = sub.total.times(line.fraction)
          subExpanded.push({
            ingredients: sub.expanded.ingredients.times(line.fraction),
            energy: sub.expanded.energy.times(line.fraction),
            labor: sub.expanded.labor.times(line.fraction),
          })
        }
      } catch (e) {
        if (e instanceof UnitConversionError) issue('unit_conversion', `${sub.title}: ${e.message}`, 'error', ref)
        else throw e
      }
    }

    /* ---------------------------- strumenti ---------------------------- */
    const equipmentLines: EquipmentLine[] = []
    for (const u of recipe.equipmentUses) {
      const ref = { type: 'equipment_use' as const, id: u.id }
      const eq = this.ctx.equipment.get(u.equipmentId)
      const line: EquipmentLine = {
        useId: u.id,
        equipmentId: u.equipmentId,
        name: eq?.name ?? 'Strumento non disponibile',
        phaseId: u.phaseId ?? null,
        segment: u.segment,
        minutes: u.minutes,
        share: u.share,
        sources: [],
        fullCost: null,
        cost: null,
        manual: false,
      }
      equipmentLines.push(line)
      if (!eq) {
        issue('missing_equipment', 'Strumento non trovato o non accessibile.', 'error', ref)
        continue
      }
      if (u.minutes.lte(0)) {
        issue('invalid_minutes', `${eq.name}: durata d'uso mancante o pari a zero.`, 'error', ref)
        continue
      }
      if (u.share.lte(0) || u.share.gt(1)) {
        issue('invalid_share', `${eq.name}: quota di imputazione fuori intervallo (0–100%].`, 'error', ref)
        continue
      }
      const energy = energyForUse({
        equipment: eq,
        segment: u.segment,
        minutes: u.minutes,
        sources: u.sources ?? null,
        measuredElectricKwh: u.measuredElectricKwh ?? null,
        measuredGasQuantity: u.measuredGasQuantity ?? null,
        measuredGasUnit: u.measuredGasUnit ?? null,
        tariffs: this.ctx.tariffs,
      })
      line.sources = energy.sources
      line.manual = energy.manual
      for (const ei of energy.issues) issue(ei.code, ei.message, 'error', ref)
      if (energy.manual) {
        line.fullCost = ZERO
        line.cost = ZERO
        continue
      }
      const valued = energy.sources.filter((s) => s.cost !== null)
      if (valued.length > 0) {
        line.fullCost = sum(valued.map((s) => s.cost!))
        line.cost = line.fullCost.times(u.share)
      }
      if (u.share.lt(1)) issue('shared_equipment', `${eq.name}: imputato il ${u.share.times(100).toFixed()}% del costo d'uso (quota dichiarata).`, 'info', ref)
      if (energy.sources.some((s) => s.estimated && s.cost !== null)) {
        issue('estimated_energy', `${eq.name}: consumo stimato da potenza e coefficiente, non misurato.`, 'info', ref)
      }
    }

    /* ---------------------------- manodopera ---------------------------- */
    const laborLines: LaborLine[] = []
    for (const a of recipe.laborAssignments) {
      const ref = { type: 'labor' as const, id: a.id }
      const emp = this.ctx.employees.get(a.employeeId)
      const line: LaborLine = {
        assignmentId: a.id,
        employeeId: a.employeeId,
        name: emp?.name ?? 'Dipendente non disponibile',
        phaseId: a.phaseId ?? null,
        activeMinutes: a.activeMinutes,
        share: a.share,
        costPerMinute: null,
        basis: null,
        cost: null,
      }
      laborLines.push(line)
      if (!emp) {
        issue('missing_labor_cost', 'Costo del lavoro non configurato alla data per il dipendente assegnato.', 'error', ref)
        continue
      }
      if (a.activeMinutes.lte(0)) {
        issue('invalid_minutes', `${emp.name}: minuti attivi mancanti o pari a zero.`, 'error', ref)
        continue
      }
      if (a.share.lte(0) || a.share.gt(1)) {
        issue('invalid_share', `${emp.name}: quota di imputazione fuori intervallo (0–100%].`, 'error', ref)
        continue
      }
      try {
        const rates = employeeRates(emp)
        line.costPerMinute = rates.costPerMinute
        line.basis = rates.basis
        line.cost = laborCost(a.activeMinutes, rates.costPerMinute, a.share)
        if (rates.basis === 'gross_only') {
          issue('gross_only', `${emp.name}: costo calcolato sul solo lordo, senza oneri aziendali inseriti.`, 'warning', ref)
        }
      } catch (e) {
        if (e instanceof DomainError) issue(e.code, `${emp.name}: ${e.message}`, 'error', ref)
        else throw e
      }
    }

    /* ----------------------------- totali ----------------------------- */
    const directIngredients = sum(ingredientLines.filter((l) => l.cost).map((l) => l.cost!))
    const subrecipes = sum(subrecipeLines.filter((l) => l.cost).map((l) => l.cost!))
    const energy = sum(equipmentLines.filter((l) => l.cost).map((l) => l.cost!))
    const labor = sum(laborLines.filter((l) => l.cost).map((l) => l.cost!))
    const total = directIngredients.plus(subrecipes).plus(energy).plus(labor)

    const expanded: CostBreakdown = {
      ingredients: directIngredients.plus(sum(subExpanded.map((x) => x.ingredients))),
      energy: energy.plus(sum(subExpanded.map((x) => x.energy))),
      labor: labor.plus(sum(subExpanded.map((x) => x.labor))),
    }

    const finalWeightKg = recipe.finalWeightKg && recipe.finalWeightKg.gt(0) ? recipe.finalWeightKg : null
    const portions = recipe.portions && recipe.portions.gt(0) ? recipe.portions : null
    if (!finalWeightKg) issue('missing_final_weight', 'Peso finale netto non dichiarato: costo al kg non calcolabile.', 'warning', { type: 'recipe', id: recipe.id })
    if (!portions) issue('missing_portions', 'Numero di porzioni non dichiarato: costo per porzione non calcolabile.', 'warning', { type: 'recipe', id: recipe.id })
    if (!recipe.finalQuantity || recipe.finalQuantity.lte(0) || !recipe.finalUnit) {
      issue('missing_yield', 'Resa finale non dichiarata.', 'warning', { type: 'recipe', id: recipe.id })
    }

    const finalQtyBase = recipe.finalQuantity && recipe.finalUnit && recipe.finalQuantity.gt(0) ? toBase(recipe.finalQuantity, recipe.finalUnit) : null
    const complete = !issues.some((i) => i.severity === 'error')

    return {
      recipeId: recipe.id,
      revisionId: recipe.revisionId,
      revisionNumber: recipe.revisionNumber ?? null,
      code: recipe.code,
      title: recipe.title,
      date: this.ctx.date,
      complete,
      issues,
      ingredientLines,
      subrecipeLines,
      equipmentLines,
      laborLines,
      directIngredients,
      subrecipes,
      energy,
      labor,
      total,
      expanded,
      finalQuantity: recipe.finalQuantity,
      finalUnit: recipe.finalUnit,
      finalWeightKg,
      portions,
      portionWeightKg: finalWeightKg && portions ? finalWeightKg.div(portions) : null,
      costPerKg: finalWeightKg ? total.div(finalWeightKg) : null,
      costPerPortion: portions ? total.div(portions) : null,
      costPerYieldUnit: finalQtyBase ? total.div(finalQtyBase) : null,
      machineMinutes: sum(recipe.equipmentUses.map((u) => u.minutes)),
      personMinutes: sum(recipe.laborAssignments.map((a) => a.activeMinutes)),
      declaredDurationMinutes: recipe.declaredDurationMinutes,
    }
  }
}

export function valueRecipe(ctx: ValuationContext, recipeId: string): RecipeCost {
  return new RecipeCostEngine(ctx).value(recipeId)
}

/** Percentuale di una voce sul totale (null se il totale è zero). */
export function shareOfTotal(part: Dec, total: Dec): Dec | null {
  return total.isZero() ? null : part.div(total).times(100)
}

export { ONE }
