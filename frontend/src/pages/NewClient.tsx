import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Check, Hash, Lock, UserRound } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button } from '../components/ui'
import { api } from '../lib/api'
import type { ClientRow } from '../types'

export function Stepper({ steps, current, confirmed, onPick }: { steps: string[]; current: number; confirmed: number; onPick?: (n: number) => void }) {
  return (
    <ol className="stepper">
      {steps.map((label, i) => {
        const n = i + 1
        const done = n <= confirmed
        const reachable = n <= confirmed + 1
        return (
          <li key={label} className={`${done ? 'done' : ''} ${n === current ? 'current' : ''}`}>
            <button type="button" disabled={!reachable || !onPick} onClick={() => onPick?.(n)}>
              <span className="stepper-dot">{done ? <Check size={13} /> : reachable ? n : <Lock size={11} />}</span>
              <span className="stepper-text"><small>Step {n}</small><b>{label}</b></span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/** Add a client: a name is enough. The files go on the client's own page, the first step of its flow. */
export default function NewClient() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [ipiText, setIpi] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [existing, setExisting] = useState<ClientRow[]>([])
  useEffect(() => { api.clients().then((d) => setExisting(d.clients)).catch(() => {}) }, [])

  const ipi = ipiText.replace(/\s/g, '')
  const ipiProblem = ipi && !/^\d+$/.test(ipi) ? 'Only digits: an IPI name number has no letters.'
    : ipi && (ipi.length < 9 || ipi.length > 11) ? `IPI name numbers have 9 to 11 digits; this has ${ipi.length}.` : null
  const sameIpi = ipi ? existing.find((c) => c.ipi && c.ipi.replace(/^0+/, '') === ipi.replace(/^0+/, '')) : undefined
  const sameName = name.trim() ? existing.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase()) : undefined
  const duplicate = sameIpi ?? sameName

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setError(null); setBusy(true)
    try {
      const c = await api.createClient({ name: name.trim(), ipi, home_society: 'IPRS' })
      navigate(`/clients/${c.id}?step=1`)
    } catch (err) { setError((err as Error).message); setBusy(false) }
  }

  return (
    <AppShell trail="Add client">
      <form className="card new-client" onSubmit={create} noValidate>
        <h1>Add a client</h1>
        <p className="muted">Next you upload the client's LNV report and Muso export.</p>
        <label className="field">Client name
          <span className="field-box"><UserRound size={16} /><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mithun Naresh Sharma" autoFocus required /></span>
        </label>
        <label className="field">IPI name number <em>optional</em>
          <span className="field-box"><Hash size={16} /><input className="mono" inputMode="numeric" value={ipiText} onChange={(e) => setIpi(e.target.value)} placeholder="e.g. 01076531558" aria-invalid={!!ipiProblem} /></span>
          {ipiProblem ? <span className="field-hint warn">{ipiProblem}</span> : <span className="field-hint">Catches an IPRS report that belongs to another writer.</span>}
        </label>
        {duplicate && (
          <div className="dup-warn" role="status"><AlertTriangle size={16} />
            <span>{sameIpi ? 'A client with this IPI already exists' : 'A client with this name already exists'}: <b>{duplicate.name}</b></span>
            <Button size="sm" type="button" onClick={() => navigate(`/clients/${duplicate.id}`)}>Open it<ArrowRight size={13} /></Button>
          </div>
        )}
        {error && <div className="alert bad">{error}</div>}
        <div className="form-actions"><Button variant="primary" type="submit" disabled={!name.trim() || !!ipiProblem || busy}>{busy ? 'Adding…' : 'Add client'}<ArrowRight size={15} /></Button></div>
      </form>
    </AppShell>
  )
}
