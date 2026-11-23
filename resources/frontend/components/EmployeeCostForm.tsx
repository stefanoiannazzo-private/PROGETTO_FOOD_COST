'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { euro, todayIso } from '@/lib/num'
import { Field, NumberInput } from './ui'

export interface CostValue {
  validFrom: string
  /** costo mensile del dipendente, tutto compreso (lordo, contributi, TFR: la cifra del consulente) */
  grossMonthly: string | null
  /** NUOVO: voce extra mensile (facoltativa) e su quante mensilità si paga */
  extraMonthly: string | null
  extraMonths: number
  /** NUOVO: mensilità pagate nell'anno (12 = tredicesima spalmata o assente) */
  monthsPaid: number
  otherMonthlyCosts: string | null
  productiveHours: string | null
  notes: string
}
export const emptyCost = (): CostValue => ({ validFrom: todayIso(), grossMonthly: null, extraMonthly: null, extraMonths: 12, monthsPaid: 12, otherMonthlyCosts: null, productiveHours: null, notes: '' })

export function costPayload(c: CostValue) {
  const hasExtra = !!c.extraMonthly && Number(c.extraMonthly) > 0
  return {
    validFrom: c.validFrom,
    grossMonthly: c.grossMonthly ?? '',
    extraMonthly: hasExtra ? c.extraMonthly : null,
    monthsPaid: c.monthsPaid,
    extraMonths: hasExtra ? Math.min(c.extraMonths, c.monthsPaid) : null,
    // un solo importo tutto compreso: contributi e TFR non si inseriscono a parte
    contributionsMode: 'none' as const,
    contributionsValue: null,
    otherMonthlyCosts: c.otherMonthlyCosts,
    productiveHours: c.productiveHours ?? '',
    notes: c.notes || null,
  }
}

interface Rates {
  companyMonthly: string
  annualCost: string
  companyHourly: string
  costPerMinute: string
}

const MONTHS = [12, 13, 14, 15, 16]

/**
 * Costo del lavoro (NUOVO, semplificato): un solo importo mensile tutto compreso, le mensilità pagate,
 * l'eventuale voce extra con le sue mensilità e gli altri costi. Costo orario = costo annuo ÷ 12 ÷ ore produttive.
 */
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
  const hasExtra = !!v.extraMonthly && Number(v.extraMonthly) > 0
  return (
    <div className="stack">
      <div className="alert info small">
        <div>
          Inserisci <strong>quanto ti costa il dipendente ogni mese, tutto compreso</strong>: lordo, contributi e TFR (è la cifra del prospetto del consulente). Indica poi quante mensilità paghi in un anno: il costo orario
          lo calcoliamo sull’anno diviso 12 mesi.
        </div>
      </div>
      <div className="grid-3">
        <Field label="Decorrenza" htmlFor="c-vf" required error={errors.validFrom}>
          <input id="c-vf" type="date" className="input" value={v.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
        </Field>
        <Field label="Costo mensile del dipendente" htmlFor="c-gross" required error={errors.grossMonthly} hint="Tutto compreso: lordo + contributi + TFR">
          <NumberInput id="c-gross" value={v.grossMonthly} onChange={(x) => set({ grossMonthly: x })} suffix="€" />
        </Field>
        <Field label="Mensilità pagate in un anno" htmlFor="c-months" error={errors.monthsPaid} hint="12 se la tredicesima è già spalmata nei 12 mesi">
          <select
            id="c-months"
            className="input"
            value={v.monthsPaid}
            onChange={(e) => {
              const m = Number(e.target.value)
              // la voce extra segue le mensilità, salvo scelta diversa già fatta
              set({ monthsPaid: m, extraMonths: v.extraMonths === v.monthsPaid || v.extraMonths > m ? m : v.extraMonths })
            }}
          >
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {m}{m === 12 ? ' mensilità' : m === 13 ? ' (con 13ª)' : m === 14 ? ' (con 13ª e 14ª)' : ' mensilità'}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid-3">
        <Field label="Voce extra mensile" htmlFor="c-extra" error={errors.extraMonthly} hint="Facoltativa: superminimo, indennità, premio…">
          <NumberInput id="c-extra" value={v.extraMonthly} onChange={(x) => set({ extraMonthly: x })} suffix="€" />
        </Field>
        <Field label="Per quante mensilità?" htmlFor="c-extra-months" error={errors.extraMonths} hint={hasExtra ? 'Su quante mensilità paghi la voce extra' : 'Prima indica la voce extra'}>
          <select id="c-extra-months" className="input" value={Math.min(v.extraMonths, v.monthsPaid)} disabled={!hasExtra} onChange={(e) => set({ extraMonths: Number(e.target.value) })}>
            {Array.from({ length: v.monthsPaid }, (_, i) => i + 1)
              .reverse()
              .map((m) => (
                <option key={m} value={m}>
                  {m === v.monthsPaid ? `Tutte (${m})` : `${m} mensilità`}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Altri costi mensili" htmlFor="c-other" error={errors.otherMonthlyCosts} hint="Facoltativi: quota del commercialista per il cedolino, buoni pasto, divise">
          <NumberInput id="c-other" value={v.otherMonthlyCosts} onChange={(x) => set({ otherMonthlyCosts: x })} suffix="€" />
        </Field>
      </div>
      <div className="grid-3">
        <Field label="Ore mensili produttive" htmlFor="c-hours" required error={errors.productiveHours} hint="Ore effettivamente lavorate in produzione in un mese">
          <NumberInput id="c-hours" value={v.productiveHours} onChange={(x) => set({ productiveHours: x })} suffix="h" />
        </Field>
      </div>
      {rates ? (
        <div className="alert info">
          <div>
            Costo annuo <strong>{euro(rates.annualCost)}</strong> · al mese (media su 12) <strong>{euro(rates.companyMonthly)}</strong> · all’ora <strong>{euro(rates.companyHourly, 4)}</strong> · al minuto{' '}
            <strong>{euro(rates.costPerMinute, 4)}</strong>
          </div>
        </div>
      ) : null}
    </div>
  )
}
