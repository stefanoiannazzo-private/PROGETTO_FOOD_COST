/** Forma serializzata del risultato del motore di calcolo (decimali come stringhe). */
export interface Issue {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  path: string[]
  ref?: { type: string; id: string }
}
export interface IngredientLine {
  componentId: string
  ingredientId: string | null
  code: string | null
  name: string
  quantity: string
  unit: string
  netBaseQuantity: string | null
  grossBaseQuantity: string | null
  baseUnit: string | null
  edibleYield: string | null
  unitPrice: string | null
  cost: string | null
  zeroPrice: boolean
}
export interface SubrecipeLine {
  componentId: string
  recipeId: string
  revisionId: string | null
  code: string | null
  name: string
  quantity: string
  unit: string
  unitCost: string | null
  basis: 'weight' | 'yield' | null
  fraction: string | null
  cost: string | null
  sub: RecipeCost | null
}
export interface EnergySource {
  source: 'electric' | 'gas'
  estimated: boolean
  consumption: string | null
  consumptionUnit: string | null
  billedConsumption: string | null
  tariffUnit: string | null
  tariffPrice: string | null
  coefficient: string | null
  cost: string | null
}
export interface EquipmentLine {
  useId: string
  equipmentId: string
  name: string
  phaseId: string | null
  segment: string
  minutes: string
  share: string
  sources: EnergySource[]
  fullCost: string | null
  cost: string | null
  manual: boolean
}
export interface LaborLine {
  assignmentId: string
  employeeId: string
  name: string
  phaseId: string | null
  activeMinutes: string
  share: string
  costPerMinute: string | null
  basis: string | null
  cost: string | null
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
  directIngredients: string
  subrecipes: string
  energy: string
  labor: string
  total: string
  expanded: { ingredients: string; energy: string; labor: string }
  finalQuantity: string | null
  finalUnit: string | null
  finalWeightKg: string | null
  portions: string | null
  portionWeightKg: string | null
  costPerKg: string | null
  costPerPortion: string | null
  costPerYieldUnit: string | null
  machineMinutes: string
  personMinutes: string
  declaredDurationMinutes: string | null
}
