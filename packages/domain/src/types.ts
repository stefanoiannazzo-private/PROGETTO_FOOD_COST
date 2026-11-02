import type { Dec } from './decimal'
import type { MeasureUnit } from './units'

/* ------------------------------------------------------------------ *
 * Dati di ingresso del motore, già risolti alla data di valorizzazione.
 * Il motore non accede al database: riceve tutto ciò che serve.
 * ------------------------------------------------------------------ */

export interface IngredientInput {
  id: string
  code: string
  name: string
  /** Unità del contenuto della confezione (definisce la grandezza dell'ingrediente). */
  packageUnit: MeasureUnit
  /** Contenuto della confezione nell'unità packageUnit, > 0. */
  packageContent: Dec
  /** Prezzo netto IVA della confezione valido alla data; null = prezzo mancante. Zero è un prezzo esplicito. */
  packagePrice: Dec | null
  priceId?: string | null
  priceValidFrom?: string | null
  /** Resa edibile 0 < y ≤ 1 (1 = 100%). */
  edibleYield: Dec
  densityKgPerL?: Dec | null
  unitWeightKg?: Dec | null
}

export type TariffUnit = 'kwh' | 'm3' | 'smc'
export type TariffKind = 'electricity' | 'gas' | 'water'

export interface TariffInput {
  id: string
  name: string
  kind: TariffKind
  unit: TariffUnit
  /** euro per unità, valore valido alla data */
  pricePerUnit: Dec
  versionId?: string | null
  validFrom?: string | null
  /** Coefficienti di conversione documentati (facoltativi). */
  m3ToSmc?: Dec | null
  smcToKwh?: Dec | null
}

export type PowerType = 'electric' | 'gas' | 'mixed' | 'manual'
export type GasFlowUnit = 'm3' | 'smc'

export interface EquipmentInput {
  id: string
  code: string
  name: string
  powerType: PowerType
  electric?: {
    powerKw: Dec | null
    usageCoefficient: Dec | null
    preheatCoefficient?: Dec | null
    holdCoefficient?: Dec | null
    tariffId: string | null
  } | null
  gas?: {
    mode: 'flow' | 'energy'
    /** portata oraria per mode = flow */
    flowPerHour?: Dec | null
    flowUnit?: GasFlowUnit | null
    /** potenza in kW per mode = energy (consumo in kWh) */
    powerKw?: Dec | null
    /** fattore di carico facoltativo, applicato una sola volta */
    loadFactor?: Dec | null
    tariffId: string | null
  } | null
}

export interface EmployeeCostInput {
  employeeId: string
  code: string
  name: string
  configId?: string | null
  grossMonthly: Dec
  contributionsMode: 'none' | 'amount' | 'percent'
  /** importo mensile (amount) o percentuale sul lordo (percent, es. 30 = 30%) */
  contributionsValue: Dec | null
  otherMonthlyCosts: Dec | null
  productiveHours: Dec
}

export type Segment = 'preheat' | 'work' | 'hold'

export interface ComponentInput {
  id: string
  kind: 'ingredient' | 'recipe'
  ingredientId?: string | null
  recipeId?: string | null
  quantity: Dec
  unit: MeasureUnit
  note?: string | null
}

export interface EquipmentUseInput {
  id: string
  equipmentId: string
  phaseId?: string | null
  segment: Segment
  minutes: Dec
  /** quota di imputazione al lotto, 0 < s ≤ 1 */
  share: Dec
  /** per strumenti misti: fonti effettivamente usate */
  sources?: Array<'electric' | 'gas'> | null
  /** consumi misurati: sostituiscono la stima, non si sommano */
  measuredElectricKwh?: Dec | null
  measuredGasQuantity?: Dec | null
  measuredGasUnit?: TariffUnit | null
}

export interface LaborAssignmentInput {
  id: string
  employeeId: string
  phaseId?: string | null
  activeMinutes: Dec
  share: Dec
}

export interface PhaseInput {
  id: string
  name: string
  position: number
}

export interface RecipeInput {
  id: string
  revisionId: string
  revisionNumber?: number
  code: string
  title: string
  finalQuantity: Dec | null
  finalUnit: MeasureUnit | null
  finalWeightKg: Dec | null
  portions: Dec | null
  declaredDurationMinutes: Dec | null
  phases: PhaseInput[]
  components: ComponentInput[]
  equipmentUses: EquipmentUseInput[]
  laborAssignments: LaborAssignmentInput[]
}

export interface ValuationContext {
  /** data di valorizzazione ISO (yyyy-mm-dd) */
  date: string
  recipes: Map<string, RecipeInput>
  ingredients: Map<string, IngredientInput>
  equipment: Map<string, EquipmentInput>
  tariffs: Map<string, TariffInput>
  employees: Map<string, EmployeeCostInput>
  /** limiti di complessità */
  maxDepth?: number
  maxNodes?: number
}

/* ------------------------------------------------------------------ *
 * Risultati
 * ------------------------------------------------------------------ */

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface Issue {
  code: string
  severity: IssueSeverity
  message: string
  /** percorso delle ricette (titoli) fino al punto che genera la segnalazione */
  path: string[]
  ref?: { type: 'component' | 'equipment_use' | 'labor' | 'recipe' | 'ingredient' | 'employee' | 'tariff' | 'equipment'; id: string }
}

export interface CostBreakdown {
  ingredients: Dec
  energy: Dec
  labor: Dec
}

export interface IngredientLine {
  componentId: string
  ingredientId: string | null
  code: string | null
  name: string
  quantity: Dec
  unit: MeasureUnit
  /** quantità netta nella grandezza dell'ingrediente (kg, l o pz) */
  netBaseQuantity: Dec | null
  /** quantità acquistata equivalente = netta / resa edibile */
  grossBaseQuantity: Dec | null
  baseUnit: MeasureUnit | null
  edibleYield: Dec | null
  unitPrice: Dec | null
  priceId: string | null
  cost: Dec | null
  zeroPrice: boolean
}

export interface SubrecipeLine {
  componentId: string
  recipeId: string
  revisionId: string | null
  code: string | null
  name: string
  quantity: Dec
  unit: MeasureUnit
  /** costo unitario della sottoricetta nella base usata (€/kg, €/l o €/pz) */
  unitCost: Dec | null
  basis: 'weight' | 'yield' | null
  /** frazione del lotto della sottoricetta prelevata */
  fraction: Dec | null
  cost: Dec | null
  /** dettaglio informativo della sottoricetta, mai risommato al totale */
  sub: RecipeCost | null
}

export interface EnergySourceDetail {
  source: 'electric' | 'gas'
  estimated: boolean
  consumption: Dec | null
  consumptionUnit: TariffUnit | null
  /** consumo convertito nell'unità della tariffa */
  billedConsumption: Dec | null
  tariffId: string | null
  tariffUnit: TariffUnit | null
  tariffPrice: Dec | null
  coefficient: Dec | null
  cost: Dec | null
}

export interface EquipmentLine {
  useId: string
  equipmentId: string
  name: string
  phaseId: string | null
  segment: Segment
  minutes: Dec
  share: Dec
  sources: EnergySourceDetail[]
  /** costo dell'uso prima della quota */
  fullCost: Dec | null
  /** costo imputato = costo uso × quota */
  cost: Dec | null
  manual: boolean
}

export interface LaborLine {
  assignmentId: string
  employeeId: string
  name: string
  phaseId: string | null
  activeMinutes: Dec
  share: Dec
  costPerMinute: Dec | null
  basis: 'company_cost' | 'gross_only' | null
  cost: Dec | null
}

export interface RecipeCost {
  recipeId: string
  revisionId: string
  revisionNumber: number | null
  code: string
  title: string
  date: string
  complete: boolean
  issues: Issue[]
  ingredientLines: IngredientLine[]
  subrecipeLines: SubrecipeLine[]
  equipmentLines: EquipmentLine[]
  laborLines: LaborLine[]
  /** subtotali per voce del lotto (solo valori valorizzati) */
  directIngredients: Dec
  subrecipes: Dec
  energy: Dec
  labor: Dec
  total: Dec
  /** riepilogo globale con i semilavorati espansi al posto del loro subtotale */
  expanded: CostBreakdown
  finalQuantity: Dec | null
  finalUnit: MeasureUnit | null
  finalWeightKg: Dec | null
  portions: Dec | null
  portionWeightKg: Dec | null
  costPerKg: Dec | null
  costPerPortion: Dec | null
  /** costo per unità di resa dichiarata (€/kg, €/l, €/pz) */
  costPerYieldUnit: Dec | null
  machineMinutes: Dec
  personMinutes: Dec
  declaredDurationMinutes: Dec | null
}
