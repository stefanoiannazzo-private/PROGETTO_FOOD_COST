export const KIND_LABEL = { electricity: 'Elettricità', gas: 'Gas', water: 'Acqua' } as const

export const POWER_LABEL: Record<string, string> = { electric: 'Elettrica', gas: 'Gas', mixed: 'Mista', manual: 'Manuale' }

export const SEGMENT_LABEL: Record<string, string> = { preheat: 'Preriscaldamento', work: 'Lavorazione', hold: 'Mantenimento' }

export const IMPORT_STATUS: Record<string, [string, string]> = {
  uploaded: ['Caricato', ''],
  validating: ['In validazione', 'info'],
  validated: ['Da confermare', 'warn'],
  applying: ['In applicazione', 'info'],
  applied: ['Applicato', 'ok'],
  failed: ['Non riuscito', 'err'],
  cancelled: ['Annullato', ''],
}
