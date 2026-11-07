import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, Download, UploadCloud } from 'lucide-react'
import { Button } from '../../components/ui'
import { api } from '../../lib/api'
import { today, useClient } from '../../lib/client'
import { RunProvider, useRun } from '../../lib/run'
import { useToast } from '../../lib/toast'
import type { StepsPayload } from '../../types'
import { IprsMatchStep } from '../run/MatchStep'
import Review from './Review'

const fmt = (x?: number | null) => (x ?? 0).toLocaleString('en-IN')

/** The client's flow: upload the two files, review what the app could not decide, download the output.
 *  An IPRS report is optional; when one is uploaded its check becomes a step of its own. */
export default function Consolidate() {
  const { clientId, detail, refresh } = useClient()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<StepsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const asked = Number(params.get('step'))
  const step = Math.min(4, Math.max(1, asked || detail?.journey.step || 1))
  const want = useRef(step)
  want.current = step

  const seq = useRef(0)
  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const d = await api.steps(clientId, want.current === 3 ? 3 : 0)
      if (mine === seq.current) { setData(d); setError(null) }
    } catch (e) { if (mine === seq.current) setError((e as Error).message) }
  }, [clientId])
  useEffect(() => { load() }, [step, load])

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
  const f = data.files, c1 = data.counts['1'], c3 = data.counts['3'], src = data.source
  const ready = !!(f.lnv && f.dsp)
  const hasIprs = !!f.iprs
  const steps = [
    { n: 1, title: 'Upload files', note: ready ? 'Both files in' : `${[f.lnv, f.dsp].filter(Boolean).length} of 2 files`, done: ready, open: true },
    { n: 2, title: 'Review matches', note: c1 ? (c1.open ? `${fmt(c1.open)} to review` : 'All reviewed') : 'Needs both files', done: !!c1 && c1.open === 0, open: ready },
    ...(hasIprs ? [{ n: 3, title: 'IPRS check', note: c3 ? (c3.review_open ? `${fmt(c3.review_open)} to review` : 'All reviewed') : 'Reading the report', done: !!c3 && c3.review_open === 0, open: true }] : []),
    { n: 4, title: 'Download', note: ready ? 'Output ready' : 'Needs both files', done: false, open: !!f.lnv },
  ]
  const next = (s: number) => steps[steps.findIndex((x) => x.n === s) + 1]?.n ?? s

  return (
    <div className="flow">
      <ol className="flow-steps" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s.n}>
            <button type="button" disabled={!s.open} className={`${step === s.n ? 'on' : ''} ${s.done ? 'done' : ''}`} aria-current={step === s.n ? 'step' : undefined} onClick={() => go(s.n)}>
              <span className="flow-dot">{s.done ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
              <span className="flow-text"><b>{s.title}</b><small>{s.note}</small></span>
            </button>
          </li>
        ))}
      </ol>

      {step === 1 && <>
        <div className="flow-files">
          <FileCard tone="lnv" label="Source 1 · LNV report" what="The client's catalogue" file={f.lnv?.name} text={f.lnv && `${fmt(f.lnv.stats.songs)} songs`}
            busy={busy.lnv} onFile={(x) => upload('lnv', x)} accept=".xlsx,.xlsm" />
          <FileCard tone="dsp" label={`Source 2 · ${src} export`} what="What the stores have" file={f.dsp?.name} text={f.dsp && `${fmt(f.dsp.stats.rows)} rows`}
            busy={busy.dsp} onFile={(x) => upload('dsp', x)} accept=".xlsx" disabled={!f.lnv} />
        </div>
        <details className="flow-optional" open={hasIprs || undefined}>
          <summary>Optional: add an IPRS report</summary>
          <div className="flow-files one">
            <FileCard tone="iprs" label="IPRS report" what="Adds a check of what is registered" file={f.iprs?.name} text={f.iprs && (f.iprs.works != null ? `${fmt(f.iprs.works)} works` : 'Report added')}
              busy={busy.iprs} onFile={(x) => upload('iprs', x)} accept=".xlsx,.xlsm,.csv" disabled={!f.lnv} />
          </div>
        </details>
        <div className="flow-foot"><span className="grow" /><Button variant="primary" disabled={!ready} onClick={() => go(2)}>Compare the files<ArrowRight size={15} /></Button></div>
      </>}

      {step === 2 && (ready
        ? <Review clientId={clientId} source={src} onChanged={() => { load(); void refresh() }} onNext={() => go(next(2))} />
        : <Needs go={go}>This step needs the LNV and the {src} export.</Needs>)}

      {step === 3 && (hasIprs && data.run
        ? <>
          <RunProvider key={data.run} runId={data.run} onChange={() => { load(); void refresh() }}><IprsStep /></RunProvider>
          <div className="flow-foot"><span className="grow" /><Button variant="primary" onClick={() => go(4)}>Continue<ArrowRight size={15} /></Button></div>
        </>
        : <Needs go={go}>This step needs an IPRS report.</Needs>)}

      {step === 4 && (f.lnv
        ? <Final data={data} clientId={clientId} go={go} back={steps[steps.length - 2]?.n ?? 1} />
        : <Needs go={go}>The output needs the client's LNV.</Needs>)}
    </div>
  )
}

function IprsStep() {
  const { payload, loading, error } = useRun()
  if (loading && !payload) return <div className="loading"><span className="spinner" />Comparing…</div>
  if (error || !payload) return <div className="alert bad">{error ?? 'Could not open the IPRS report.'}</div>
  return <IprsMatchStep />
}

/** The output: what it holds and the one download that matters. Open questions do not block it. */
function Final({ data, clientId, go, back }: { data: StepsPayload; clientId: number; go: (s: number) => void; back: number }) {
  const c = data.counts['1'], c3 = data.counts['3'], src = data.source
  const open = c?.open ?? 0
  return (
    <div className="dl">
      <div className="dl-main">
        <h2>Your updated LNV</h2>
        <p className="muted">The client's own LNV file. Every change is highlighted <mark>in yellow</mark>.</p>
        {open > 0 && <div className="alert warn"><span className="grow"><b>{fmt(open)}</b> possible matches are not answered. They are left out of the output until you do.</span>
          <Button onClick={() => go(2)}>Review them</Button></div>}
        {c && <ul className="dl-list">
          <li><b>{fmt(c.linked)}</b><span>{src} recordings linked to their LNV rows</span></li>
          <li><b>{fmt(c.fills)}</b><span>blank LNV cells filled from {src}</span></li>
          <li><b>{fmt(c.added)}</b><span>new rows added for songs the LNV does not have</span></li>
          <li><b>{fmt(c.named)}</b><span>versions name their original in the two new columns, <b>Original Work</b> and <b>Original Movie / Album</b>, next to Movie Name</span></li>
          {(c.held + c.skipped) > 0 && <li><b>{fmt(c.held + c.skipped)}</b><span>left out: already on another sheet of the LNV, or left out by you</span></li>}
          {c3 && <li><b>{fmt(c3.on_screen_amend)}</b><span>to amend at IPRS, and <b>{fmt(c3.on_screen_register)}</b> to register</span></li>}
        </ul>}
        <FileButton className="primary dl-go" url={api.lnvUpdateUrl(clientId)}>Download updated LNV</FileButton>
        <p className="small muted">Two sheets are added at the end: <b>MRM changes</b> lists every change, <b>Match report</b> lists every {src} recording and where it ended up.</p>
      </div>
      {data.run && <div className="dl-side">
        <h3>IPRS lists</h3>
        <FileButton url={api.exportUrl(data.run, 'amend_lnv')}>Amendment list{c3 ? ` (${fmt(c3.amend)})` : ''}</FileButton>
        <FileButton url={api.exportUrl(data.run, 'registration_lnv')}>Registration list{c3 ? ` (${fmt(c3.register)})` : ''}</FileButton>
      </div>}
      <div className="flow-foot wide"><Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => go(back)}>Back</Button></div>
    </div>
  )
}

/** A download that says it is working, and shows an error as a message. */
function FileButton({ url, className = '', children }: { url: string; className?: string; children: ReactNode }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const get = async () => {
    setBusy(true)
    try {
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'The file could not be prepared.')
      const name = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'download.xlsx'
      const link = document.createElement('a')
      link.href = URL.createObjectURL(await res.blob())
      link.download = name
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (e) { toast((e as Error).message, 'bad') } finally { setBusy(false) }
  }
  return <button type="button" className={`btn ${className}`} disabled={busy} onClick={get}>
    {busy ? <><span className={`spinner ${className.includes('primary') ? 'small' : 'small-dark'}`} />Preparing…</> : <><Download size={16} />{children}</>}</button>
}

const Needs = ({ children, go }: { children: ReactNode; go: (s: number) => void }) => (
  <div className="flow-needs"><UploadCloud size={26} /><span>{children}</span><Button onClick={() => go(1)}>Go to Upload files</Button></div>
)

/** One file's box: drop or click to add it, the same to replace it. */
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
        {busy ? <b>Reading the file…</b> : file ? <b title={file}>{text || 'Added'}</b> : <b>{disabled ? 'Add the LNV first' : 'Drop the file here, or click'}</b>}
        <small title={file}>{file ?? what}</small>
      </span>
      {file && !busy && <span className="sc-file-replace">Replace</span>}
    </div>
  )
}
