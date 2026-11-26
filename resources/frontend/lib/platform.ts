/** NUOVO: tipi della console del superadmin (piattaforma SaaS). */
export interface Stats {
  count: number
  min: string | null
  max: string | null
  avg: string | null
  median: string | null
  spreadPercent: string | null
}

export interface CostSummaryLite {
  complete: boolean
  total: string
  costPerKg: string | null
  costPerPortion: string | null
  errors: number
}

export interface PlatformRecipe {
  id: string
  code: string
  title: string
  category: string | null
  status: string
  companyId: string
  company: string
  portions: string | null
  finalWeightKg: string | null
  updatedAt: string
  cost: CostSummaryLite | null
}

export interface Company {
  id: string
  name: string
  createdAt: string
  archived: boolean
  recipes: number
  ingredients: number
  users: number
  admins: Array<{ name: string; email: string }>
  pendingAdminInvitations: Array<{ id: string; email: string; expired: boolean }>
  /** NUOVO: promotore che ha presentato l'azienda (codice promo) */
  promoter: { id: string; name: string | null; code: string | null } | null
}
