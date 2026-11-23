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

/**
 * NUOVO — valori tipici dei coefficienti, mostrati come esempi e usati quando il ristoratore lascia i campi vuoti.
 * Forno: consumo a vuoto misurato nelle prove ufficiali (DIN 18873 / ENERGY STAR) ≈ 5% della potenza; gli altri sono stime prudenti.
 */
type ElectricPreset = { key: string; label: string; usage: string; preheat: string; hold: string; match: RegExp }
export const ELECTRIC_PRESETS: ElectricPreset[] = [
  { key: 'forno', label: 'Forno elettrico / combi (es. 6 o 10 teglie)', usage: '0.5', preheat: '1', hold: '0.05', match: /forn|combi|convez|vapore/i },
  { key: 'frytop', label: 'Fry top / piastra elettrica', usage: '0.6', preheat: '1', hold: '0.25', match: /fry|piastr|grigli|grill|bistecch/i },
  { key: 'friggitrice', label: 'Friggitrice elettrica', usage: '0.5', preheat: '1', hold: '0.1', match: /friggi/i },
  { key: 'induzione', label: 'Piano a induzione / piastre elettriche', usage: '0.6', preheat: '1', hold: '0.2', match: /induz|fornell|piano cottura|cucina elettr/i },
  { key: 'motore', label: 'Impastatrice, planetaria, affettatrice', usage: '0.8', preheat: '0.8', hold: '0.8', match: /impast|planetar|affett|cutter|frull|tritacarne|sottovuoto/i },
]
const ELECTRIC_GENERIC = { label: 'valori medi', usage: '0.5', preheat: '1', hold: '0.1' }
type GasPreset = { key: string; label: string; load: string; match: RegExp }
export const GAS_PRESETS: GasPreset[] = [
  { key: 'fuochi', label: 'Fuochi a gas (fornelli)', load: '0.5', match: /fuoch|fornell|bruciat|piano cottura|cucina/i },
  { key: 'frytop', label: 'Fry top / piastra a gas', load: '0.6', match: /fry|piastr|grigli/i },
  { key: 'forno', label: 'Forno a gas / combi a gas', load: '0.5', match: /forn|combi/i },
  { key: 'friggitrice', label: 'Friggitrice a gas', load: '0.5', match: /friggi/i },
]
const GAS_GENERIC = { label: 'valore medio', load: '0.5' }
const num = (x: string) => x.replace('.', ',')

/** Compila i coefficienti lasciati vuoti con i valori tipici del macchinario (riconosciuto da nome e categoria). */
export function applyDefaultCoefficients(v: EquipmentValue): { v: EquipmentValue; note: string | null } {
  const text = `${v.name} ${v.category}`
  const electric = v.powerType === 'electric' || v.powerType === 'mixed'
  const gas = v.powerType === 'gas' || v.powerType === 'mixed'
  const out = { ...v }
  const notes: string[] = []
  if (electric && (!v.usageCoefficient || !v.preheatCoefficient || !v.holdCoefficient)) {
    const p = ELECTRIC_PRESETS.find((x) => x.match.test(text)) ?? ELECTRIC_GENERIC
    if (!out.usageCoefficient) out.usageCoefficient = p.usage
    if (!out.preheatCoefficient) out.preheatCoefficient = p.preheat
    if (!out.holdCoefficient) out.holdCoefficient = p.hold
    notes.push(`coefficienti elettrici con i ${'key' in p ? `valori tipici di «${p.label}»` : 'valori medi'}`)
  }
  if (gas && !v.gasLoadFactor) {
    const p = GAS_PRESETS.find((x) => x.match.test(text)) ?? GAS_GENERIC
    out.gasLoadFactor = p.load
    notes.push(`fattore di carico ${num(p.load)} (${'key' in p ? p.label : 'valore medio'})`)
  }
  return { v: out, note: notes.length ? `Compilati in automatico: ${notes.join('; ')}. Puoi modificarli quando vuoi.` : null }
}

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
            <Field label="Coefficiente medio di utilizzo" htmlFor="eq-cu" error={errors.usageCoefficient} hint="Mentre cuoce: per quanta parte del tempo scalda davvero. Facoltativo">
              <NumberInput id="eq-cu" value={v.usageCoefficient} onChange={(x) => set({ usageCoefficient: x })} />
            </Field>
            <Field label="Coefficiente in preriscaldamento" htmlFor="eq-cp" error={errors.preheatCoefficient} hint="Mentre sale in temperatura (di solito 1). Facoltativo">
              <NumberInput id="eq-cp" value={v.preheatCoefficient} onChange={(x) => set({ preheatCoefficient: x })} />
            </Field>
            <Field label="Coefficiente in mantenimento" htmlFor="eq-ch" error={errors.holdCoefficient} hint="Caldo, vuoto, in attesa. Facoltativo">
              <NumberInput id="eq-ch" value={v.holdCoefficient} onChange={(x) => set({ holdCoefficient: x })} />
            </Field>
            <Field label="Tariffa elettrica" htmlFor="eq-et" error={errors.electricTariffId}>
              <select id="eq-et" className="input" value={v.electricTariffId ?? ''} onChange={(e) => set({ electricTariffId: e.target.value || null })}>
                <option value="">— nessuna —</option>
                {opt('electricity')}
              </select>
            </Field>
          </div>
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <div className="card-pad small stack tight">
              <div>
                <strong>Non sai cosa mettere?</strong> Lascia vuoti i coefficienti: al salvataggio li compiliamo con i valori tipici del macchinario, riconosciuto dal nome o dalla categoria. Oppure scegli qui sotto.
              </div>
              <table className="table compact" style={{ background: 'transparent' }}>
                <thead>
                  <tr>
                    <th>Esempio</th>
                    <th className="num">Medio</th>
                    <th className="num">Preriscaldamento</th>
                    <th className="num">Mantenimento</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ELECTRIC_PRESETS.map((p) => (
                    <tr key={p.key}>
                      <td>{p.label}</td>
                      <td className="num">{num(p.usage)}</td>
                      <td className="num">{num(p.preheat)}</td>
                      <td className="num">{num(p.hold)}</td>
                      <td className="num">
                        <button type="button" className="btn sm" onClick={() => set({ usageCoefficient: p.usage, preheatCoefficient: p.preheat, holdCoefficient: p.hold })}>
                          Usa
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="faint">
                Esempio: forno da 10 kW, 30 minuti di cottura con coefficiente 0,5 → 10 × 0,5 h × 0,5 = 2,5 kWh. Per i forni il consumo a vuoto (mantenimento) è misurato nelle prove ufficiali intorno al 5% della potenza; gli altri valori sono stime: se misuri i consumi reali puoi correggerli.
              </div>
            </div>
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
            <Field label="Fattore di carico" htmlFor="eq-gl" error={errors.gasLoadFactor} hint="A che percentuale della fiamma massima lavora in media (0,5 = metà). Facoltativo">
              <NumberInput id="eq-gl" value={v.gasLoadFactor} onChange={(x) => set({ gasLoadFactor: x })} />
            </Field>
            <Field label="Tariffa gas" htmlFor="eq-gt" error={errors.gasTariffId}>
              <select id="eq-gt" className="input" value={v.gasTariffId ?? ''} onChange={(e) => set({ gasTariffId: e.target.value || null })}>
                <option value="">— nessuna —</option>
                {opt('gas')}
              </select>
            </Field>
          </div>
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <div className="card-pad small stack tight">
              <div>
                <strong>Non sai cosa mettere?</strong> Lascia vuoto il fattore di carico: al salvataggio usiamo il valore tipico del macchinario. Esempi:
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {GAS_PRESETS.map((p) => (
                  <button key={p.key} type="button" className="btn sm" onClick={() => set({ gasLoadFactor: p.load })} title="Usa questo valore">
                    {p.label}: {num(p.load)}
                  </button>
                ))}
              </div>
              <div className="faint">I fuochi raramente restano al massimo: in media lavorano a circa metà fiamma. Sono stime, modificabili.</div>
            </div>
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
