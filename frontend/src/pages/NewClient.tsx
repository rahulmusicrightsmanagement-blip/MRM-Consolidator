import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, Check, CheckCircle2, CircleCheckBig, GitCompareArrows, Hash, Lock, UserRound, Users, XCircle } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, FileDrop } from '../components/ui'
import { api } from '../lib/api'
import { fmtDate, today } from '../lib/client'
import { useToast } from '../lib/toast'
import type { ClientDetail, ClientRef, ClientRow, RunPayload } from '../types'
import { hue, initials } from './Tracker'

const STEPS = ['Client details', 'Our master', 'Societies']

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
  'The LNV report – the central catalogue',
  'Pick societies and upload each report',
]

const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
const QUICK_DUE = [{ label: '1 week', days: 7 }, { label: '2 weeks', days: 14 }, { label: '1 month', days: 30 }]
const DEFAULT_EXTRA = ['PRS']

type Lane = { runId?: number; payload?: RunPayload; date: string; busy?: boolean; error?: string }

/** One society in step 3: report date, upload, the file check and what waits in its mapping. */
function SocietyLane({ code, name, lane, clientIpi, onDate, onFile, onOpen, disabled }: {
  code: string; name: string; lane: Lane; clientIpi: string; onDate: (d: string) => void; onFile: (f: File) => void; onOpen: () => void; disabled: boolean
}) {
  const p = lane.payload
  const file = p?.run.files[code.toLowerCase() as 'iprs' | 'prs'] ?? null
  const checks = (code === 'IPRS' ? p?.result.iprs?.checks : p?.result.prs?.checks) ?? []
  const failed = checks.filter((c) => !c.passed)
  const ir = code === 'IPRS' ? p?.result.iprs : null
  const works = ir ? ir.stats.works : p?.result.prs?.stats.works ?? 0
  const links = ir ? p?.result.mapping?.links ?? [] : []
  const count = (st: 'linked' | 'review' | 'unmatched') => links.filter((l) => l.state === st).length
  const otherWriter = !!ir?.client.ipi_name_no && !!clientIpi && ir.client.ipi_name_no.replace(/^0+/, '') !== clientIpi.replace(/^0+/, '')
  const state = lane.busy ? 'busy' : !file ? 'waiting' : failed.length || otherWriter ? 'warn' : 'good'
  return (
    <section className={`lane ${state}`}>
      <header className="lane-head">
        <span className="lane-code">{code}</span>
        <div className="grow"><b>{name}</b><small>{code === 'IPRS' ? 'Works report from IPRS' : `${code} works export`}</small></div>
        <span className={`lane-state ${state}`}>{state === 'busy' ? <><span className="spinner small-dark" />Checking…</> : state === 'waiting' ? 'Waiting for file'
          : state === 'warn' ? <><AlertTriangle size={13} />Needs a look</> : <><CircleCheckBig size={13} />Checked</>}</span>
      </header>
      {!file && (
        <label className="field date-field">Report date
          <span className="field-box"><CalendarDays size={16} /><input type="date" value={lane.date} disabled={lane.busy} onChange={(e) => onDate(e.target.value)} /></span>
        </label>
      )}
      <FileDrop title={`Upload the ${code} report (.xlsx / .csv)`} hint={lane.busy ? 'Matching against our master – this can take a few seconds' : `Drag the ${code} file here or click to choose`}
        accept=".xlsx,.xlsm,.csv" fileName={file?.name ?? null} busy={lane.busy} onFile={onFile} compact />
      {lane.error && <div className="alert bad small">{lane.error}</div>}
      {file && p && (
        <>
          <div className={`check-banner ${failed.length ? 'warn' : 'good'}`}>{failed.length ? <AlertTriangle size={18} /> : <CircleCheckBig size={18} />}
            <div><b>{failed.length ? `${failed.length} of ${checks.length} header checks need a look` : `All ${checks.length} header checks passed`}</b>
              <span>{works.toLocaleString()} works{ir?.client.name && <> · report for <b>{ir.client.name}</b>{ir.client.ipi_name_no && <> (IPI {ir.client.ipi_name_no})</>}</>}</span></div></div>
          {otherWriter && (
            <div className="check-banner bad"><AlertTriangle size={18} /><div><b>This report may belong to someone else</b>
              <span>Its IPI {ir!.client.ipi_name_no} differs from the client's IPI {clientIpi}. Replace the file if it is the wrong one.</span></div></div>
          )}
          {failed.length > 0 && <ul className="checks compact">{failed.map((c) => <li key={c.label} className="fail"><XCircle size={16} /><div><strong>{c.label}</strong><span className="small muted">{c.detail}</span></div></li>)}</ul>}
          <div className="lane-foot">
            {ir ? (
              <div className="next-figs">
                <div className="good"><b>{count('linked').toLocaleString()}</b><span>linked to master</span></div>
                <div className={count('review') ? 'brand' : ''}><b>{count('review').toLocaleString()}</b><span>need your decision</span></div>
                <div className={count('unmatched') ? 'warn' : ''}><b>{count('unmatched').toLocaleString()}</b><span>not in master</span></div>
              </div>
            ) : <span className="small muted grow">Matched against our master in the {code} workspace.</span>}
            <Button size="sm" disabled={disabled} onClick={onOpen}>Open {code} mapping<ArrowRight size={14} /></Button>
          </div>
        </>
      )}
    </section>
  )
}

/** Add a client in one go: details → our master → each society's report, then straight on to mapping.
 *  Each step is saved at once and the client id is kept in the address, so a reload resumes where it stopped. */
export default function NewClient() {
  const navigate = useNavigate()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [step, setStep] = useState(1)
  const [client, setClient] = useState<ClientRef | null>(null)
  const [detail, setDetail] = useState<ClientDetail | null>(null)
  const [form, setForm] = useState({ name: '', ipi: '', owner: '', due_date: '', home_society: 'IPRS' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [extra, setExtra] = useState<string[]>(DEFAULT_EXTRA)
  const [lanes, setLanes] = useState<Record<string, Lane>>({})
  const lane = (code: string): Lane => lanes[code] ?? { date: today() }
  const setLane = (code: string, patch: Partial<Lane>) => setLanes((ls) => ({ ...ls, [code]: { ...(ls[code] ?? { date: today() }), ...patch } }))
  const [existing, setExisting] = useState<ClientRow[]>([])
  const [resuming, setResuming] = useState(!!params.get('client'))
  useEffect(() => { api.clients().then((d) => setExisting(d.clients)).catch(() => {}) }, [])

  // Reopened (or reloaded) half-way: load the saved client and jump to the first unfinished step.
  useEffect(() => {
    const id = Number(params.get('client'))
    if (!id || client) { setResuming(false); return }
    api.client(id).then(async (d) => {
      setClient(d.client); setDetail(d)
      setForm({ name: d.client.name, ipi: d.client.ipi ?? '', owner: d.client.owner ?? '', due_date: d.client.due_date ?? '', home_society: d.client.home_society })
      const added = d.societies.map((x) => x.code).filter((c) => c !== 'IPRS')
      if (added.length) setExtra(added)
      const loaded = await Promise.all(d.societies.filter((x) => x.report).map(async (x) => [x.code, { runId: x.report!.id, payload: await api.run(x.report!.id), date: x.report!.report_date ?? today() }] as const))
      setLanes(Object.fromEntries(loaded))
      setStep(d.master ? 3 : 2)
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

  const uploadMaster = async (file: File) => {
    setError(null); setBusy(true)
    try {
      setDetail(await api.uploadMaster(client!.id, file))
      toast('Master loaded', 'good')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const chosen = ['IPRS', ...extra]
  const added = new Set(detail?.societies.map((x) => x.code))

  /** Add the chosen societies once, so the client page shows them even if the user stops here. */
  const adding = useRef<Promise<void> | null>(null)
  const ensureSocieties = () => {
    const add = chosen.filter((c) => !added.has(c))
    if (!add.length) return Promise.resolve()
    // Two reports dropped together share one request instead of adding the societies twice.
    adding.current ??= api.addSocieties(client!.id, add).then(setDetail).finally(() => { adding.current = null })
    return adding.current
  }

  /** Each society's report uploads on its own, so IPRS and PRS can be dropped at the same time. */
  const uploadReport = async (code: string, file: File) => {
    setLane(code, { busy: true, error: undefined })
    try {
      await ensureSocieties()
      const id = lane(code).runId ?? (await api.startReport(client!.id, code, lane(code).date)).id
      setLane(code, { runId: id })
      setLane(code, { payload: await api.upload(id, 'auto', file), busy: false })
    } catch (e) { setLane(code, { error: (e as Error).message, busy: false }) }
  }

  const openMapping = async (code: string) => {
    const l = lane(code)
    setBusy(true)
    try {
      await api.updateRun(l.runId!, { confirmed_step: Math.max(l.payload?.run.confirmed_step ?? 0, 1) })
      navigate(`/clients/${client!.id}/societies/${code}?report=${l.runId}&step=2`)
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  const later = async () => {
    setBusy(true)
    try { await ensureSocieties(); navigate(`/clients/${client!.id}`) }
    catch (e) { setError((e as Error).message); setBusy(false) }
  }

  const m = detail?.master
  const name = form.name.trim()
  /** Steps 1–3 open once the step before them is saved: the client, then its master. */
  const reachable = (n: number) => n === 1 || (n === 2 && !!client) || (n === 3 && !!client && !!m)
  const go = (n: number) => { if (reachable(n)) { setError(null); setStep(n) } }
  const fileOf = (code: string) => lane(code).payload?.run.files[code.toLowerCase() as 'iprs' | 'prs'] ?? null
  const optional = (detail?.available_societies ?? []).filter((x) => x.code !== 'IPRS')
  const uploadedAll = chosen.every((c) => fileOf(c))

  if (resuming) return <AppShell trail={<span className="trail-name">Add client</span>}><div className="loading"><span className="spinner" />Loading…</div></AppShell>

  return (
    <AppShell trail={<span className="trail-name">Add client</span>}>
      <header className="page-header">
        <div><div className="eyebrow">New client</div><h1>Add a client</h1>
          <p className="lede">Three steps from a new client to mapping. Every step is saved as you go – you can leave and pick it up later.</p></div>
      </header>

      <div className="wizard">
        <nav className="wizard-rail" aria-label="Steps">
          <ol>
            {STEPS.map((label, i) => {
              const n = i + 1
              const done = n === 1 ? !!client : n === 2 ? !!m : uploadedAll
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
            <li className="rail-next"><span className="rail-dot"><GitCompareArrows size={14} /></span>
              <span><b>Match & review</b><small>One workspace per society</small></span></li>
          </ol>
        </nav>

        <div className="wizard-main">
          {step === 1 && (
            <form className="card wizard-card" onSubmit={saveDetails} noValidate>
              <div className="wizard-head"><span className="wizard-step">Step 1 of 3</span><h2>Who is the client?</h2>
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
              <div className="wizard-head"><span className="wizard-step">Step 2 of 3</span><h2>Upload our master</h2>
                <p className="muted">The client's master (LNV report) becomes the central catalogue: every society is compared against it. You can replace it later from the client page.</p></div>
              <FileDrop title="Upload our master (.xlsx)" hint="Drag the LNV report here or click to choose" accept=".xlsx,.xlsm"
                fileName={m?.name ?? null} busy={busy} onFile={uploadMaster} />
              {error && <div className="alert bad small">{error}</div>}
              {m ? (
                <>
                  <div className="check-banner good"><CircleCheckBig size={20} />
                    <div><b>Master read – {m.stats.songs?.toLocaleString()} songs</b>
                      <span>{m.stats.with_credits?.toLocaleString()} with writers filled in · {m.stats.columns} columns
                        {m.stats.societies?.length ? ` · ${m.stats.societies.length} society blocks` : ''}</span></div></div>
                  {!!m.stats.issues && (
                    <div className="check-banner warn"><AlertTriangle size={20} />
                      <div><b>{m.stats.issues} problems found inside the master</b>
                        <span>Nothing to do now – they are listed in each society's workspace.</span></div></div>
                  )}
                </>
              ) : (
                <ul className="wizard-tips">
                  <li><CheckCircle2 size={15} />Use the full export – every song with its writers and society columns.</li>
                  <li><CheckCircle2 size={15} />The file is checked right away; nothing is compared until a society report is added.</li>
                </ul>
              )}
              <div className="wizard-actions">
                <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => go(1)}>Back</Button>
                <Button variant="primary" disabled={!m || busy} onClick={() => go(3)}>Continue to societies<ArrowRight size={15} /></Button>
              </div>
            </section>
          )}

          {step === 3 && client && (
            <section className="card wizard-card">
              <div className="wizard-head"><span className="wizard-step">Step 3 of 3</span><h2>Societies and their reports</h2>
                <p className="muted">Pick the societies to reconcile and upload each one's report. Each file is checked at once and matched against our master; every society then gets its own mapping screen.</p></div>

              <fieldset className="wizard-section">
                <legend>Societies for this client</legend>
                <div className="soc-toggles">
                  <span className="soc-toggle on locked"><span className="soc-check"><Check size={14} /></span><span><b>IPRS</b><small>Home society · always included</small></span></span>
                  {optional.map((x) => {
                    const on = extra.includes(x.code)
                    const fixed = added.has(x.code)
                    return (
                      <button key={x.code} type="button" disabled={!x.available || fixed} className={`soc-toggle ${on ? 'on' : ''} ${fixed ? 'locked' : ''}`} aria-pressed={on}
                        onClick={() => setExtra(on ? extra.filter((c) => c !== x.code) : [...extra, x.code])}>
                        <span className="soc-check">{on ? <Check size={14} /> : null}</span>
                        <span><b>{x.code}</b><small>{!x.available ? 'Coming soon' : fixed ? `${x.country} · added` : x.country}</small></span>
                      </button>
                    )
                  })}
                </div>
              </fieldset>

              <div className="lanes">
                {chosen.map((code) => <SocietyLane key={code} code={code} name={detail?.available_societies.find((x) => x.code === code)?.name ?? code}
                  lane={lane(code)} clientIpi={ipi} onDate={(d) => setLane(code, { date: d })} onFile={(f) => uploadReport(code, f)}
                  onOpen={() => openMapping(code)} disabled={busy} />)}
              </div>
              {error && <div className="alert bad small">{error}</div>}

              <div className="wizard-actions">
                <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => go(2)}>Back</Button>
                <Button variant={fileOf('IPRS') ? 'ghost' : 'default'} className="later" disabled={busy} onClick={later}>
                  {uploadedAll ? 'Open client page' : 'Finish later – open client page'}</Button>
                <Button variant="primary" disabled={!fileOf('IPRS') || busy} onClick={() => openMapping('IPRS')}>
                  {busy ? <span className="spinner small" /> : null}Start with IPRS mapping<ArrowRight size={15} /></Button>
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
            <div><dt>Master</dt><dd className={m ? '' : 'muted'}>{m ? `${m.stats.songs?.toLocaleString()} songs` : 'Not uploaded'}</dd></div>
            {chosen.map((code) => {
              const works = code === 'IPRS' ? lane(code).payload?.result.iprs?.stats.works : lane(code).payload?.result.prs?.stats.works
              return <div key={code}><dt>{code} report</dt><dd className={fileOf(code) ? '' : 'muted'}>{fileOf(code) ? `${(works ?? 0).toLocaleString()} works` : 'Not uploaded'}</dd></div>
            })}
          </dl>
        </aside>
      </div>
    </AppShell>
  )
}
