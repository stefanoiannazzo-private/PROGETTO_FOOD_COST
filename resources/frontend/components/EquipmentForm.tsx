'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { euro, unitLabel } from '@/lib/num'
import { Field, NumberInput } from './ui'

export interface EquipmentValue {
  code: string
  name: string
  category: string
  description: string
  powerType: 'electric' | 'gas' | 'mixed' | 'manual'
  status: 'active' | 'maintenance' | 'inactive'
  capacity: string
  electricPowerKw: string | null
  usageCoefficient: string | null
  preheatCoefficient: string | null
  holdCoefficient: string | null
  electricTariffId: string | null
  gasMode: 'flow' | 'energy'
  gasFlowPerHour: string | null
  gasFlowUnit: 'm3' | 'smc'
  gasPowerKw: string | null
  gasLoadFactor: string | null
  gasTariffId: string | null
}

export const emptyEquipment = (): EquipmentValue => ({
  code: '',
  name: '',
  category: '',
  description: '',
  powerType: 'electric',
  status: 'active',
  capacity: '',
  electricPowerKw: null,
  usageCoefficient: null,
  preheatCoefficient: null,
  holdCoefficient: null,
  electricTariffId: null,
  gasMode: 'flow',
  gasFlowPerHour: null,
  gasFlowUnit: 'm3',
  gasPowerKw: null,
  gasLoadFactor: null,
  gasTariffId: null,
})

interface TariffOpt {
  id: string
  name: string
  kind: string
  unit: string
  current: { pricePerUnit: string } | null
}

export function EquipmentFields({ v, set, errors }: { v: EquipmentValue; set: (p: Partial<EquipmentValue>) => void; errors: Record<string, string> }) {
  const tariffs = useQuery({ queryKey: ['tariffs', '0'], queryFn: () => api.get<{ data: TariffOpt[] }>('/tariffs', { archived: '0' }), staleTime: 60_000 })
  const electric = v.powerType === 'electric' || v.powerType === 'mixed'
  const gas = v.powerType === 'gas' || v.powerType === 'mixed'
  const opt = (kind: string) =>
    tariffs.data?.data
      .filter((t) => t.kind === kind)
      .map((t) => (
        <option key={t.id} value={t.id}>
          {t.name} — {t.current ? `${euro(t.current.pricePerUnit, 4)}/${unitLabel(t.unit)}` : 'senza valore'}
        </option>
      ))
  return (
    <div className="stack">
      <div className="grid-2">
        <Field label="Nome" htmlFor="eq-name" required error={errors.name}>
          <input id="eq-name" className="input" value={v.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Codice" htmlFor="eq-code" hint="Vuoto = generato" error={errors.code}>
          <input id="eq-code" className="input mono" value={v.code} onChange={(e) => set({ code: e.target.value })} />
        </Field>
        <Field label="Categoria" htmlFor="eq-cat" hint="forno, piastra, planetaria…">
          <input id="eq-cat" className="input" value={v.category} onChange={(e) => set({ category: e.target.value })} />
        </Field>
        <Field label="Capacità" htmlFor="eq-cap" hint="es. 10 teglie GN 1/1">
          <input id="eq-cap" className="input" value={v.capacity} onChange={(e) => set({ capacity: e.target.value })} />
        </Field>
        <Field label="Alimentazione" htmlFor="eq-pt">
          <select id="eq-pt" className="input" value={v.powerType} onChange={(e) => set({ powerType: e.target.value as EquipmentValue['powerType'] })}>
            <option value="electric">Elettrica</option>
            <option value="gas">Gas</option>
            <option value="mixed">Mista (elettrica e gas)</option>
            <option value="manual">Manuale (nessun consumo)</option>
          </select>
        </Field>
        <Field label="Stato" htmlFor="eq-st">
          <select id="eq-st" className="input" value={v.status} onChange={(e) => set({ status: e.target.value as EquipmentValue['status'] })}>
            <option value="active">Attivo</option>
            <option value="maintenance">In manutenzione</option>
            <option value="inactive">Non attivo</option>
          </select>
        </Field>
      </div>
      {electric ? (
        <>
          <div className="section-title">Parametri elettrici</div>
          <div className="alert info small">
            Consumo stimato = kW × minuti ÷ 60 × coefficiente di utilizzo. Il coefficiente è una stima modificabile (quota media di potenza effettivamente assorbita), non una misura: in ricetta puoi sempre inserire un consumo misurato.
          </div>
          <div className="grid-2">
            <Field label="Potenza nominale" htmlFor="eq-kw" error={errors.electricPowerKw} hint="Dalla targhetta del macchinario">
              <NumberInput id="eq-kw" value={v.electricPowerKw} onChange={(x) => set({ electricPowerKw: x })} suffix="kW" />
            </Field>
            <Field label="Coefficiente medio di utilizzo" htmlFor="eq-cu" error={errors.usageCoefficient} hint="Tra 0 e 1 (es. 0,6)">
              <NumberInput id="eq-cu" value={v.usageCoefficient} onChange={(x) => set({ usageCoefficient: x })} />
            </Field>
            <Field label="Coefficiente in preriscaldamento" htmlFor="eq-cp" error={errors.preheatCoefficient} hint="Facoltativo; altrimenti si usa quello medio">
              <NumberInput id="eq-cp" value={v.preheatCoefficient} onChange={(x) => set({ preheatCoefficient: x })} />
            </Field>
            <Field label="Coefficiente in mantenimento" htmlFor="eq-ch" error={errors.holdCoefficient} hint="Facoltativo">
              <NumberInput id="eq-ch" value={v.holdCoefficient} onChange={(x) => set({ holdCoefficient: x })} />
            </Field>
            <Field label="Tariffa elettrica" htmlFor="eq-et" error={errors.electricTariffId}>
              <select id="eq-et" className="input" value={v.electricTariffId ?? ''} onChange={(e) => set({ electricTariffId: e.target.value || null })}>
                <option value="">— nessuna —</option>
                {opt('electricity')}
              </select>
            </Field>
          </div>
        </>
      ) : null}
      {gas ? (
        <>
          <div className="section-title">Parametri gas</div>
          <div className="grid-2">
            <Field label="Modalità" htmlFor="eq-gm">
              <select id="eq-gm" className="input" value={v.gasMode} onChange={(e) => set({ gasMode: e.target.value as 'flow' | 'energy' })}>
                <option value="flow">Portata oraria (m³/h o Smc/h)</option>
                <option value="energy">Potenza termica (consumo in kWh)</option>
              </select>
            </Field>
            {v.gasMode === 'flow' ? (
              <Field label="Portata oraria" htmlFor="eq-gf" error={errors.gasFlowPerHour}>
                <NumberInput
                  id="eq-gf"
                  value={v.gasFlowPerHour}
                  onChange={(x) => set({ gasFlowPerHour: x })}
                  suffix={
                    <select className="addon" value={v.gasFlowUnit} onChange={(e) => set({ gasFlowUnit: e.target.value as 'm3' | 'smc' })} aria-label="Unità portata">
                      <option value="m3">m³/h</option>
                      <option value="smc">Smc/h</option>
                    </select>
                  }
                />
              </Field>
            ) : (
              <Field label="Potenza gas" htmlFor="eq-gk" error={errors.gasPowerKw}>
                <NumberInput id="eq-gk" value={v.gasPowerKw} onChange={(x) => set({ gasPowerKw: x })} suffix="kW" />
              </Field>
            )}
            <Field label="Fattore di carico" htmlFor="eq-gl" error={errors.gasLoadFactor} hint="Facoltativo, tra 0 e 1; applicato una sola volta">
              <NumberInput id="eq-gl" value={v.gasLoadFactor} onChange={(x) => set({ gasLoadFactor: x })} />
            </Field>
            <Field label="Tariffa gas" htmlFor="eq-gt" error={errors.gasTariffId}>
              <select id="eq-gt" className="input" value={v.gasTariffId ?? ''} onChange={(e) => set({ gasTariffId: e.target.value || null })}>
                <option value="">— nessuna —</option>
                {opt('gas')}
              </select>
            </Field>
          </div>
        </>
      ) : null}
      {v.powerType === 'manual' ? <div className="alert info small">Strumento manuale: il costo energetico è esplicitamente zero.</div> : null}
      <Field label="Descrizione" htmlFor="eq-desc">
        <textarea id="eq-desc" className="input" rows={2} value={v.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
    </div>
  )
}

export function equipmentPayload(v: EquipmentValue) {
  return {
    ...v,
    code: v.code || null,
    category: v.category || null,
    description: v.description || null,
    capacity: v.capacity || null,
  }
}
