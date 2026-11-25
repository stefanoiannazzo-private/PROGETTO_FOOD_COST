'use client'

/**
 * NUOVO — Barra di ricerca e filtri delle tabelle.
 * Su computer resta com'era: ricerca e tendine in fila. Su smartphone resta la ricerca e le tendine
 * (filtri e ordinamento) stanno dietro un pulsante di solo testo «Filtri», con il numero di filtri attivi.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './ui'

export function FilterBar({ search, children, onReset }: { search?: ReactNode; children?: ReactNode; onReset?: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState({ controls: 0, active: 0 })
  // conta i comandi presenti e quelli diversi dal valore iniziale (prima opzione / campo vuoto), ordinamento escluso
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fields = Array.from(el.querySelectorAll<HTMLSelectElement | HTMLInputElement>('select, input'))
    const active = fields.filter((f) => {
      if (f.dataset.sort !== undefined) return false
      if (f instanceof HTMLSelectElement) return f.selectedIndex > 0
      return f.type !== 'checkbox' && f.value.trim() !== ''
    }).length
    if (active !== info.active || fields.length !== info.controls) setInfo({ controls: fields.length, active })
  })
  return (
    <div className="toolbar filterbar" data-open={open}>
      {search}
      {info.controls > 0 ? (
        <button type="button" className="filters-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="filter" size={16} /> Filtri
          {info.active ? <span className="filters-count">{info.active}</span> : null}
          <span className="filters-chev" aria-hidden="true">
            <Icon name="chevron" size={14} />
          </span>
        </button>
      ) : null}
      <div className="toolbar-filters" ref={box}>
        {children}
        {onReset && info.active ? (
          <button type="button" className="btn ghost sm filters-reset" onClick={onReset}>
            Azzera filtri
          </button>
        ) : null}
      </div>
    </div>
  )
}
