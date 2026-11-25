'use client'

/** NUOVO — Domande frequenti, con ricerca e sezioni. */
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { PageHead } from '@/components/AppShell'
import { Icon } from '@/components/ui'
import { FAQ, FAQ_AREAS } from '@/lib/faq'

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export default function FaqPage() {
  const [q, setQ] = useState('')
  const [area, setArea] = useState('')
  const list = useMemo(() => {
    const words = norm(q).split(/\s+/).filter((w) => w.length > 1)
    return FAQ.filter((f) => (!area || f.area === area) && words.every((w) => norm(f.q + ' ' + f.a.join(' ')).includes(w)))
  }, [q, area])
  const sections = Object.entries(FAQ_AREAS).filter(([k]) => list.some((f) => f.area === k))
  return (
    <>
      <PageHead
        title="Domande frequenti"
        sub="Le risposte alle domande più comuni su Ricetta Quadra."
        actions={
          <Link className="btn" href="/assistenza">
            <Icon name="lifebuoy" /> Assistenza
          </Link>
        }
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body stack">
          <div className="input-group">
            <input className="input" type="search" placeholder="Cerca, es. bolletta, peso, fattura, password…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cerca nelle domande frequenti" />
            <span className="addon">
              <Icon name="search" size={14} />
            </span>
          </div>
          <div className="chips" role="group" aria-label="Sezioni">
            <button type="button" className="chip" aria-pressed={area === ''} onClick={() => setArea('')}>
              Tutte
            </button>
            {Object.entries(FAQ_AREAS).map(([k, label]) => (
              <button key={k} type="button" className="chip" aria-pressed={area === k} onClick={() => setArea(area === k ? '' : k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="card">
          <div className="card-body stack">
            <p style={{ margin: 0 }}>Nessuna domanda trovata per «{q}».</p>
            <Link className="btn primary" href="/assistenza" style={{ alignSelf: 'flex-start' }}>
              Scrivi all’assistenza
            </Link>
          </div>
        </div>
      ) : (
        <div className="stack loose">
          {sections.map(([k, label]) => (
            <section key={k} className="card">
              <div className="card-head">
                <h2>{label}</h2>
              </div>
              <div className="faq-list">
                {list
                  .filter((f) => f.area === k)
                  .map((f) => (
                    <details key={f.id} className="faq" open={q.trim().length > 2}>
                      <summary>{f.q}</summary>
                      {f.a.map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                    </details>
                  ))}
              </div>
            </section>
          ))}
          <p className="muted small">
            Non hai trovato la risposta?{' '}
            <Link className="link" href="/assistenza">
              Scrivi all’assistenza o chiamaci
            </Link>
            .
          </p>
        </div>
      )}
    </>
  )
}
