'use client'

import { useEffect } from 'react'

/**
 * NUOVO — tabelle su smartphone (≤ 720 px): ogni riga mostra solo il nome (la prima cella con un link,
 * altrimenti la prima cella) con una freccia; toccando la riga o la freccia si aprono gli altri dati
 * come «etichetta: valore». Vale per tutte le tabelle `.table` dell'app, senza modificarle una per una:
 * aggiunge solo attributi data-* (React non li gestisce, quindi non vengono sovrascritti).
 * Una tabella può escludersi con data-mobile="off".
 */
const MOBILE = '(max-width: 720px)'

function enhance(root: ParentNode) {
  root.querySelectorAll<HTMLTableElement>('table.table').forEach((t) => {
    if (t.dataset.mobile === 'off') return
    const heads = Array.from(t.querySelectorAll(':scope > thead > tr:last-child > th')).map((th) => (th.textContent ?? '').trim())
    t.querySelectorAll<HTMLTableRowElement>(':scope > tbody > tr').forEach((tr) => {
      const tds = Array.from(tr.children).filter((c): c is HTMLTableCellElement => c.tagName === 'TD')
      // righe di servizio (messaggi, dettagli espansi su più colonne): restano come sono
      if (tds.length < 2 || tds.some((td) => td.colSpan > 1)) {
        delete tr.dataset.mrow
        return
      }
      let primary = tds.findIndex((td) => td.querySelector('a[href]') && !td.querySelector('a.btn'))
      if (primary < 0) primary = 0
      tds.forEach((td, i) => {
        if (td.dataset.label !== heads[i]) td.dataset.label = heads[i] ?? ''
        if (i === primary) td.dataset.mprimary = '1'
        else if (td.dataset.mprimary) delete td.dataset.mprimary
      })
      if (!tr.dataset.mrow) tr.dataset.mrow = '1'
    })
    if (!t.dataset.menhanced) t.dataset.menhanced = '1'
  })
}

export function MobileTables() {
  useEffect(() => {
    const mq = window.matchMedia(MOBILE)
    let frame = 0
    const run = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => enhance(document))
    }
    run()
    const obs = new MutationObserver(run)
    obs.observe(document.body, { childList: true, subtree: true })
    const onClick = (e: MouseEvent) => {
      if (!mq.matches) return
      const target = e.target as HTMLElement
      const tr = target.closest<HTMLTableRowElement>('tr[data-mrow]')
      if (!tr) return
      // link, pulsanti e campi funzionano come sempre (il nome apre la scheda)
      if (target.closest('a,button,input,select,textarea,label,summary')) return
      e.preventDefault()
      e.stopPropagation()
      if (tr.hasAttribute('data-mopen')) tr.removeAttribute('data-mopen')
      else tr.setAttribute('data-mopen', '')
    }
    document.addEventListener('click', onClick, true)
    return () => {
      obs.disconnect()
      cancelAnimationFrame(frame)
      document.removeEventListener('click', onClick, true)
    }
  }, [])
  return null
}
