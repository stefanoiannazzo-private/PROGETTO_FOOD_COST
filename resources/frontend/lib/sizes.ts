/**
 * NUOVO — formato della confezione letto dal nome (stessa logica del server, App\Support\PackSize):
 * solo quando l'unità è scritta, es. «tanica3L» → 3 l, «vasc.1,5k» → 1,5 kg, «6x1lt» → 6 l.
 */
const UNITS: Record<string, string> = { kg: 'kg', k: 'kg', g: 'g', gr: 'g', grammi: 'g', l: 'l', lt: 'l', litri: 'l', ml: 'ml', cl: 'cl' }
const fmt = (v: number) => String(Math.round(v * 1000) / 1000)
const n = (x: string) => Number(x.replace(',', '.'))

export function sizeFromName(name: string): { qty: string; unit: string } | null {
  const s = name.toLowerCase()
  const num = '(\\d+(?:[.,]\\d+)?)'
  const unit = '(kg|k|grammi|gr|g|litri|lt|l|ml|cl)(?![a-z])'
  const mult = new RegExp(`${num}\\s*x\\s*${num}\\s*${unit}`).exec(s)
  if (mult) return { qty: fmt(n(mult[1]!) * n(mult[2]!)), unit: UNITS[mult[3]!]! }
  const re = new RegExp(`(?:^|[^a-z0-9]|(?<=[a-z.]))${num}\\s*${unit}`, 'g')
  let last: RegExpExecArray | null = null
  for (let m = re.exec(s); m; m = re.exec(s)) last = m
  if (last && n(last[1]!) > 0) return { qty: fmt(n(last[1]!)), unit: UNITS[last[2]!]! }
  return null
}
