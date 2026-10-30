import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, Download, ListChecks, UploadCloud } from 'lucide-react'
import { Button } from '../../components/ui'
import { api } from '../../lib/api'
import { today, useClient } from '../../lib/client'
import { useToast } from '../../lib/toast'
import type { Step1, Step3, StepsPayload } from '../../types'
import IprsReview from './IprsReview'
import SongReview, { useStored } from './SongReview'
import { n } from './Block'

/** The consolidate flow, one step after the other (the MRM flowchart):
 *    1 Muso & LNV  – one case per song: its DSP versions and the LNV rows that may be it, answered together
 *    2 LNV ↔ IPRS  – each LNV song against the IPRS report: to check · amend · register · only at IPRS
 *  Every case is a block of records shown one below another with every field side by side; differing cells are
 *  marked. The app's answer is already applied – the reviewer only clicks where it is wrong. */


/* ---------- the page ---------- */

const STEPS = [
  { n: 1, api: 0, title: 'Files', what: 'The LNV, the Muso export, the IPRS report' },
  { n: 2, api: 1, title: 'Muso & LNV', what: 'Each song: its versions and its LNV row' },
  { n: 3, api: 3, title: 'LNV vs IPRS', what: 'Registered, to amend, to register' },
  { n: 4, api: 0, title: 'Final LNV', what: 'Everything written into the LNV' },
]

export default function Consolidate() {
  const { clientId, detail, refresh } = useClient()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  // a client opens at the step it is at
  const step = Math.min(4, Math.max(1, Number(params.get('step')) || detail?.journey.step || 1))
  const [data, setData] = useState<StepsPayload | null>(null)
  const [loaded, setLoaded] = useState(0)   // the step data.step belongs to
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(0)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const want = useRef(step)
  want.current = step
  // the step a client opens at is kept in the address: it does not jump when a file or an answer moves the client on
  useEffect(() => { if (!params.get('step')) setParams({ step: String(step) }, { replace: true }) }, [params, step, setParams])

  const load = useCallback(async (s = want.current) => {
    try {
      const d = await api.steps(clientId, STEPS[s - 1].api)
      if (s === want.current) { setData(d); setLoaded(s); setError(null) }
    } catch (e) { setError((e as Error).message) }
  }, [clientId])
  useEffect(() => { load(step) }, [step, load])

  /** Save, then show the step again with the change applied everywhere it matters. */
  const save = async (work: () => Promise<unknown>) => {
    setSaving((x) => x + 1)
    try { await work(); await load(); return true } catch (e) { toast(`Not saved: ${(e as Error).message}`, 'bad'); return false } finally { setSaving((x) => x - 1) }
  }

  const upload = async (slot: 'lnv' | 'dsp' | 'iprs', file: File) => {
    setBusy((b) => ({ ...b, [slot]: true }))
    try {
      if (slot === 'lnv') await api.uploadMaster(clientId, file)
      else if (slot === 'dsp') await api.uploadDsp(clientId, file)
      else {
        if (!detail?.societies.some((s) => s.code === 'IPRS')) await api.addSocieties(clientId, ['IPRS'])
        const run = data?.files.iprs?.run ?? (await api.startReport(clientId, 'IPRS', today())).id
        await api.upload(run, 'iprs', file)
      }
      await Promise.all([load(), refresh()])
      toast('File read', 'good')
    } catch (e) { toast((e as Error).message, 'bad') } finally { setBusy((b) => ({ ...b, [slot]: false })) }
  }
  const go = (s: number) => { setParams({ step: String(s) }); window.scrollTo({ top: 0 }) }

  if (error && !data) return <div className="alert bad">{error}</div>
  if (!data) return <div className="loading"><span className="spinner" />Reading the files…</div>
  const f = data.files
  const shown = loaded === step ? data.step : null
  const c = data.counts
  const src = data.source
  const allFiles = !!(f.lnv && f.dsp && f.iprs)
  const results = [
    allFiles ? 'All three files are in' : `${[f.lnv, f.dsp, f.iprs].filter(Boolean).length} of 3 files`,
    c['1'] ? `${n(c['1'].songs)} songs · ${n(c['1'].needs)} need you` : `Needs the LNV and the ${src} export`,
    c['3'] ? `${n(c['3'].review_open)} need you · ${n(c['3'].amend)} amend · ${n(c['3'].register)} register` : 'Needs the IPRS report',
    f.lnv ? 'Ready to download' : 'Needs the LNV',
  ]
  const done = [allFiles, !!c['1'] && c['1'].needs === 0, !!c['3'] && c['3'].review_open === 0, false]

  return (
    <div className="cs">
      <nav className="cs-steps four" aria-label="Steps">
        {STEPS.map((s, i) => (
          <button key={s.n} type="button" className={`cs-step ${step === s.n ? 'active' : ''} ${done[i] ? 'ready' : ''}`} onClick={() => go(s.n)} aria-current={step === s.n ? 'step' : undefined}>
            <span className="cs-step-bar" aria-hidden />
            <span className="cs-step-n">{done[i] ? <Check size={13} strokeWidth={3} /> : s.n}</span>
            <span className="cs-step-text"><b>{s.title}</b><small>{results[i] || s.what}</small></span>
          </button>
        ))}
        {(step === 2 || step === 3) && <Button variant="ghost" className="cs-next" onClick={() => go(step + 1)}>Next: {STEPS[step].title}<ArrowRight size={15} /></Button>}
        <span className={`cs-saving ${saving ? 'on' : ''}`}>{saving ? <><span className="spinner small-dark" />Saving…</> : null}</span>
      </nav>

      {step === 1 && (
        <>
          <StepHead n={1} title="The client's three files"
            text={`The LNV is the client's catalogue – the master. The ${src} export brings the songs the stores have; the IPRS report what is registered. Drop each file on its box; you can replace one any time.`} />
          <div className="cs-files">
            <FileCard tone="lnv" label="LNV" what="The client's LNV report – the master" file={f.lnv?.name} text={f.lnv && `${n(f.lnv.stats.songs)} songs`}
              busy={busy.lnv} onFile={(x) => upload('lnv', x)} accept=".xlsx,.xlsm" />
            <FileCard tone="dsp" label={src} what="Muso, Spotify or Apple Music export" file={f.dsp?.name} text={f.dsp && `${n(f.dsp.stats.rows)} rows`}
              busy={busy.dsp} onFile={(x) => upload('dsp', x)} accept=".xlsx" disabled={!f.lnv} />
            <FileCard tone="iprs" label="IPRS" what="The client's IPRS works report" file={f.iprs?.name} text={f.iprs && (f.iprs.works != null ? `${n(f.iprs.works)} works` : 'Report added')}
              busy={busy.iprs} onFile={(x) => upload('iprs', x)} accept=".xlsx,.xlsm,.csv" disabled={!f.lnv} />
          </div>
          {!f.lnv && <p className="cs-files-note muted">Start with the LNV: the other two are compared with it.</p>}
        </>
      )}
      {step === 2 && (
        <>
          {!f.lnv || !f.dsp ? <Empty>This step needs the LNV and the {src} export – <button type="button" className="rv-link-btn" onClick={() => go(1)}>add them in step 1</button>.</Empty>
            : !shown ? <Wait />
              : <SongReview d={shown as Step1} save={(items) => save(() => api.mergeSave(clientId, items))} />}
        </>
      )}
      {step === 3 && (
        <>
          {!f.lnv || !f.iprs ? <Empty>This step needs the LNV and the IPRS report – <button type="button" className="rv-link-btn" onClick={() => go(1)}>add them in step 1</button>.</Empty>
            : !shown ? <Wait />
              : <IprsReview d={shown as Step3} run={data.run!} clientId={clientId} save={save} />}
        </>
      )}
      {step === 4 && <Final data={data} clientId={clientId} go={go} />}

      {(step === 1 || step === 4) && <div className="cs-foot">
        {step > 1 && <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => go(step - 1)}>Step {step - 1}: {STEPS[step - 2].title}</Button>}
        <span className="grow" />
        {step < 4 && <Button variant="primary" onClick={() => go(step + 1)}>Continue to step {step + 1}: {STEPS[step].title}<ArrowRight size={15} /></Button>}
      </div>}
    </div>
  )
}

/** Step 4: what the final LNV holds, and the downloads. Open doubts do not block it: the app's answer is used. */
function Final({ data, clientId, go }: { data: StepsPayload; clientId: number; go: (s: number) => void }) {
  const c1 = data.counts['1'], c3 = data.counts['3']
  const src = data.source
  const [preparing, setPreparing] = useState(false)
  if (!data.files.lnv) return <Empty>The final LNV needs the client's LNV – <button type="button" className="rv-link-btn" onClick={() => go(1)}>add it in step 1</button>.</Empty>
  const open = (c1?.needs ?? 0) + (c3?.review_open ?? 0)
  return (
    <>
      <StepHead n={4} title="The final LNV"
        text={`The client's own LNV file with every answer written in: details filled (yellow), new songs added (green), rows entered twice marked (orange – never deleted), IPRS codes and statuses, and a sheet listing every change.`} />
      {open > 0 && (
        <div className="alert warn cs-pending">
          <span className="grow"><b>{n(open)}</b> songs still need you{c1?.needs ? <> – {n(c1.needs)} in step 2</> : null}{c3?.review_open ? <> – {n(c3.review_open)} in step 3</> : null}.
            You can download now: where the app has an answer it is used, the rest stay out of the LNV until you decide.</span>
          {!!c1?.needs && <Button variant="ghost" onClick={() => go(2)}>Go to step 2</Button>}
          {!!c3?.review_open && <Button variant="ghost" onClick={() => go(3)}>Go to step 3</Button>}
        </div>
      )}
      <div className="fin-grid">
        <section className="fin-card">
          <h3><span className="rv-badge muso">{src}</span> From step 2</h3>
          {c1 ? <ul>
            <li><b>{n(c1.in_lnv)}</b> {src} songs are in the LNV already</li>
            <li><b>{n(c1.filled_rows)}</b> LNV rows get details {src} has and the LNV left blank</li>
            <li><b>{n(c1.adding)}</b> new songs are added to the LNV</li>
            <li><b>{n(c1.not_ours)}</b> songs are left out – not the client's writing</li>
          </ul> : <p className="muted">Needs the {src} export.</p>}
        </section>
        <section className="fin-card">
          <h3><span className="rv-badge iprs">IPRS</span> From step 3</h3>
          {c3 ? <ul>
            <li><b>{n(c3.matched)}</b> LNV songs are registered at IPRS as in the LNV</li>
            <li><b>{n(c3.amend)}</b> to amend at IPRS</li>
            <li><b>{n(c3.register)}</b> to register at IPRS</li>
            <li><b>{n(c3.iprs_only)}</b> works only IPRS has are added to the LNV</li>
          </ul> : <p className="muted">Needs the IPRS report.</p>}
        </section>
      </div>
      <div className="fin-actions">
        <a className="btn primary fin-main" href={api.lnvUpdateUrl(clientId)} onClick={() => { setPreparing(true); window.setTimeout(() => setPreparing(false), 15000) }}>
          {preparing ? <><span className="spinner small" />Preparing…</> : <><Download size={17} />Download the final LNV</>}</a>
        {data.run && <>
          <a className="btn" href={api.exportUrl(data.run, 'amend_lnv')}><Download size={15} />Amendment list</a>
          <a className="btn" href={api.exportUrl(data.run, 'registration_lnv')}><Download size={15} />Registration list</a>
        </>}
        {data.files.dsp && <a className="btn ghost" href={api.mergeExportUrl(clientId)}><Download size={15} />{src} merged by song</a>}
        <Link className="btn ghost" to={`/clients/${clientId}/tasks`}><ListChecks size={15} />Follow-up tasks</Link>
      </div>
    </>
  )
}

const Empty = ({ children }: { children: ReactNode }) => <div className="cs-empty"><UploadCloud size={26} /><span>{children}</span></div>
const Wait = () => <div className="loading"><span className="spinner" />Comparing…</div>

function StepHead({ n: num, title, text, children }: { n: number; title: string; text: string; children?: ReactNode }) {
  const [more, setMore] = useStored('mrm-step-intro', false)
  return (
    <header className="cs-head">
      <div className="grow"><div className="eyebrow">Step {num} of 4</div>
        <h2>{title}<button type="button" className="cs-more-link" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Less' : 'What is this step?'}</button></h2>
        {more && <p>{text}</p>}</div>
      {children && <div className="cs-head-side">{children}</div>}
    </header>
  )
}


/* ---------- a file's box ---------- */

/** One file's box: drop or click to add it, the same to replace it. Also used by the Add-client wizard. */
export function FileCard({ tone, label, what, file, text, busy, onFile, accept, disabled }: {
  tone: string; label: string; what: string; file?: string; text?: string | null; busy?: boolean
  onFile: (f: File) => void; accept: string; disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const pick = () => !busy && !disabled && input.current?.click()
  return (
    <div className={`sc-file ${tone} ${file ? 'has' : ''} ${over ? 'over' : ''} ${disabled ? 'off' : ''}`} role="button" tabIndex={disabled ? -1 : 0}
      onClick={pick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick() } }}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true) }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const x = e.dataTransfer.files[0]; if (x && !disabled && !busy) onFile(x) }}>
      <input ref={input} type="file" hidden accept={accept} onChange={(e) => { const x = e.target.files?.[0]; if (x) onFile(x); e.target.value = '' }} />
      <span className="sc-file-icon">{busy ? <span className="spinner small-dark" /> : file ? <Check size={18} /> : <UploadCloud size={18} />}</span>
      <span className="sc-file-text">
        <span className="sc-file-label">{label}</span>
        {busy ? <b>Reading the file…</b> : file ? <b title={file}>{text || 'Added'}</b> : <b>{disabled ? 'Add the LNV first' : 'Drop the file here'}</b>}
        <small title={file}>{file ?? what}</small>
      </span>
      {file && !busy && <span className="sc-file-replace">Replace</span>}
    </div>
  )
}
