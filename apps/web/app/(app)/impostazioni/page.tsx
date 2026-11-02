'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useCan, useMe } from '@/lib/session'
import { PageHead } from '@/components/AppShell'
import { errorMessage, Field, fieldErrors, useToast } from '@/components/ui'

export default function SettingsPage() {
  const { data: me } = useMe()
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const [company, setCompany] = useState(me?.company?.name ?? '')
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [newCompany, setNewCompany] = useState('')
  return (
    <>
      <PageHead title="Impostazioni" />
      <div className="stack loose" style={{ maxWidth: 720 }}>
        <div className="card">
          <div className="card-head">
            <h2>Convenzioni di calcolo</h2>
          </div>
          <div className="card-body stack small">
            <p>Valuta: euro. Tutti i prezzi, le tariffe e i costi sono intesi al netto dell’IVA, come inseriti.</p>
            <p>Numeri in formato italiano: virgola per i decimali, punto per le migliaia (es. 1.250,50).</p>
            <p>Il “Costo di produzione” somma ingredienti, energia e manodopera configurati; non comprende costi generali, ammortamenti o margini.</p>
          </div>
        </div>
        {can('users.manage') ? (
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault()
              try {
                await api.patch('/companies/current', { name: company })
                await qc.invalidateQueries({ queryKey: ['me'] })
                toast('Nome azienda aggiornato.')
              } catch (err) {
                toast(errorMessage(err), 'err')
              }
            }}
          >
            <div className="card-head">
              <h2>Azienda</h2>
            </div>
            <div className="card-body row">
              <input className="input grow" value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Nome azienda" />
              <button className="btn primary">Salva</button>
            </div>
          </form>
        ) : null}
        <form
          className="card"
          onSubmit={async (e) => {
            e.preventDefault()
            setErrors({})
            try {
              await api.post('/auth/password/change', pw)
              setPw({ currentPassword: '', newPassword: '' })
              toast('Password aggiornata; le altre sessioni sono state chiuse.')
            } catch (err) {
              setErrors(fieldErrors(err))
              toast(errorMessage(err), 'err')
            }
          }}
        >
          <div className="card-head">
            <h2>Cambia password</h2>
          </div>
          <div className="card-body stack">
            <div className="grid-2">
              <Field label="Password attuale" htmlFor="pw-c" error={errors.currentPassword}>
                <input id="pw-c" className="input" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
              </Field>
              <Field label="Nuova password" htmlFor="pw-n" hint="Almeno 10 caratteri" error={errors.newPassword}>
                <input id="pw-n" className="input" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
              </Field>
            </div>
            <div>
              <button className="btn primary">Aggiorna password</button>
            </div>
          </div>
        </form>
        {me?.user?.isPlatformAdmin ? (
          <form
            className="card"
            onSubmit={async (e) => {
              e.preventDefault()
              try {
                await api.post('/companies', { name: newCompany })
                setNewCompany('')
                await qc.invalidateQueries({ queryKey: ['me'] })
                toast('Azienda creata: la trovi nel selettore in alto.')
              } catch (err) {
                toast(errorMessage(err), 'err')
              }
            }}
          >
            <div className="card-head">
              <h2>Nuova azienda cliente</h2>
              <span className="faint small">amministrazione piattaforma</span>
            </div>
            <div className="card-body row">
              <input className="input grow" placeholder="Ragione sociale" value={newCompany} onChange={(e) => setNewCompany(e.target.value)} aria-label="Nome nuova azienda" />
              <button className="btn primary">Crea</button>
            </div>
          </form>
        ) : null}
      </div>
    </>
  )
}
