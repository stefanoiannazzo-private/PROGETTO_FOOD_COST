import type { ColumnType, Generated } from 'kysely'

/** NUMERIC: letto come stringa (precisione esatta), scritto come stringa. */
type Num = ColumnType<string, string | number, string | number>
type NumNull = ColumnType<string | null, string | number | null | undefined, string | number | null>
type Ts = ColumnType<Date, Date | string | undefined, Date | string>
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
/** DATE: letta come stringa yyyy-mm-dd (vedi parser in connection.ts). */
type DateCol = ColumnType<string, string, string>
type Json<T = unknown> = ColumnType<T, string | T, string | T>
type JsonNull<T = unknown> = ColumnType<T | null, string | T | null | undefined, string | T | null>

export interface CompaniesTable { id: Generated<string>; name: string; created_at: Generated<Date>; archived_at: TsNull }
export interface UsersTable {
  id: Generated<string>
  email: string
  name: string
  password_hash: string | null
  is_active: Generated<boolean>
  is_platform_admin: Generated<boolean>
  created_at: Generated<Date>
  last_login_at: TsNull
}
export interface MembershipsTable {
  id: Generated<string>
  company_id: string
  user_id: string
  role: 'admin' | 'manager' | 'operator'
  extra_permissions: ColumnType<string[], string[] | undefined, string[]>
  is_active: Generated<boolean>
  created_at: Generated<Date>
}
export interface SessionsTable {
  token_hash: string
  user_id: string
  active_company_id: string | null
  created_at: Generated<Date>
  last_seen_at: Generated<Date>
  expires_at: Ts
}
export interface PasswordResetsTable { token_hash: string; user_id: string; expires_at: Ts; used_at: TsNull; created_at: Generated<Date> }
export interface InvitationsTable {
  id: Generated<string>
  company_id: string
  email: string
  name: string
  role: 'admin' | 'manager' | 'operator'
  extra_permissions: ColumnType<string[], string[] | undefined, string[]>
  token_hash: string
  invited_by: string | null
  expires_at: Ts
  accepted_at: TsNull
  created_at: Generated<Date>
}

export interface IngredientsTable {
  id: Generated<string>
  company_id: string
  code: string
  name: string
  category: string | null
  supplier: string | null
  notes: string | null
  purchase_unit: Generated<string>
  package_content: Num
  package_unit: string
  usage_unit: string
  edible_yield: ColumnType<string, string | number | undefined, string | number>
  density_kg_per_l: NumNull
  unit_weight_kg: NumNull
  archived_at: TsNull
  created_at: Generated<Date>
  updated_at: Generated<Date>
  lock_version: Generated<number>
}
export interface IngredientPricesTable {
  id: Generated<string>
  company_id: string
  ingredient_id: string
  package_price: Num
  package_content: Num
  package_unit: string
  valid_from: DateCol
  source: string | null
  notes: string | null
  import_id: string | null
  created_by: string | null
  created_at: Generated<Date>
}

export interface UtilityTariffsTable {
  id: Generated<string>
  company_id: string
  name: string
  kind: 'electricity' | 'gas' | 'water'
  unit: 'kwh' | 'm3' | 'smc'
  notes: string | null
  archived_at: TsNull
  created_at: Generated<Date>
  updated_at: Generated<Date>
}
export interface TariffVersionsTable {
  id: Generated<string>
  company_id: string
  tariff_id: string
  price_per_unit: Num
  valid_from: DateCol
  origin: 'direct' | 'bill'
  m3_to_smc: NumNull
  smc_to_kwh: NumNull
  bill: JsonNull
  notes: string | null
  created_by: string | null
  created_at: Generated<Date>
}

export interface EquipmentTable {
  id: Generated<string>
  company_id: string
  code: string
  name: string
  category: string | null
  description: string | null
  power_type: 'electric' | 'gas' | 'mixed' | 'manual'
  status: Generated<'active' | 'maintenance' | 'inactive'>
  capacity: string | null
  electric_power_kw: NumNull
  usage_coefficient: NumNull
  preheat_coefficient: NumNull
  hold_coefficient: NumNull
  electric_tariff_id: string | null
  gas_mode: 'flow' | 'energy' | null
  gas_flow_per_hour: NumNull
  gas_flow_unit: 'm3' | 'smc' | null
  gas_power_kw: NumNull
  gas_load_factor: NumNull
  gas_tariff_id: string | null
  archived_at: TsNull
  created_at: Generated<Date>
  updated_at: Generated<Date>
  lock_version: Generated<number>
}

export interface EmployeesTable {
  id: Generated<string>
  company_id: string
  code: string
  first_name: string
  last_name: string
  job_title: string | null
  status: Generated<'active' | 'inactive'>
  user_id: string | null
  archived_at: TsNull
  created_at: Generated<Date>
  updated_at: Generated<Date>
}
export interface EmployeeCostConfigsTable {
  id: Generated<string>
  company_id: string
  employee_id: string
  valid_from: DateCol
  gross_monthly: Num
  contributions_mode: 'none' | 'amount' | 'percent'
  contributions_value: NumNull
  other_monthly_costs: ColumnType<string, string | number | undefined, string | number>
  productive_hours: Num
  notes: string | null
  import_id: string | null
  created_by: string | null
  created_at: Generated<Date>
}

export interface RecipesTable {
  id: Generated<string>
  company_id: string
  code: string
  title: string
  category: string | null
  description: string | null
  status: Generated<'draft' | 'active' | 'archived'>
  current_revision_id: string | null
  duplicated_from_id: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
  lock_version: Generated<number>
}
export interface RecipeRevisionsTable {
  id: Generated<string>
  company_id: string
  recipe_id: string
  number: number
  instructions: string | null
  final_quantity: NumNull
  final_unit: string | null
  final_weight_kg: NumNull
  portions: NumNull
  declared_duration_minutes: NumNull
  yield_notes: string | null
  created_by: string | null
  created_at: Generated<Date>
}
export interface RecipePhasesTable {
  id: Generated<string>
  company_id: string
  revision_id: string
  position: number
  name: string
  description: string | null
  start_offset_minutes: NumNull
  duration_minutes: NumNull
}
export interface RecipeComponentsTable {
  id: Generated<string>
  company_id: string
  revision_id: string
  position: number
  ingredient_id: string | null
  sub_recipe_id: string | null
  quantity: NumNull
  unit: string
  note: string | null
}
export interface RecipeEquipmentUsesTable {
  id: Generated<string>
  company_id: string
  revision_id: string
  phase_id: string | null
  position: number
  equipment_id: string
  segment: 'preheat' | 'work' | 'hold'
  minutes: NumNull
  share: Num
  sources: string[] | null
  measured_electric_kwh: NumNull
  measured_gas_quantity: NumNull
  measured_gas_unit: 'kwh' | 'm3' | 'smc' | null
  note: string | null
}
export interface RecipeLaborTable {
  id: Generated<string>
  company_id: string
  revision_id: string
  phase_id: string | null
  position: number
  employee_id: string
  active_minutes: NumNull
  share: Num
  note: string | null
}

export interface CostSnapshotsTable {
  id: Generated<string>
  company_id: string
  recipe_id: string
  revision_id: string
  valuation_date: DateCol
  label: string | null
  complete: boolean
  total: Num
  cost_per_kg: NumNull
  cost_per_portion: NumNull
  data: Json
  created_by: string | null
  created_at: Generated<Date>
}
export interface RecipeCostCacheTable {
  company_id: string
  recipe_id: string
  valuation_date: DateCol
  revision_id: string
  complete: boolean
  total: Num
  cost_per_kg: NumNull
  cost_per_portion: NumNull
  error_count: Generated<number>
  data: Json
  computed_at: Generated<Date>
}

export interface ImportsTable {
  id: Generated<string>
  company_id: string
  type: 'ingredients' | 'employees'
  status: Generated<'uploaded' | 'mapped' | 'validating' | 'validated' | 'applying' | 'applied' | 'failed' | 'cancelled'>
  original_name: string
  storage_path: string
  file_size: number
  file_kind: 'csv' | 'xlsx'
  options: ColumnType<Record<string, unknown>, string | Record<string, unknown> | undefined, string | Record<string, unknown>>
  mapping: JsonNull<Record<string, string | null>>
  summary: JsonNull<Record<string, unknown>>
  progress: Generated<number>
  total_rows: number | null
  error: string | null
  created_by: string | null
  created_at: Generated<Date>
  validated_at: TsNull
  confirmed_at: TsNull
  applied_at: TsNull
  lock_version: Generated<number>
}
export interface ImportRowsTable {
  id: Generated<string>
  import_id: string
  company_id: string
  row_number: number
  raw: Json<Record<string, unknown>>
  normalized: JsonNull<Record<string, unknown>>
  action: 'create' | 'update' | 'skip' | 'error' | null
  target_id: string | null
  errors: JsonNull<string[]>
  warnings: JsonNull<string[]>
}
export interface JobsTable {
  id: Generated<string>
  type: string
  payload: Json<Record<string, unknown>>
  status: Generated<'queued' | 'running' | 'done' | 'failed'>
  attempts: Generated<number>
  run_at: Generated<Date>
  locked_at: TsNull
  error: string | null
  dedupe_key: string | null
  created_at: Generated<Date>
}
export interface AuditLogsTable {
  id: Generated<string>
  company_id: string | null
  user_id: string | null
  entity_type: string
  entity_id: string | null
  action: string
  details: JsonNull
  created_at: Generated<Date>
}

export interface DB {
  companies: CompaniesTable
  users: UsersTable
  memberships: MembershipsTable
  sessions: SessionsTable
  password_resets: PasswordResetsTable
  invitations: InvitationsTable
  ingredients: IngredientsTable
  ingredient_prices: IngredientPricesTable
  utility_tariffs: UtilityTariffsTable
  tariff_versions: TariffVersionsTable
  equipment: EquipmentTable
  employees: EmployeesTable
  employee_cost_configs: EmployeeCostConfigsTable
  recipes: RecipesTable
  recipe_revisions: RecipeRevisionsTable
  recipe_phases: RecipePhasesTable
  recipe_components: RecipeComponentsTable
  recipe_equipment_uses: RecipeEquipmentUsesTable
  recipe_labor: RecipeLaborTable
  cost_snapshots: CostSnapshotsTable
  recipe_cost_cache: RecipeCostCacheTable
  imports: ImportsTable
  import_rows: ImportRowsTable
  jobs: JobsTable
  audit_logs: AuditLogsTable
}
