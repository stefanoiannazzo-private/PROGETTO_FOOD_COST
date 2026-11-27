'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { euro, percent } from '@/lib/num'
import { PageHead } from '@/components/AppShell'
import { Drawer, Empty, ErrorBox, errorMessage, Field, fieldErrors, Icon, NumberInput, Skeleton, useToast } from '@/components/ui'

/**
 * NUOVO — Area Ordini, configurazione: menu (sezioni e piatti da ricette o prodotti pronti),
 * sale e tavoli con QR, postazioni (cucina, bancone…), menu digitale e coperto.
 */
export interface Station {
  id: string
  name: string
  kind: 'kitchen' | 'bar' | 'other'
  isActive: boolean
}
export interface Section {
  id: string
  name: string
  stationId: string | null
  isDrinks: boolean
  isVisible: boolean
}
export interface MenuItem {
  id: string
  sectionId: string
  sourceType: 'recipe' | 'ingredient'
  recipeId: string | null
  ingredientId: string | null
  sourceName: string | null
  recipeStatus: string | null
  portionQty: string | null
  portionUnit: string | null
  name: string
  description: string | null
  price: string
  vatPercent: string
  stationId: string | null
  isAvailable: boolean
  isPublic: boolean
  unitCost: string | null
}
interface Area {
  id: string
  name: string
}
interface Table {
  id: string
  label: string
  seats: number
  areaId: string | null
  isActive: boolean
  qrUrl: string
}
interface Settings {
  publicToken: string
  publicMode: 'off' | 'open' | 'required' | 'optional'
  giftText: string | null
  guestOrdering: boolean
  coverCharge: string
  publicUrl: string
}
interface Setup {
  stations: Station[]
  sections: Section[]
  items: MenuItem[]
  areas: Area[]
  tables: Table[]
  settings: Settings
  costsVisible: boolean
}

const KIND: Record<Station['kind'], string> = { kitchen: 'Cucina', bar: 'Bancone / bar', other: 'Altro' }
type Tab = 'menu' | 'tavoli' | 'postazioni' | 'personale' | 'digitale'

export default function OrderSetupPage() {
  const [tab, setTab] = useState<Tab>('menu')
  const q = useQuery({ queryKey: ['orders', 'setup'], queryFn: () => api.get<Setup>('/orders/setup') })
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null
    if (t && ['menu', 'tavoli', 'postazioni', 'personale', 'digitale'].includes(t)) setTab(t)
  }, [])

  return (
    <>
      <PageHead title="Menu e tavoli" sub="Prepara il menu (solo ricette e prodotti pronti), i tavoli e le postazioni che ricevono le comande." />
      <div className="tabs" role="tablist">
        {(
          [
            ['menu', 'Menu'],
            ['tavoli', 'Sale e tavoli'],
            ['postazioni', 'Postazioni'],
            ['personale', 'Personale e PIN'],
            ['digitale', 'Menu digitale'],
          ] as Array<[Tab, string]>
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {q.error ? (
        <ErrorBox error={q.error} retry={() => q.refetch()} />
      ) : !q.data ? (
        <Skeleton />
      ) : tab === 'menu' ? (
        <MenuTab s={q.data} />
      ) : tab === 'tavoli' ? (
        <TablesTab s={q.data} />
      ) : tab === 'postazioni' ? (
        <StationsTab s={q.data} />
      ) : tab === 'personale' ? (
        <StaffTab />
      ) : (
        <DigitalTab s={q.data} />
      )}
    </>
  )
}

function useRefresh() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['orders'] })
}

/* ================================ MENU ================================ */

function MenuTab({ s }: { s: Setup }) {
  const refresh = useRefresh()
  const toast = useToast()
  const [section, setSection] = useState<Section | 'new' | null>(null)
  const [item, setItem] = useState<{ item: MenuItem | null; sectionId: string } | null>(null)
  const stationName = (id: string | null) => s.stations.find((x) => x.id === id)?.name
  const move = async (list: string[], i: number, dir: -1 | 1, what: 'sections' | 'items') => {
    const j = i + dir
    if (j < 0 || j >= list.length) return
    const ids = [...list]
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    await api.post(`/orders/setup/reorder/${what}`, { ids })
    refresh()
  }
  const toggle = async (m: MenuItem) => {
    try {
      await api.patch(`/orders/setup/items/${m.id}/availability`, { isAvailable: !m.isAvailable })
      refresh()
    } catch (e) {
      toast(errorMessage(e))
    }
  }

  if (!s.sections.length) {
    return (
      <div className="card">
        <Empty
          title="Crea le sezioni del menu"
          action={
            <button className="btn primary" onClick={() => setSection('new')}>
              <Icon name="plus" /> Nuova sezione
            </button>
          }
        >
          Ad esempio Antipasti, Primi, Secondi, Pizze, Dessert, Bevande. Poi aggiungi i piatti scegliendoli tra le tue ricette o i prodotti pronti.
          {!s.stations.length ? ' Conviene creare prima le postazioni (Cucina, Bancone) per dire dove arrivano le comande.' : ''}
        </Empty>
        {section ? <SectionEditor s={s} section={section === 'new' ? null : section} onClose={() => setSection(null)} /> : null}
      </div>
    )
  }

  return (
    <>
      <div className="row between wrap" style={{ marginBottom: 12, gap: 8 }}>
        <span className="small muted">
          {s.items.length} piatti in {s.sections.length} sezioni · «esaurito» toglie il piatto per oggi senza cancellarlo
        </span>
        <button className="btn" onClick={() => setSection('new')}>
          <Icon name="plus" /> Nuova sezione
        </button>
      </div>
      {s.sections.map((sec, si) => {
        const items = s.items.filter((m) => m.sectionId === sec.id)
        return (
          <div className="card menu-section" key={sec.id} style={{ marginBottom: 14, opacity: sec.isVisible ? 1 : 0.6 }}>
            <div className="card-head">
              <div>
                <h2 style={{ display: 'inline' }}>{sec.name}</h2>{' '}
                {sec.isDrinks ? <span className="badge info">bevande · partono subito</span> : null}
                {!sec.isVisible ? <span className="badge">nascosta</span> : null}
                <div className="small faint">{stationName(sec.stationId) ? `Comande a: ${stationName(sec.stationId)}` : 'Nessuna postazione: scegline una'}</div>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn ghost sm" aria-label="Sposta su" disabled={si === 0} onClick={() => void move(s.sections.map((x) => x.id), si, -1, 'sections')}>
                  <Icon name="up" />
                </button>
                <button className="btn ghost sm" aria-label="Sposta giù" disabled={si === s.sections.length - 1} onClick={() => void move(s.sections.map((x) => x.id), si, 1, 'sections')}>
                  <Icon name="down" />
                </button>
                <button className="btn ghost sm" onClick={() => setSection(sec)}>
                  <Icon name="edit" /> Modifica
                </button>
                <button className="btn primary sm" onClick={() => setItem({ item: null, sectionId: sec.id })}>
                  <Icon name="plus" /> Piatto
                </button>
              </div>
            </div>
            {items.length === 0 ? (
              <div className="card-body small muted">Nessun piatto. Aggiungine uno dalle tue ricette o dai prodotti pronti.</div>
            ) : (
              <ul className="menu-items">
                {items.map((m, mi) => {
                  const fc = s.costsVisible && m.unitCost && Number(m.price) > 0 ? Number(m.unitCost) / (Number(m.price) / (1 + Number(m.vatPercent) / 100)) : null
                  return (
                    <li key={m.id} className={m.isAvailable ? '' : 'sold-out'}>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <button type="button" className="link-btn" onClick={() => setItem({ item: m, sectionId: sec.id })}>
                          {m.name}
                        </button>
                        {!m.isAvailable ? <span className="badge warn"> esaurito</span> : null}
                        {!m.isPublic ? <span className="badge"> solo sala</span> : null}
                        <div className="small faint">
                          {m.sourceType === 'recipe' ? 'Ricetta' : `Prodotto pronto · ${m.portionQty?.replace('.', ',')} ${m.portionUnit}`}
                          {m.sourceName && m.sourceName !== m.name ? `: ${m.sourceName}` : ''}
                          {m.stationId && m.stationId !== sec.stationId ? ` · a ${stationName(m.stationId)}` : ''}
                          {s.costsVisible ? (m.unitCost ? ` · costo ${euro(m.unitCost)}${fc !== null ? ` · food cost ${percent(fc * 100, 0)}` : ''}` : ' · costo non calcolabile') : ''}
                        </div>
                      </div>
                      <strong className="num">{euro(m.price)}</strong>
                      <label className="switch small" title={m.isAvailable ? 'Disponibile: tocca per segnare esaurito' : 'Esaurito: tocca per rimetterlo'}>
                        <input type="checkbox" checked={m.isAvailable} onChange={() => void toggle(m)} /> <span>{m.isAvailable ? 'disponibile' : 'esaurito'}</span>
                      </label>
                      <span className="row" style={{ gap: 0 }}>
                        <button className="btn ghost sm" aria-label="Sposta su" disabled={mi === 0} onClick={() => void move(items.map((x) => x.id), mi, -1, 'items')}>
                          <Icon name="up" />
                        </button>
                        <button className="btn ghost sm" aria-label="Sposta giù" disabled={mi === items.length - 1} onClick={() => void move(items.map((x) => x.id), mi, 1, 'items')}>
                          <Icon name="down" />
                        </button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
      {section ? <SectionEditor s={s} section={section === 'new' ? null : section} onClose={() => setSection(null)} /> : null}
      {item ? <ItemEditor s={s} item={item.item} sectionId={item.sectionId} onClose={() => setItem(null)} /> : null}
    </>
  )
}

function SectionEditor({ s, section, onClose }: { s: Setup; section: Section | null; onClose: () => void }) {
  const refresh = useRefresh()
  const toast = useToast()
  const [v, setV] = useState({ name: section?.name ?? '', stationId: section?.stationId ?? s.stations[0]?.id ?? '', isDrinks: section?.isDrinks ?? false, isVisible: section?.isVisible ?? true })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    setErrors({})
    try {
      const body = { ...v, stationId: v.stationId || null }
      if (section) await api.put(`/orders/setup/sections/${section.id}`, body)
      else await api.post('/orders/setup/sections', body)
      refresh()
      onClose()
    } catch (e) {
      setErrors(fieldErrors(e))
      if (!Object.keys(fieldErrors(e)).length) toast(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!section || !window.confirm(`Eliminare la sezione «${section.name}»?`)) return
    try {
      await api.del(`/orders/setup/sections/${section.id}`)
      refresh()
      onClose()
    } catch (e) {
      toast(errorMessage(e))
    }
  }
  return (
    <Drawer
      title={section ? `Sezione: ${section.name}` : 'Nuova sezione'}
      onClose={onClose}
      footer={
        <>
          {section ? (
            <button className="btn ghost danger" onClick={() => void remove()}>
              <Icon name="trash" /> Elimina
            </button>
          ) : null}
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? <span className="spinner" /> : null} Salva
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Nome" htmlFor="sec-name" required error={errors.name} hint="es. Antipasti, Primi, Pizze, Dessert, Vini, Bibite">
          <input id="sec-name" className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Dove arrivano le comande" htmlFor="sec-st" error={errors.stationId} hint="Vale per tutti i piatti della sezione; il singolo piatto può avere una postazione diversa.">
          <select id="sec-st" className="input" value={v.stationId} onChange={(e) => setV({ ...v, stationId: e.target.value })}>
            <option value="">— nessuna —</option>
            {s.stations.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name}
              </option>
            ))}
          </select>
        </Field>
        {!s.stations.length ? <div className="alert warn small">Non hai ancora postazioni: creale nella scheda «Postazioni».</div> : null}
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={v.isDrinks} onChange={(e) => setV({ ...v, isDrinks: e.target.checked })} /> Sono bevande: partono subito, senza aspettare le portate
        </label>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={v.isVisible} onChange={(e) => setV({ ...v, isVisible: e.target.checked })} /> Visibile (in sala e nel menu digitale)
        </label>
      </div>
    </Drawer>
  )
}

interface Sources {
  recipes: Array<{ id: string; name: string; code: string; status: string; menuPrice: string | null; vatPercent: string | null }>
  ingredients: Array<{ id: string; name: string; code: string; category: string | null; unit: string | null }>
}

function ItemEditor({ s, item, sectionId, onClose }: { s: Setup; item: MenuItem | null; sectionId: string; onClose: () => void }) {
  const refresh = useRefresh()
  const toast = useToast()
  const [v, setV] = useState({
    sectionId: item?.sectionId ?? sectionId,
    sourceType: item?.sourceType ?? ('recipe' as 'recipe' | 'ingredient'),
    recipeId: item?.recipeId ?? null,
    ingredientId: item?.ingredientId ?? null,
    sourceName: item?.sourceName ?? '',
    portionQty: item?.portionQty ?? '1',
    portionUnit: item?.portionUnit ?? 'pz',
    name: item?.name ?? '',
    description: item?.description ?? '',
    price: item?.price ?? null,
    vatPercent: item?.vatPercent ?? '10',
    stationId: item?.stationId ?? '',
    isAvailable: item?.isAvailable ?? true,
    isPublic: item?.isPublic ?? true,
  })
  const [search, setSearch] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const chosen = v.sourceType === 'recipe' ? v.recipeId : v.ingredientId
  const src = useQuery({
    queryKey: ['orders', 'sources', search],
    queryFn: () => api.get<Sources>(`/orders/setup/sources?q=${encodeURIComponent(search)}`),
    enabled: !chosen,
  })
  const save = async () => {
    setBusy(true)
    setErrors({})
    try {
      const body = { ...v, stationId: v.stationId || null, name: v.name.trim() || null, description: v.description.trim() || null, price: v.price ?? '' }
      if (item) await api.put(`/orders/setup/items/${item.id}`, body)
      else await api.post('/orders/setup/items', body)
      refresh()
      onClose()
    } catch (e) {
      setErrors(fieldErrors(e))
      if (!Object.keys(fieldErrors(e)).length) toast(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!item || !window.confirm(`Togliere «${item.name}» dal menu? Le vendite già registrate restano nelle statistiche.`)) return
    await api.del(`/orders/setup/items/${item.id}`)
    refresh()
    onClose()
  }
  return (
    <Drawer
      wide
      title={item ? item.name : 'Nuovo piatto nel menu'}
      onClose={onClose}
      footer={
        <>
          {item ? (
            <button className="btn ghost danger" onClick={() => void remove()}>
              <Icon name="trash" /> Togli dal menu
            </button>
          ) : null}
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button className="btn primary" disabled={busy || !chosen} onClick={() => void save()}>
            {busy ? <span className="spinner" /> : null} Salva
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <span className="label">Da cosa nasce il piatto</span>
          <div className="seg">
            <button type="button" aria-pressed={v.sourceType === 'recipe'} onClick={() => setV({ ...v, sourceType: 'recipe', recipeId: null, ingredientId: null, sourceName: '' })}>
              Una mia ricetta
            </button>
            <button type="button" aria-pressed={v.sourceType === 'ingredient'} onClick={() => setV({ ...v, sourceType: 'ingredient', recipeId: null, ingredientId: null, sourceName: '' })}>
              Un prodotto pronto
            </button>
          </div>
          <span className="small faint">{v.sourceType === 'recipe' ? 'Il costo viene dalla ricetta (costo per porzione).' : 'Per i prodotti comprati già pronti: bibite, dolci confezionati, vino al calice…'}</span>
        </div>
        {chosen ? (
          <div className="alert info">
            <div className="grow">
              <strong>{v.sourceName}</strong>
            </div>
            <button type="button" className="btn ghost sm" onClick={() => setV({ ...v, recipeId: null, ingredientId: null, sourceName: '' })}>
              Cambia
            </button>
          </div>
        ) : (
          <Field label={v.sourceType === 'recipe' ? 'Cerca la ricetta' : 'Cerca il prodotto'} htmlFor="it-src" error={errors.recipeId ?? errors.ingredientId}>
            <input id="it-src" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome o codice" autoFocus />
            <div className="pick-list">
              {(v.sourceType === 'recipe' ? src.data?.recipes : src.data?.ingredients)?.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() =>
                    'menuPrice' in o
                      ? setV({ ...v, recipeId: o.id, sourceName: o.name, name: v.name || o.name, price: v.price ?? o.menuPrice, vatPercent: o.vatPercent ?? v.vatPercent })
                      : setV({ ...v, ingredientId: o.id, sourceName: o.name, name: v.name || o.name, portionUnit: o.unit ?? 'pz' })
                  }
                >
                  <strong>{o.name}</strong> <span className="faint small mono">{o.code}</span>
                  {'menuPrice' in o && o.status === 'draft' ? <span className="badge"> bozza</span> : null}
                  {'menuPrice' in o && o.menuPrice ? <span className="small faint"> · {euro(o.menuPrice)}</span> : null}
                </button>
              ))}
            </div>
          </Field>
        )}
        {v.sourceType === 'ingredient' ? (
          <Field label="Quanto se ne serve" htmlFor="it-qty" error={errors.portionQty} hint="es. 1 pz (una lattina), 0,2 l (un calice), 0,1 kg">
            <NumberInput
              id="it-qty"
              value={v.portionQty}
              onChange={(x) => setV({ ...v, portionQty: x ?? '' })}
              suffix={
                <select className="addon" value={v.portionUnit} onChange={(e) => setV({ ...v, portionUnit: e.target.value })} aria-label="Unità">
                  {['pz', 'g', 'kg', 'ml', 'l'].map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              }
            />
          </Field>
        ) : null}
        <Field label="Nome nel menu" htmlFor="it-name" error={errors.name} hint="Se vuoto, quello della ricetta o del prodotto">
          <input id="it-name" className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Descrizione per i clienti" htmlFor="it-desc" error={errors.description} hint="Facoltativa: compare nel menu digitale">
          <textarea id="it-desc" className="input" rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        </Field>
        <div className="grid-3">
          <Field label="Prezzo (IVA inclusa)" htmlFor="it-price" required error={errors.price}>
            <NumberInput id="it-price" value={v.price} onChange={(x) => setV({ ...v, price: x })} suffix="€" invalid={!!errors.price} />
          </Field>
          <Field label="IVA" htmlFor="it-vat" error={errors.vatPercent}>
            <NumberInput id="it-vat" value={v.vatPercent} onChange={(x) => setV({ ...v, vatPercent: x ?? '10' })} suffix="%" />
          </Field>
          <Field label="Sezione" htmlFor="it-sec">
            <select id="it-sec" className="input" value={v.sectionId} onChange={(e) => setV({ ...v, sectionId: e.target.value })}>
              {s.sections.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {v.sourceType === 'recipe' ? <span className="small faint">Il prezzo è lo stesso usato in Redditività: cambiarlo qui lo aggiorna anche lì.</span> : null}
        <Field label="Dove arriva la comanda" htmlFor="it-st" hint="Lascia «come la sezione» se va alla stessa postazione degli altri piatti">
          <select id="it-st" className="input" value={v.stationId} onChange={(e) => setV({ ...v, stationId: e.target.value })}>
            <option value="">Come la sezione</option>
            {s.stations.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={v.isPublic} onChange={(e) => setV({ ...v, isPublic: e.target.checked })} /> Mostra nel menu digitale (QR)
        </label>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={v.isAvailable} onChange={(e) => setV({ ...v, isAvailable: e.target.checked })} /> Disponibile oggi
        </label>
      </div>
    </Drawer>
  )
}

/* ============================ SALE E TAVOLI ============================ */

function TablesTab({ s }: { s: Setup }) {
  const refresh = useRefresh()
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [edit, setEdit] = useState<Table | null>(null)
  const [areaName, setAreaName] = useState('')
  const addArea = async () => {
    if (!areaName.trim()) return
    try {
      await api.post('/orders/setup/areas', { name: areaName })
      setAreaName('')
      refresh()
    } catch (e) {
      toast(errorMessage(e))
    }
  }
  const groups = [...s.areas.map((a) => ({ id: a.id as string | null, name: a.name })), { id: null, name: s.areas.length ? 'Senza sala' : 'Tavoli' }]
  return (
    <>
      <div className="row between wrap" style={{ marginBottom: 12, gap: 8 }}>
        <div className="row" style={{ gap: 6 }}>
          <input className="input" style={{ width: 200 }} placeholder="Nuova sala (es. Dehors)" value={areaName} onChange={(e) => setAreaName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addArea()} />
          <button className="btn" onClick={() => void addArea()} disabled={!areaName.trim()}>
            Aggiungi sala
          </button>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {s.tables.length ? (
            <Link className="btn" href="/ordini/qr" target="_blank">
              <Icon name="qr" /> Stampa i QR
            </Link>
          ) : null}
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Aggiungi tavoli
          </button>
        </div>
      </div>
      {!s.tables.length ? (
        <div className="card">
          <Empty title="Nessun tavolo">Aggiungi i tavoli del locale: puoi crearne tanti in un colpo, per esempio dal 1 al 20. Durante il servizio il cameriere potrà unirli (5 + 6 → «5-6»).</Empty>
        </div>
      ) : (
        groups.map((g) => {
          const tables = s.tables.filter((t) => t.areaId === g.id)
          if (!tables.length && g.id === null) return null
          return (
            <div className="card" key={g.id ?? 'none'} style={{ marginBottom: 14 }}>
              <div className="card-head">
                <h2>{g.name}</h2>
                <span className="small muted">
                  {tables.length} tavoli · {tables.reduce((a, t) => a + t.seats, 0)} posti
                </span>
              </div>
              <div className="card-body table-grid">
                {tables.map((t) => (
                  <button key={t.id} type="button" className={`table-chip ${t.isActive ? '' : 'off'}`} onClick={() => setEdit(t)}>
                    <strong>{t.label}</strong>
                    <span className="small faint">{t.seats} posti</span>
                  </button>
                ))}
                {!tables.length ? <span className="small muted">Nessun tavolo in questa sala.</span> : null}
              </div>
            </div>
          )
        })
      )}
      {adding ? <TablesAdd s={s} onClose={() => setAdding(false)} /> : null}
      {edit ? <TableEdit s={s} table={edit} onClose={() => setEdit(null)} /> : null}
    </>
  )
}

function TablesAdd({ s, onClose }: { s: Setup; onClose: () => void }) {
  const refresh = useRefresh()
  const [mode, setMode] = useState<'range' | 'one'>('range')
  const [v, setV] = useState({ from: '1', to: '10', label: '', seats: '4', areaId: s.areas[0]?.id ?? '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.post('/orders/setup/tables', {
        ...(mode === 'range' ? { from: Number(v.from), to: Number(v.to) } : { label: v.label }),
        seats: Number(v.seats),
        areaId: v.areaId || null,
      })
      refresh()
      onClose()
    } catch (e) {
      setError(fieldErrors(e).label ?? errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer
      title="Aggiungi tavoli"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? <span className="spinner" /> : null} Aggiungi
          </button>
        </>
      }
    >
      <div className="stack">
        {error ? <div className="alert err">{error}</div> : null}
        <div className="seg">
          <button type="button" aria-pressed={mode === 'range'} onClick={() => setMode('range')}>
            Più tavoli numerati
          </button>
          <button type="button" aria-pressed={mode === 'one'} onClick={() => setMode('one')}>
            Un tavolo
          </button>
        </div>
        {mode === 'range' ? (
          <div className="grid-2">
            <Field label="Dal numero" htmlFor="t-from">
              <input id="t-from" className="input" inputMode="numeric" value={v.from} onChange={(e) => setV({ ...v, from: e.target.value })} />
            </Field>
            <Field label="Al numero" htmlFor="t-to">
              <input id="t-to" className="input" inputMode="numeric" value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} />
            </Field>
          </div>
        ) : (
          <Field label="Numero o nome del tavolo" htmlFor="t-label" hint="es. 12, 12B, Terrazza 1">
            <input id="t-label" className="input" value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} />
          </Field>
        )}
        <div className="grid-2">
          <Field label="Posti per tavolo" htmlFor="t-seats">
            <input id="t-seats" className="input" inputMode="numeric" value={v.seats} onChange={(e) => setV({ ...v, seats: e.target.value })} />
          </Field>
          <Field label="Sala" htmlFor="t-area">
            <select id="t-area" className="input" value={v.areaId} onChange={(e) => setV({ ...v, areaId: e.target.value })}>
              <option value="">— nessuna —</option>
              {s.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </Drawer>
  )
}

function TableEdit({ s, table, onClose }: { s: Setup; table: Table; onClose: () => void }) {
  const refresh = useRefresh()
  const toast = useToast()
  const [v, setV] = useState({ label: table.label, seats: String(table.seats), areaId: table.areaId ?? '', isActive: table.isActive })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await api.put(`/orders/setup/tables/${table.id}`, { label: v.label, seats: Number(v.seats), areaId: v.areaId || null, isActive: v.isActive })
      refresh()
      onClose()
    } catch (e) {
      toast(fieldErrors(e).label ?? errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!window.confirm(`Eliminare il tavolo ${table.label}?`)) return
    try {
      await api.del(`/orders/setup/tables/${table.id}`)
      refresh()
      onClose()
    } catch (e) {
      toast(errorMessage(e))
    }
  }
  return (
    <Drawer
      title={`Tavolo ${table.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost danger" onClick={() => void remove()}>
            <Icon name="trash" /> Elimina
          </button>
          <button className="btn" onClick={onClose}>
            Annulla
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            Salva
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Numero o nome" htmlFor="te-l">
            <input id="te-l" className="input" value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} />
          </Field>
          <Field label="Posti" htmlFor="te-s">
            <input id="te-s" className="input" inputMode="numeric" value={v.seats} onChange={(e) => setV({ ...v, seats: e.target.value })} />
          </Field>
        </div>
        <Field label="Sala" htmlFor="te-a">
          <select id="te-a" className="input" value={v.areaId} onChange={(e) => setV({ ...v, areaId: e.target.value })}>
            <option value="">— nessuna —</option>
            {s.areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} /> In uso (togli la spunta per un tavolo che stasera non c’è)
        </label>
        <div className="small muted">
          QR di questo tavolo:{' '}
          <a className="link" href={table.qrUrl} target="_blank" rel="noreferrer">
            apri il menu
          </a>
        </div>
      </div>
    </Drawer>
  )
}

/* ============================== POSTAZIONI ============================== */

function StationsTab({ s }: { s: Setup }) {
  const refresh = useRefresh()
  const toast = useToast()
  const [v, setV] = useState({ name: '', kind: 'kitchen' as Station['kind'] })
  const add = async () => {
    try {
      await api.post('/orders/setup/stations', v)
      setV({ name: '', kind: 'kitchen' })
      refresh()
    } catch (e) {
      toast(fieldErrors(e).name ?? errorMessage(e))
    }
  }
  const rename = async (st: Station) => {
    const name = window.prompt('Nuovo nome della postazione', st.name)
    if (!name) return
    await api.put(`/orders/setup/stations/${st.id}`, { name, kind: st.kind, isActive: st.isActive })
    refresh()
  }
  const remove = async (st: Station) => {
    if (!window.confirm(`Eliminare la postazione «${st.name}»? Le sezioni che la usano resteranno senza postazione.`)) return
    try {
      await api.del(`/orders/setup/stations/${st.id}`)
      refresh()
    } catch (e) {
      toast(errorMessage(e))
    }
  }
  return (
    <div className="card">
      <div className="card-body stack">
        <p className="small muted" style={{ margin: 0 }}>
          Le postazioni ricevono le comande: ognuna ha il suo schermo in «Cucina e bancone». Di solito bastano <strong>Cucina</strong> e <strong>Bancone</strong>; aggiungi Pizzeria, Griglia o Pasticceria se hanno uno schermo a parte.
        </p>
        {s.stations.length ? (
          <ul className="menu-items" style={{ margin: 0 }}>
            {s.stations.map((st) => (
              <li key={st.id}>
                <div className="grow">
                  <strong>{st.name}</strong> <span className="small faint">· {KIND[st.kind]}</span>
                  <div className="small faint">{s.sections.filter((x) => x.stationId === st.id).map((x) => x.name).join(', ') || 'Nessuna sezione'}</div>
                </div>
                <button className="btn ghost sm" onClick={() => void rename(st)}>
                  <Icon name="edit" /> Rinomina
                </button>
                <button className="btn ghost sm" aria-label="Elimina" onClick={() => void remove(st)}>
                  <Icon name="trash" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="row wrap" style={{ gap: 8 }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="es. Cucina, Bancone, Pizzeria" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && v.name.trim() && void add()} />
          <select className="input" style={{ maxWidth: 180 }} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as Station['kind'] })} aria-label="Tipo">
            {Object.entries(KIND).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!v.name.trim()} onClick={() => void add()}>
            <Icon name="plus" /> Aggiungi postazione
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============================ PERSONALE E PIN ============================ */

interface Staff {
  userId: string
  name: string
  email: string
  roleLabel: string
  takesOrders: boolean
  kitchen: boolean
  hasPin: boolean
}

function StaffTab() {
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['orders', 'staff'], queryFn: () => api.get<{ data: Staff[] }>('/orders/staff') })
  const setPin = async (st: Staff, remove = false) => {
    const pin = remove ? null : window.prompt(`PIN di ${st.name} (4–6 cifre). Comunicaglielo a voce: serve sui tablet condivisi.`, '')
    if (!remove && (pin === null || pin === '')) return
    try {
      await api.put(`/orders/staff/${st.userId}/pin`, { pin })
      void qc.invalidateQueries({ queryKey: ['orders', 'staff'] })
      toast(remove ? 'PIN tolto.' : `PIN di ${st.name} impostato.`)
    } catch (e) {
      toast(fieldErrors(e).pin ?? errorMessage(e))
    }
  }
  return (
    <div className="card">
      <div className="card-body stack">
        <p className="small muted" style={{ margin: 0 }}>
          Camerieri e cuochi entrano dal <strong>proprio telefono</strong> con email e password (invitali da «Utenti» con il ruolo <em>Cameriere</em> o <em>Cucina / Bancone</em>), oppure dai <strong>tablet condivisi</strong> del locale identificandosi con un <strong>PIN</strong>. Per attivare un tablet condiviso apri «Sala» su quel dispositivo e tocca «Tablet di servizio».
        </p>
        {q.error ? (
          <ErrorBox error={q.error} />
        ) : !q.data ? (
          <Skeleton rows={3} />
        ) : !q.data.data.length ? (
          <div className="small muted">Nessuno del personale può ancora prendere ordini o vedere le comande.</div>
        ) : (
          <ul className="menu-items" style={{ margin: 0 }}>
            {q.data.data.map((st) => (
              <li key={st.userId}>
                <div className="grow">
                  <strong>{st.name}</strong> <span className="small faint">· {st.roleLabel}</span>
                  <div className="small faint">
                    {[st.takesOrders ? 'prende ordini' : null, st.kitchen ? 'vede le comande' : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span className={`badge ${st.hasPin ? 'ok' : ''}`}>{st.hasPin ? 'PIN impostato' : 'senza PIN'}</span>
                <button className="btn sm" onClick={() => void setPin(st)}>
                  {st.hasPin ? 'Cambia PIN' : 'Imposta PIN'}
                </button>
                {st.hasPin ? (
                  <button className="btn ghost sm" onClick={() => void setPin(st, true)}>
                    Togli
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/* ============================= MENU DIGITALE ============================= */

function DigitalTab({ s }: { s: Setup }) {
  const refresh = useRefresh()
  const toast = useToast()
  const [v, setV] = useState({ publicMode: s.settings.publicMode, giftText: s.settings.giftText ?? '', coverCharge: s.settings.coverCharge })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = async () => {
    setErrors({})
    try {
      await api.put('/orders/setup/settings', { ...v, giftText: v.giftText.trim() || null })
      refresh()
      toast('Impostazioni salvate.')
    } catch (e) {
      setErrors(fieldErrors(e))
    }
  }
  const modes: Array<[Settings['publicMode'], string, string]> = [
    ['open', 'Libero', 'Chi inquadra il QR vede subito il menu.'],
    ['optional', 'Registrazione facoltativa con omaggio', 'Il menu si vede subito; chi lascia nome, cognome, email e telefono riceve un omaggio da mostrare al cameriere.'],
    ['required', 'Registrazione obbligatoria', 'Per vedere il menu bisogna lasciare nome, cognome, email e telefono.'],
    ['off', 'Spento', 'Il QR mostra solo il nome del locale.'],
  ]
  return (
    <div className="card">
      <div className="card-body stack">
        <Field label="Indirizzo del menu digitale" htmlFor="pub-url" hint="Ogni tavolo ha anche il suo QR (scheda «Sale e tavoli» → Stampa i QR).">
          <div className="input-group">
            <input id="pub-url" className="input mono" readOnly value={s.settings.publicUrl} onFocus={(e) => e.currentTarget.select()} />
            <a className="btn" href={s.settings.publicUrl} target="_blank" rel="noreferrer">
              Apri
            </a>
          </div>
        </Field>
        <div className="field">
          <span className="label">Accesso al menu dal QR</span>
          <div className="choice-list">
            {modes.map(([k, l, d]) => (
              <label key={k} className={`choice ${v.publicMode === k ? 'on' : ''}`}>
                <input type="radio" name="pm" checked={v.publicMode === k} onChange={() => setV({ ...v, publicMode: k })} />
                <span>
                  <strong>{l}</strong>
                  <span className="small muted">{d}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        {v.publicMode === 'optional' ? (
          <Field label="Omaggio per chi si registra" htmlFor="gift" required error={errors.giftText} hint="es. Caffè offerto, Limoncello della casa, 10% sul dessert">
            <input id="gift" className="input" value={v.giftText} onChange={(e) => setV({ ...v, giftText: e.target.value })} />
          </Field>
        ) : null}
        <div className="alert info small">
          <Icon name="help" />
          <div>
            <strong>Ordini dal telefono del cliente:</strong> per ora il menu digitale è solo da leggere. La funzione è predisposta: quando vorrai la attiviamo, e gli ordini arriveranno prima al cameriere per la conferma.
          </div>
        </div>
        <Field label="Coperto a persona" htmlFor="cover" error={errors.coverCharge} hint="Si aggiunge al preconto per ogni coperto (0 se non lo applichi)">
          <NumberInput id="cover" value={v.coverCharge} onChange={(x) => setV({ ...v, coverCharge: x ?? '0' })} suffix="€" />
        </Field>
        <div>
          <button className="btn primary" onClick={() => void save()}>
            Salva
          </button>
        </div>
      </div>
    </div>
  )
}
