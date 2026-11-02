'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useDebounced } from './ui'

export interface PickerOption {
  id: string
  label: string
  sub?: string
  right?: ReactNode
  disabled?: boolean
  /** dati aggiuntivi a disposizione di chi seleziona */
  [extra: string]: unknown
}

/** Selezione con ricerca server-side e tastiera (frecce, Invio, Esc). */
export function AsyncPicker({
  queryKey,
  fetchOptions,
  value,
  onSelect,
  placeholder = 'Cerca…',
  createLabel,
  onCreate,
  invalid,
  ariaLabel,
  autoFocus,
}: {
  queryKey: string
  fetchOptions: (q: string, signal?: AbortSignal) => Promise<PickerOption[]>
  value: { id: string; label: string } | null
  onSelect: (opt: PickerOption) => void
  placeholder?: string
  createLabel?: (q: string) => string
  onCreate?: (q: string) => void
  invalid?: boolean
  ariaLabel?: string
  autoFocus?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const q = useDebounced(text, 150)
  const listId = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const { data, isFetching } = useQuery({
    queryKey: ['picker', queryKey, q],
    queryFn: ({ signal }) => fetchOptions(q, signal),
    enabled: open,
    staleTime: 30_000,
  })
  const options = data ?? []
  const total = options.length + (onCreate ? 1 : 0)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  useEffect(() => setActive(0), [q])

  const choose = (i: number) => {
    if (i < options.length) {
      const o = options[i]!
      if (o.disabled) return
      onSelect(o)
      setText('')
      setOpen(false)
    } else if (onCreate) {
      onCreate(text)
      setOpen(false)
    }
  }

  return (
    <div className="picker" ref={wrap}>
      <input
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        autoFocus={autoFocus}
        placeholder={value ? value.label : placeholder}
        value={open ? text : (value?.label ?? '')}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            setActive((a) => Math.min(total - 1, a + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(0, a - 1))
          } else if (e.key === 'Enter' && open) {
            e.preventDefault()
            choose(active)
          } else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open ? (
        <div className="picker-list" role="listbox" id={listId}>
          {isFetching && options.length === 0 ? <div className="picker-item faint">Ricerca…</div> : null}
          {!isFetching && options.length === 0 ? <div className="picker-item faint">Nessun risultato</div> : null}
          {options.map((o, i) => (
            <div
              key={o.id}
              role="option"
              aria-selected={i === active}
              aria-disabled={o.disabled}
              className="picker-item"
              style={o.disabled ? { opacity: 0.5 } : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span className="grow">
                {o.label}
                {o.sub ? <span className="faint"> · {o.sub}</span> : null}
              </span>
              {o.right ? <span className="faint">{o.right}</span> : null}
            </div>
          ))}
          {onCreate ? (
            <div
              role="option"
              aria-selected={active === options.length}
              className="picker-item"
              style={{ color: 'var(--accent)', fontWeight: 600, borderTop: '1px solid var(--border)' }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(options.length)}
              onClick={() => choose(options.length)}
            >
              + {createLabel ? createLabel(text) : 'Crea nuovo'}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
