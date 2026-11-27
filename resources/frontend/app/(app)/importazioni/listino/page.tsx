'use client'

/**
 * NUOVO — importazione del listino dei fornitori (data, nome, prezzo, iva, U.M., sconti, fornitore).
 * Il server propone per ogni prodotto come si paga (KG → al kg, formato dal nome), il prezzo netto con gli sconti
 * applicati, la categoria e il «non alimentare»; qui si controlla, si corregge e si conferma.
 */
import Link from 'next/link'
import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, type AffectedRecipe } from '@/lib/api'
import { date, euro, euroPer } from '@/lib/num'
import { useCan } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { AffectedNotice, errorMessage, Icon, useToast } from '@/components/ui'

interface PricePoint {
  date: string
  gross: string
  discount: string
  net: string
}
interface Product {
  key: string
  existingId: string | null
  code: string | null
  name: string
  supplier: string
  um: string
  mode: 'kg' | 'l' | 'conf'
  content: string
  unit: string
  purchaseUnit: string
  pieceKg: string | null
  density: string | null
  check: string | null
  note: string | null
  category: string
  nonFood: boolean
  before: { purchaseUnit: string; content: string; unit: string } | null
  prices: PricePoint[]
  include?: boolean
}
interface Preview {
  summary: { rows: number; skipped: number; products: number; new: number; update: number; check: number; discounted: number; prices: number; byMode: { kg: number; l: number; conf: number } }
  suppliers: Array<{ name: string; variants: string[]; rows: number }>
  products: Product[]
}
type Filter = 'check' | 'new' | 'update' | 'all'
const TO_BASE: Record<string, number> = { g: 0.001, kg: 1, ml: 0.001, cl: 0.01, l: 1, pz: 1 }
const UNITS = ['kg', 'g', 'l', 'cl', 'ml', 'pz']
const PAGE = 50

function normalized(p: Product): string {
  const net = Number(p.prices[0]?.net ?? 0)
  if (p.mode === 'kg') return euroPer(String(net), 'kg', 2)
  if (p.mode === 'l') return euroPer(String(net), 'l', 2)
  const base = Number(p.content) * (TO_BASE[p.unit] ?? 1)
  if (!(base > 0)) return '—'
  const u = ['g', 'kg'].includes(p.unit) ? 'kg' : ['ml', 'cl', 'l'].includes(p.unit) ? 'l' : 'pz'
  return euroPer(String(net / base), u, 4)
}

const qn = (x: string) => String(Number(x)).replace('.', ',')

export default function PriceListPage() {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState<Preview | null>(null)
  const [items, setItems] = useState<Product[]>([])
  const [filter, setFilter] = useState<Filter>('check')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [done, setDone] = useState<null | { created: number; updated: number; prices: number; pricesUpdated: number; affectedRecipes: AffectedRecipe[] }>(null)
  const allowed = can('imports.manage') && can('ingredients.manage') && can('costs.read')

  const load = async (file: File) => {
    setBusy(true)
    setError('')
    setDone(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await api.upload<Preview>('/imports/pricelist/preview', fd)
      setData(r)
      setItems(r.products.map((p) => ({ ...p, include: true })))
      setFilter(r.summary.check ? 'check' : 'all')
      setPage(1)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const set = (key: string, patch: Partial<Product>) => setItems((xs) => xs.map((p) => (p.key === key ? { ...p, ...patch, check: patch.check !== undefined ? patch.check : p.check } : p)))
  const categories = useMemo(() => [...new Set(items.map((p) => p.category))].sort((a, b) => a.localeCompare(b)), [items])
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase()
    return items.filter(
      (p) =>
        (filter === 'all' || (filter === 'check' && p.check) || (filter === 'new' && !p.existingId) || (filter === 'update' && p.existingId)) &&
        (!s || p.name.toLowerCase().includes(s) || p.supplier.toLowerCase().includes(s) || p.category.toLowerCase().includes(s)),
    )
  }, [items, filter, search])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const slice = shown.slice((page - 1) * PAGE, page * PAGE)
  const included = items.filter((p) => p.include)
  const checks = items.filter((p) => p.check).length

  const apply = async () => {
    setBusy(true)
    setError('')
    try {
      const products = included.map((p) => ({
        existingId: p.existingId,
        code: p.code,
        name: p.name,
        supplier: p.supplier || null,
        category: p.category.trim() || 'Altro',
        nonFood: p.nonFood,
        mode: p.mode,
        content: p.mode === 'conf' ? String(p.content).replace(',', '.') : '1',
        unit: p.mode === 'kg' ? 'kg' : p.mode === 'l' ? 'l' : p.unit,
        purchaseUnit: p.purchaseUnit || null,
        pieceKg: p.pieceKg,
        density: p.density,
        prices: p.prices.map((x) => ({ date: x.date, net: x.net, gross: x.gross, discount: x.discount || null })),
      }))
      const r = await api.post<NonNullable<typeof done>>('/imports/pricelist/apply', { products })
      setDone(r)
      setData(null)
      setItems([])
      await qc.invalidateQueries({ queryKey: ['ingredients'] })
      await qc.invalidateQueries({ queryKey: ['recipes'] })
      toast('Listino importato.')
    } catch (e) {
      setError(errorMessage(e))
      toast(errorMessage(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  if (!allowed) {
    return (
      <>
        <PageHead title="Listino dei fornitori" />
        <div className="alert err">Per importare un listino servono la gestione dei prodotti e la lettura dei costi.</div>
      </>
    )
  }

  return (
    <>
      <PageHead
        title="Listino dei fornitori"
        sub="Il file con data, nome, prezzo, IVA, unità di misura, sconti e fornitore (es. l'esportazione «Listino Momy»). Nulla viene scritto prima della tua conferma."
        actions={
          <Link className="btn" href="/importazioni">
            ‹ Importazioni
          </Link>
        }
      />
      <div className="stack loose">
        {done ? (
          <div className="card">
            <div className="card-body stack">
              <div className="alert ok">
                <Icon name="check" />
                <div>
                  <strong>Listino importato.</strong> {done.created} prodotti nuovi, {done.updated} aggiornati; {done.prices} prezzi aggiunti e {done.pricesUpdated} sostituiti con il prezzo netto.
                </div>
              </div>
              <AffectedNotice recipes={done.affectedRecipes} />
              <div className="row">
                <Link className="btn primary" href="/ingredienti">
                  Vai ai prodotti
                </Link>
              </div>
            </div>
          </div>
        ) : null}

        {!data ? (
          <div className="card">
            <div className="card-body stack">
              <p className="small muted" style={{ margin: 0 }}>
                Regole applicate: <strong>U.M. KG</strong> (o K, KG.) → prezzo <strong>al kg</strong>; <strong>LT</strong> → al litro; per PZ, N., CT, CF, SCAT. il formato si legge dal nome (500 ml, KG 10, 62g×8, X 90, 1000PZ).
                Gli <strong>sconti</strong> si applicano a cascata in percentuale (5+5 = 9,75%; «-17,00» = 17%). Lo stesso fornitore scritto in modi diversi viene unificato; i prodotti già presenti si aggiornano (stesso nome e fornitore o stesso codice articolo), le righe senza prezzo si scartano.
              </p>
              {error ? <div className="alert err">{error}</div> : null}
              <div className="row">
                <input ref={fileRef} type="file" accept=".csv,.xlsx" hidden onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} />
                <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? <span className="spinner" /> : <Icon name="upload" />} Scegli il listino (.csv o .xlsx)
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="card">
              <div className="card-head">
                <h2>Cosa ho trovato</h2>
                <button className="btn sm ghost" onClick={() => setData(null)}>
                  Cambia file
                </button>
              </div>
              <div className="card-body stack">
                <div className="pl-kpis">
                  <div>
                    <strong>{data.summary.products}</strong>
                    <span>prodotti da {data.summary.rows - data.summary.skipped} righe con prezzo</span>
                  </div>
                  <div>
                    <strong>{data.summary.new}</strong>
                    <span>nuovi</span>
                  </div>
                  <div>
                    <strong>{data.summary.update}</strong>
                    <span>già presenti, da aggiornare</span>
                  </div>
                  <div>
                    <strong>{data.summary.byMode.kg}</strong>
                    <span>al kg</span>
                  </div>
                  <div>
                    <strong>{data.summary.discounted}</strong>
                    <span>prezzi con sconti applicati</span>
                  </div>
                  <div>
                    <strong>{data.summary.skipped}</strong>
                    <span>righe senza prezzo scartate</span>
                  </div>
                </div>
                {data.suppliers.length ? (
                  <div className="alert info" style={{ flexDirection: 'column', gap: 4 }}>
                    <strong>Fornitori unificati</strong>
                    {data.suppliers.map((s) => (
                      <span key={s.name} className="small">
                        {s.variants.filter((v) => v !== s.name).join(', ')} → <strong>{s.name}</strong>
                      </span>
                    ))}
                  </div>
                ) : null}
                {checks ? (
                  <div className="alert warn">
                    <Icon name="alert" />
                    <div>
                      <strong>{checks} prodotti da controllare</strong>: il formato non si capisce dal nome (es. «Coca Cola latt 33 cl» a cartone: quante lattine?). Correggi «Come lo paghi» oppure lasciali come sono e sistemali dopo dalla scheda.
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="card">
              <div className="card-body stack">
                <div className="row wrap between" style={{ gap: 8 }}>
                  <div className="seg">
                    {(
                      [
                        ['check', `Da controllare (${checks})`],
                        ['new', `Nuovi (${items.filter((p) => !p.existingId).length})`],
                        ['update', `Da aggiornare (${items.filter((p) => p.existingId).length})`],
                        ['all', `Tutti (${items.length})`],
                      ] as const
                    ).map(([k, l]) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={filter === k}
                        onClick={() => {
                          setFilter(k)
                          setPage(1)
                        }}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                  <input
                    className="input"
                    style={{ maxWidth: 280 }}
                    placeholder="Cerca prodotto, fornitore o categoria"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value)
                      setPage(1)
                    }}
                  />
                </div>
                <datalist id="pl-cats">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <div className="table-wrap">
                  <table className="table pl-table">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }} />
                        <th>Prodotto</th>
                        <th>Come lo paghi</th>
                        <th>Categoria</th>
                        <th title="Non alimentare: non serve il peso">Non alim.</th>
                        <th className="num">Prezzo netto</th>
                        <th className="num">Normalizzato</th>
                      </tr>
                    </thead>
                    <tbody>
                      {slice.map((p) => (
                        <tr key={p.key} className={p.include ? '' : 'pl-off'}>
                          <td>
                            <input type="checkbox" aria-label="Importa" checked={!!p.include} onChange={(e) => set(p.key, { include: e.target.checked })} />
                          </td>
                          <td style={{ minWidth: 220 }}>
                            <strong>{p.name}</strong> {p.existingId ? <span className="badge">aggiorna</span> : <span className="badge info">nuovo</span>}
                            <div className="small faint">
                              {p.supplier} · U.M. {p.um || '—'}
                              {p.before ? ` · prima: ${p.before.purchaseUnit} ${qn(p.before.content)} ${p.before.unit}` : ''}
                            </div>
                            {p.check ? <div className="small" style={{ color: 'var(--warn)' }}>⚠ {p.check}</div> : null}
                            {p.note ? <div className="small faint">{p.note}</div> : null}
                          </td>
                          <td style={{ minWidth: 230 }}>
                            <div className="row" style={{ gap: 6 }}>
                              <select className="input" value={p.mode} aria-label="Come lo paghi" onChange={(e) => set(p.key, { mode: e.target.value as Product['mode'], check: null })}>
                                <option value="kg">Al kg</option>
                                <option value="l">Al litro</option>
                                <option value="conf">Confezione</option>
                              </select>
                              {p.mode === 'conf' ? (
                                <>
                                  <input className="input" style={{ width: 70 }} inputMode="decimal" aria-label="Contenuto" value={qn(p.content)} onChange={(e) => set(p.key, { content: e.target.value.replace(',', '.'), check: null })} />
                                  <select className="input" style={{ width: 70 }} aria-label="Unità" value={p.unit} onChange={(e) => set(p.key, { unit: e.target.value, check: null })}>
                                    {UNITS.map((u) => (
                                      <option key={u} value={u}>
                                        {u}
                                      </option>
                                    ))}
                                  </select>
                                </>
                              ) : null}
                            </div>
                            {p.mode === 'conf' && p.unit === 'pz' && p.pieceKg ? <div className="small faint">un pezzo: {qn(String(Number(p.pieceKg) * 1000))} {p.density ? 'ml' : 'g'}</div> : null}
                          </td>
                          <td>
                            <input className="input" style={{ minWidth: 150 }} list="pl-cats" value={p.category} aria-label="Categoria" onChange={(e) => set(p.key, { category: e.target.value })} />
                          </td>
                          <td>
                            <input type="checkbox" aria-label="Non alimentare" checked={p.nonFood} onChange={(e) => set(p.key, { nonFood: e.target.checked })} />
                          </td>
                          <td className="num" title={p.prices.map((x) => `${date(x.date)}: ${euro(x.gross)}${x.discount ? ` −${x.discount}%` : ''} = ${euro(x.net)}`).join('\n')}>
                            <strong>{euro(p.prices[0]?.net)}</strong>
                            <div className="small faint">
                              {p.prices[0]?.discount ? `${euro(p.prices[0].gross)} −${p.prices[0].discount}%` : date(p.prices[0]?.date)}
                              {p.prices.length > 1 ? ` · ${p.prices.length} prezzi` : ''}
                            </div>
                          </td>
                          <td className="num">{normalized(p)}</td>
                        </tr>
                      ))}
                      {!slice.length ? (
                        <tr>
                          <td colSpan={7} className="muted small">
                            Nessun prodotto in questo elenco.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                {pages > 1 ? (
                  <div className="row" style={{ gap: 6, justifyContent: 'center' }}>
                    <button className="btn sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                      ‹
                    </button>
                    <span className="small">
                      Pagina {page} di {pages}
                    </span>
                    <button className="btn sm" disabled={page === pages} onClick={() => setPage(page + 1)}>
                      ›
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            {error ? <div className="alert err">{error}</div> : null}
            <div className="pl-bar">
              <span className="small">
                {included.length} prodotti, {included.reduce((n, p) => n + p.prices.length, 0)} prezzi{checks ? ` · ${checks} da controllare` : ''}
              </span>
              <button className="btn primary" disabled={busy || !included.length} onClick={() => void apply()}>
                {busy ? <span className="spinner" /> : null} Importa {included.length} prodotti
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}
