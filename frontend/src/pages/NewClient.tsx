import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, Check, Hash, ListChecks, Lock, UserRound, Users } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button } from '../components/ui'
import { api } from '../lib/api'
import { fmtDate, today } from '../lib/client'
import type { ClientDetail, ClientRef, ClientRow, DspInfo } from '../types'
import { FileCard } from './client/Consolidate'
import { hue, initials } from './Tracker'

const STEPS = ['Client details', 'The files']

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

const STEP_INFO = [
  'Name, IPI number, owner and due date',
  'LNV, Muso export and IPRS report',
]

const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
const QUICK_DUE = [{ label: '1 week', days: 7 }, { label: '2 weeks', days: 14 }, { label: '1 month', days: 30 }]

type Slot = 'lnv' | 'dsp' | 'iprs'
const dspText = (d: DspInfo) => `${d.source} · ${(d.stats.rows ?? 0).toLocaleString()} rows`

/** Add a client in one go: details → the three files (LNV, DSP export, IPRS report), then straight on to the consolidate steps.
 *  Each step is saved at once and the client id is kept in the address, so a reload resumes where it stopped. */
export default function NewClient() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [step, setStep] = useState(1)
  const [client, setClient] = useState<ClientRef | null>(null)
  const [detail, setDetail] = useState<ClientDetail | null>(null)
  const [form, setForm] = useState({ name: '', ipi: '', owner: '', due_date: '', home_society: 'IPRS' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [slots, setSlots] = useState<Partial<Record<Slot, { busy?: boolean; error?: string; name?: string; text?: string }>>>({})
  const setSlot = (k: Slot, v: { busy?: boolean; error?: string; name?: string; text?: string }) => setSlots((x) => ({ ...x, [k]: { ...x[k], ...v } }))
  const [existing, setExisting] = useState<ClientRow[]>([])
  const [resuming, setResuming] = useState(!!params.get('client'))
  useEffect(() => { api.clients().then((d) => setExisting(d.clients)).catch(() => {}) }, [])

  /** What each file box shows, from the client as saved. */
  const fromDetail = (d: ClientDetail) => {
    const iprs = d.societies.find((x) => x.code === 'IPRS')?.report
    setSlots((x) => ({
      ...x,
      lnv: d.master ? { name: d.master.name, text: `${(d.master.stats.songs ?? 0).toLocaleString()} songs` } : x.lnv,
      dsp: d.clean ? { name: d.clean.name, text: dspText(d.clean) } : x.dsp,
      iprs: iprs ? { name: `IPRS report ${fmtDate(iprs.report_date)}`, text: 'Report added' } : x.iprs,
    }))
  }

  // Reopened (or reloaded) half-way: load the saved client and jump to the first unfinished step.
  useEffect(() => {
    const id = Number(params.get('client'))
    if (!id || client) { setResuming(false); return }
    api.client(id).then((d) => {
      setClient(d.client); setDetail(d); fromDetail(d)
      setForm({ name: d.client.name, ipi: d.client.ipi ?? '', owner: d.client.owner ?? '', due_date: d.client.due_date ?? '', home_society: d.client.home_society })
      setStep(2)
    }).catch(() => setParams({}, { replace: true })).finally(() => setResuming(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const ipi = form.ipi.replace(/\s/g, '')
  const ipiProblem = ipi && !/^\d+$/.test(ipi) ? 'Only digits – an IPI name number has no letters.'
    : ipi && (ipi.length < 9 || ipi.length > 11) ? `IPI name numbers have 9–11 digits; this has ${ipi.length}.` : null
  const others = existing.filter((c) => c.id !== client?.id)
  const sameIpi = ipi ? others.find((c) => c.ipi && c.ipi.replace(/^0+/, '') === ipi.replace(/^0+/, '')) : undefined
  const sameName = form.name.trim() ? others.find((c) => c.name.trim().toLowerCase() === form.name.trim().toLowerCase()) : undefined
  const duplicate = sameIpi ?? sameName
  const owners = [...new Set(existing.map((c) => c.owner).filter(Boolean))]

  const saveDetails = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!form.name.trim() || busy) return
    setError(null); setBusy(true)
    try {
      const c = client
        ? (await api.updateClient(client.id, { name: form.name.trim(), owner: form.owner, due_date: form.due_date || null })).client
        : await api.createClient({ ...form, name: form.name.trim(), ipi, due_date: form.due_date || null })
      setClient(c)
      setParams({ client: String(c.id) }, { replace: true })
      setStep(2)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  /** The LNV goes first: the export and the IPRS report are matched against it, so they wait for it. */
  const master = useRef<Promise<unknown> | null>(null)
  const upload = async (slot: Slot, file: File) => {
    setSlot(slot, { busy: true, error: undefined, name: file.name })
    try {
      if (slot === 'lnv') {
        master.current = api.uploadMaster(client!.id, file)
        const d = await master.current as ClientDetail
        setDetail(d); setSlot('lnv', { text: `${(d.master?.stats.songs ?? 0).toLocaleString()} songs` })
      } else {
        await master.current
        if (slot === 'dsp') {
          const r = await api.uploadDsp(client!.id, file)
          setSlot('dsp', { text: r.dsp ? dspText(r.dsp) : 'Read' })
        } else {
          if (!detail?.societies.some((x) => x.code === 'IPRS')) setDetail(await api.addSocieties(client!.id, ['IPRS']))
          const run = detail?.societies.find((x) => x.code === 'IPRS')?.report?.id ?? (await api.startReport(client!.id, 'IPRS', today())).id
          const r = await api.upload(run, 'iprs', file)
          setSlot('iprs', { text: `${(r.result.iprs?.stats.works ?? 0).toLocaleString()} works` })
          setDetail(await api.client(client!.id))
        }
      }
      setSlot(slot, { busy: false })
    } catch (e) { setSlot(slot, { busy: false, error: (e as Error).message, name: undefined }) }
  }

  const name = form.name.trim()
  const reachable = (n: number) => n === 1 || (n === 2 && !!client)
  const go = (n: number) => { if (reachable(n)) { setError(null); setStep(n) } }
  const has = (k: Slot) => !!slots[k]?.text && !slots[k]?.busy
  const anyBusy = (['lnv', 'dsp', 'iprs'] as Slot[]).some((k) => slots[k]?.busy)

  if (resuming) return <AppShell trail={<span className="trail-name">Add client</span>}><div className="loading"><span className="spinner" />Loading…</div></AppShell>

  return (
    <AppShell trail={<span className="trail-name">Add client</span>}>
      <header className="page-header">
        <div><div className="eyebrow">New client</div><h1>Add a client</h1>
          <p className="lede">Two steps: who the client is, then their files. Every step is saved as you go – you can leave and pick it up later.</p></div>
      </header>

      <div className="wizard">
        <nav className="wizard-rail" aria-label="Steps">
          <ol>
            {STEPS.map((label, i) => {
              const n = i + 1
              const done = n === 1 ? !!client : has('lnv') && (has('dsp') || has('iprs'))
              const open = reachable(n)
              return (
                <li key={label} className={`${done ? 'done' : ''} ${n === step ? 'current' : ''}`}>
                  <button type="button" disabled={!open} onClick={() => go(n)} aria-current={n === step ? 'step' : undefined}>
                    <span className="rail-dot">{done ? <Check size={14} /> : open ? n : <Lock size={12} />}</span>
                    <span><b>{label}</b><small>{STEP_INFO[i]}</small></span>
                  </button>
                </li>
              )
            })}
            <li className="rail-next"><span className="rail-dot"><ListChecks size={14} /></span>
              <span><b>Then</b><small>Muso & LNV · LNV vs IPRS · the final LNV</small></span></li>
          </ol>
        </nav>

        <div className="wizard-main">
          {step === 1 && (
            <form className="card wizard-card" onSubmit={saveDetails} noValidate>
              <div className="wizard-head"><span className="wizard-step">Step 1 of 2</span><h2>Who is the client?</h2>
                <p className="muted">The IPI name number is used to check that every IPRS report you upload belongs to this client.</p></div>

              <fieldset className="wizard-section">
                <label className="field">Client name <em>required</em>
                  <span className="field-box"><UserRound size={16} />
                    <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Dhanya Suresh" autoFocus required /></span>
                </label>
                <label className="field">IPI name number
                  <span className="field-box"><Hash size={16} />
                    <input className="mono" inputMode="numeric" value={form.ipi} onChange={(e) => setForm({ ...form, ipi: e.target.value })}
                      placeholder="e.g. 01076531558" disabled={!!client} aria-invalid={!!ipiProblem} /></span>
                  {ipiProblem ? <span className="field-hint warn">{ipiProblem}</span>
                    : <span className="field-hint">{client ? 'Fixed once the client is created.' : 'Optional, but recommended – reports from another writer are then caught.'}</span>}
                </label>
                {duplicate && (
                  <div className="dup-warn" role="status"><AlertTriangle size={16} />
                    <span>{sameIpi ? 'A client with this IPI already exists' : 'A client with this name already exists'}: <b>{duplicate.name}</b>
                      {duplicate.ipi && <> · IPI {duplicate.ipi}</>}</span>
                    <Button size="sm" onClick={() => navigate(`/clients/${duplicate.id}`)}>Open it<ArrowRight size={13} /></Button>
                  </div>
                )}
              </fieldset>

              <fieldset className="wizard-section two">
                <legend>Who handles it</legend>
                <label className="field">Owner
                  <span className="field-box"><Users size={16} />
                    <input list="owner-list" value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="Team member" /></span>
                  <datalist id="owner-list">{owners.map((o) => <option key={o} value={o} />)}</datalist>
                </label>
                <label className="field">Due date
                  <span className="field-box"><CalendarDays size={16} />
                    <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></span>
                  <span className="quick-picks">
                    {QUICK_DUE.map((q) => {
                      const v = addDays(q.days)
                      return <button key={q.label} type="button" className={form.due_date === v ? 'on' : ''} onClick={() => setForm({ ...form, due_date: v })}>{q.label}</button>
                    })}
                    {form.due_date && <button type="button" className="clear" onClick={() => setForm({ ...form, due_date: '' })}>Clear</button>}
                  </span>
                </label>
              </fieldset>

              {error && <div className="alert bad small">{error}</div>}
              <div className="wizard-actions">
                <Button variant="ghost" onClick={() => navigate('/')}>Cancel</Button>
                <span className="muted small kbd-hint">Press <kbd className="kbd">Enter</kbd> to continue</span>
                <button type="submit" className="btn primary" disabled={!name || busy}>
                  {busy ? <span className="spinner small" /> : null}{client ? 'Save and continue' : 'Create and continue'}<ArrowRight size={15} /></button>
              </div>
            </form>
          )}

          {step === 2 && client && (
            <section className="card wizard-card">
              <div className="wizard-head"><span className="wizard-step">Step 2 of 2</span><h2>The client's files</h2>
                <p className="muted">Drop the three files on their boxes – all at once is fine. The LNV is read first; the other two are matched against it.</p></div>
              <div className="sc-files wizard-files">
                <FileCard tone="lnv" label="LNV" what="The client's LNV report (.xlsx)" file={slots.lnv?.name} text={slots.lnv?.text} busy={slots.lnv?.busy}
                  onFile={(f) => upload('lnv', f)} accept=".xlsx,.xlsm" />
                <FileCard tone="dsp" label="Muso" what="Muso, Spotify or Apple Music export from MRM-Extractor" file={slots.dsp?.name} text={slots.dsp?.text}
                  busy={slots.dsp?.busy} onFile={(f) => upload('dsp', f)} disabled={!slots.lnv?.name} accept=".xlsx" />
                <FileCard tone="iprs" label="IPRS" what="The client's IPRS works report" file={slots.iprs?.name} text={slots.iprs?.text}
                  busy={slots.iprs?.busy} onFile={(f) => upload('iprs', f)} disabled={!slots.lnv?.name} accept=".xlsx,.xlsm,.csv" />
              </div>
              {(['lnv', 'dsp', 'iprs'] as Slot[]).map((k) => slots[k]?.error && <div key={k} className="alert bad small"><b>{k === 'lnv' ? 'LNV' : k === 'dsp' ? 'Export' : 'IPRS'}:</b> {slots[k]!.error}</div>)}
              <div className="wizard-actions">
                <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => go(1)}>Back</Button>
                <Button className="later" disabled={anyBusy} onClick={() => navigate(`/clients/${client.id}`)}>Finish later</Button>
                <Button variant="primary" disabled={!has('lnv') || anyBusy} onClick={() => navigate(`/clients/${client.id}/consolidate?step=2`)}>
                  {anyBusy ? <span className="spinner small" /> : null}Start: Muso & LNV<ArrowRight size={15} /></Button>
              </div>
            </section>
          )}
        </div>

        <aside className="wizard-preview" aria-label="Preview">
          <span className="preview-label">Preview</span>
          <div className="preview-id">
            <span className="client-avatar" style={{ '--h': hue(name || '?') } as CSSProperties}>{name ? initials(name) : <UserRound size={16} />}</span>
            <div><strong className={name ? '' : 'muted'}>{name || 'New client'}</strong>
              <span className="mono small muted block">IPI {ipi || '—'}</span></div>
          </div>
          <dl className="preview-list">
            <div><dt>Owner</dt><dd className={form.owner ? '' : 'muted'}>{form.owner || 'Unassigned'}</dd></div>
            <div><dt>Due</dt><dd className={form.due_date ? '' : 'muted'}>{form.due_date ? fmtDate(form.due_date) : 'No date'}</dd></div>
            <div><dt>LNV</dt><dd className={has('lnv') ? '' : 'muted'}>{has('lnv') ? slots.lnv!.text : 'Not added'}</dd></div>
            <div><dt>Export</dt><dd className={has('dsp') ? '' : 'muted'}>{has('dsp') ? slots.dsp!.text : 'Not added'}</dd></div>
            <div><dt>IPRS</dt><dd className={has('iprs') ? '' : 'muted'}>{has('iprs') ? slots.iprs!.text : 'Not added'}</dd></div>
          </dl>
        </aside>
      </div>
    </AppShell>
  )
}
