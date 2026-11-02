'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { euro, todayIso } from '@/lib/num'
import { Field, NumberInput } from './ui'

export interface CostValue {
  validFrom: string
  grossMonthly: string | null
  contributionsMode: 'none' | 'amount' | 'percent'
  contributionsValue: string | null
  otherMonthlyCosts: string | null
  productiveHours: string | null
  notes: string
}
export const emptyCost = (): CostValue => ({ validFrom: todayIso(), grossMonthly: null, contributionsMode: 'none', contributionsValue: null, otherMonthlyCosts: null, productiveHours: null, notes: '' })

export function costPayload(c: CostValue) {
  return {
    validFrom: c.validFrom,
    grossMonthly: c.grossMonthly ?? '',
    contributionsMode: c.contributionsMode,
    contributionsValue: c.contributionsMode === 'none' ? null : c.contributionsValue,
    otherMonthlyCosts: c.otherMonthlyCosts,
    productiveHours: c.productiveHours ?? '',
    notes: c.notes || null,
  }
}

interface Rates {
  grossHourly: string
  companyMonthly: string
  companyHourly: string
  costPerMinute: string
  basis: 'company_cost' | 'gross_only'
}

/** Configurazione del costo del lavoro con anteprima dei costi orari calcolata dal backend. */
export function EmployeeCostFields({ v, set, errors }: { v: CostValue; set: (p: Partial<CostValue>) => void; errors: Record<string, string> }) {
  const [rates, setRates] = useState<Rates | null>(null)
  useEffect(() => {
    if (!v.grossMonthly || !v.productiveHours) return setRates(null)
    const t = setTimeout(() => {
      api
        .post<Rates>('/employees/cost-preview', costPayload(v))
        .then(setRates)
        .catch(() => setRates(null))
    }, 250)
    return () => clearTimeout(t)
  }, [v])
  return (
    <div className="stack">
      <div className="grid-3">
        <Field label="Decorrenza" htmlFor="c-vf" required error={errors.validFrom}>
          <input id="c-vf" type="date" className="input" value={v.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
        </Field>
        <Field label="Lordo mensile" htmlFor="c-gross" required error={errors.grossMonthly}>
          <NumberInput id="c-gross" value={v.grossMonthly} onChange={(x) => set({ grossMonthly: x })} suffix="€" />
        </Field>
        <Field label="Ore mensili produttive" htmlFor="c-hours" required error={errors.productiveHours} hint="Divisore: ore effettivamente lavorate in produzione">
          <NumberInput id="c-hours" value={v.productiveHours} onChange={(x) => set({ productiveHours: x })} suffix="h" />
        </Field>
      </div>
      <div className="grid-3">
        <Field label="Oneri aziendali" htmlFor="c-mode" hint="Una sola modalità, per evitare doppie imputazioni">
          <select id="c-mode" className="input" value={v.contributionsMode} onChange={(e) => set({ contributionsMode: e.target.value as CostValue['contributionsMode'], contributionsValue: null })}>
            <option value="none">Non inseriti</option>
            <option value="amount">Importo mensile</option>
            <option value="percent">Percentuale sul lordo</option>
          </select>
        </Field>
        {v.contributionsMode !== 'none' ? (
          <Field label={v.contributionsMode === 'amount' ? 'Importo oneri mensili' : 'Percentuale oneri'} htmlFor="c-cv" required error={errors.contributionsValue}>
            <NumberInput id="c-cv" value={v.contributionsValue} onChange={(x) => set({ contributionsValue: x })} suffix={v.contributionsMode === 'amount' ? '€' : '% del lordo'} />
          </Field>
        ) : (
          <div />
        )}
        <Field label="Altri costi mensili imputabili" htmlFor="c-other" error={errors.otherMonthlyCosts} hint="es. buoni pasto, divise">
          <NumberInput id="c-other" value={v.otherMonthlyCosts} onChange={(x) => set({ otherMonthlyCosts: x })} suffix="€" />
        </Field>
      </div>
      {rates ? (
        <div className={`alert ${rates.basis === 'gross_only' ? 'warn' : 'info'}`}>
          <div>
            Costo orario sul solo lordo <strong>{euro(rates.grossHourly, 4)}</strong> · costo aziendale mensile <strong>{euro(rates.companyMonthly)}</strong> · costo orario aziendale <strong>{euro(rates.companyHourly, 4)}</strong> · al minuto{' '}
            <strong>{euro(rates.costPerMinute, 4)}</strong>
            {rates.basis === 'gross_only' ? <div className="small">Stima sul solo lordo: non comprende oneri e altri costi non inseriti.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
