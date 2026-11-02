export const ROLES = ['admin', 'manager', 'operator'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = { admin: 'Amministratore', manager: 'Responsabile', operator: 'Operatore' }

export const PERMISSIONS = {
  'recipes.read': 'Consultare ricette e schede di preparazione',
  'recipes.manage': 'Creare e modificare ricette',
  'costs.read': 'Consultare i costi (prezzi, costi aggregati e valorizzazioni)',
  'snapshots.create': 'Salvare snapshot di costo',
  'ingredients.manage': 'Gestire ingredienti e prezzi',
  'equipment.manage': 'Gestire strumenti e macchinari',
  'tariffs.read': 'Consultare le tariffe delle utenze',
  'tariffs.manage': 'Modificare le tariffe delle utenze',
  'employees.read': 'Consultare l’elenco dei dipendenti (senza retribuzioni)',
  'employees.manage': 'Gestire i dipendenti',
  'salaries.read': 'Leggere le retribuzioni e i costi orari nominativi',
  'imports.manage': 'Eseguire importazioni massive',
  'users.manage': 'Gestire utenti, ruoli e inviti',
} as const
export type Permission = keyof typeof PERMISSIONS

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[]

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL_PERMISSIONS,
  manager: ['recipes.read', 'recipes.manage', 'costs.read', 'snapshots.create', 'ingredients.manage', 'equipment.manage', 'tariffs.read', 'employees.read'],
  operator: ['recipes.read'],
}

/** Permessi concedibili oltre al ruolo. */
export const GRANTABLE: Permission[] = ['costs.read', 'salaries.read', 'tariffs.read', 'tariffs.manage', 'employees.read', 'employees.manage', 'imports.manage', 'ingredients.manage', 'snapshots.create']

export function effectivePermissions(role: Role, extra: string[]): Set<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role])
  for (const p of extra) if ((GRANTABLE as string[]).includes(p)) set.add(p as Permission)
  // la lettura dei costi è implicita in chi può salvare snapshot o leggere retribuzioni
  if (set.has('salaries.read') || set.has('snapshots.create')) set.add('costs.read')
  if (set.has('employees.manage')) set.add('employees.read')
  if (set.has('tariffs.manage')) set.add('tariffs.read')
  return set
}
