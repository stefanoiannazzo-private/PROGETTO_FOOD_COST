export const KIND_LABEL = { electricity: 'Elettricità', gas: 'Gas', water: 'Acqua' } as const

export const POWER_LABEL: Record<string, string> = { electric: 'Elettrica', gas: 'Gas', mixed: 'Mista', manual: 'Manuale' }

export const SEGMENT_LABEL: Record<string, string> = { preheat: 'Preriscaldamento', work: 'Lavorazione', hold: 'Mantenimento' }
