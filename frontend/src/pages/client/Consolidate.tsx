import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, ListChecks, UploadCloud } from 'lucide-react'
import { Button, FileButton, Guide } from '../../components/ui'
import { api } from '../../lib/api'
import { fmtDate, useClient } from '../../lib/client'
import { RunProvider, useRun } from '../../lib/run'
import { useToast } from '../../lib/toast'
import type { Step1, StepsPayload } from '../../types'
import { IprsMatchStep } from '../run/MatchStep'
import SongReview, { useStored } from './SongReview'
import { n } from './Block'
import { Stage1Download } from './LnvStages'

/** The consolidate flow, one step after the other (the MRM flowchart):
 *    1 Files        – the LNV and the Muso export (the IPRS report comes in step 3)
 *    2 Muso vs LNV  – one case per song: its DSP versions and the LNV rows that may be it, answered together; marked
 *                     completed, its LNV (stage 1) is kept as the stage 2 LNV
 *    3 LNV vs IPRS  – the stage 2 LNV (or a corrected one uploaded) and the IPRS report: "Match & review" (run/MatchStep)
 *    4 Final LNV    – the stage 2 LNV with step 3's answers
 *  The app's answer is already applied – the reviewer only clicks where it is wrong. */


/* ---------- the page ---------- */

const STEPS = [
  { n: 1, api: 0, title: 'Files', what: 'The LNV and the Muso export' },
  { n: 2, api: 1, title: 'Muso vs LNV', what: 'Stage 1 LNV: each song, its versions and its LNV row' },
  { n: 3, api: 0, title: 'LNV vs IPRS', what: 'Stage 2 LNV: registered, to amend, to register' },
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

  // only the newest load may show: an older answer arriving late would undo what the reviewer just saved
  const seq = useRef(0)
  const load = useCallback(async (s = want.current) => {
    const mine = ++seq.current
    try {
      const d = await api.steps(clientId, STEPS[s - 1].api)
      if (s === want.current && mine === seq.current) { setData(d); setLoaded(s); setError(null) }
    } catch (e) { if (mine === seq.current) setError((e as Error).message) }
  }, [clientId])
  useEffect(() => { load(step) }, [step, load])

  /** Save, then show the step again with the change applied everywhere it matters. Answers given one after another
   *  share one reload: it starts once the last save is in. */
  const pending = useRef(0)
  const save = async (work: () => Promise<unknown>) => {
    setSaving((x) => x + 1)
    pending.current += 1
    try { await work(); return true } catch (e) { toast(`Not saved: ${(e as Error).message}`, 'bad'); return false } finally {
      pending.current -= 1
      if (!pending.current) { await load(); void refresh() }
      setSaving((x) => x - 1)
    }
  }

  const upload = async (slot: 'lnv' | 'dsp' | 'lnv2' | 'iprs', file: File) => {
    setBusy((b) => ({ ...b, [slot]: true }))
    try {
      if (slot === 'lnv') await api.uploadMaster(clientId, file)
      else if (slot === 'dsp') await api.uploadDsp(clientId, file)
      else if (slot === 'lnv2') await api.uploadStage2(clientId, file)
      else await api.uploadIprs(clientId, file, data?.files.iprs?.run)
      await Promise.all([load(), refresh()])
      // the IPRS report in, with the stage 2 LNV: straight on to the comparison
      if (slot === 'iprs' || slot === 'lnv2') setParams({ step: '3' })
      toast(slot === 'lnv2' ? 'Stage 2 LNV read – IPRS is checked against it now' : 'File read', 'good')
    } catch (e) { toast((e as Error).message, 'bad') } finally { setBusy((b) => ({ ...b, [slot]: false })) }
  }
  /** Step 2 marked completed (its LNV kept as the stage 2 LNV), or opened again. */
  const complete = async (done: boolean) => {
    try {
      await api.completeStage1(clientId, done)
      await Promise.all([load(), refresh()])
      toast(done ? 'Muso vs LNV completed – the stage 2 LNV is ready for LNV vs IPRS' : 'Muso vs LNV is open again', 'good')
      return true
    } catch (e) { toast((e as Error).message, 'bad'); return false }
  }
  const go = (s: number) => { setParams({ step: String(s) }); window.scrollTo({ top: 0 }) }

  if (error && !data) return <div className="alert bad">{error}</div>
  if (!data) return <div className="loading"><span className="spinner" />Reading the files…</div>
  const f = data.files
  const shown = loaded === step ? data.step : null
  const src = data.source
  // the LNV step 3 checks: the stage 2 LNV – or, for a client from before stages, the one uploaded
  const lnv3 = !!(f.lnv2 || data.stage1)
  // both of stage 2's files in: straight to the comparison, the files one line above it (?files=1 opens them)
  const compact = lnv3 && !!f.iprs && params.get('files') !== '1'

  return (
    <div className="cs">
      {/* the steps are in the sidebar; only "Saving…" floats here while answers are sent */}
      <span className={`cs-saving-float ${saving ? 'on' : ''}`} role="status">{saving ? <><span className="spinner small-dark" />Saving…</> : null}</span>

      {step === 1 && (
        <>
          <StepHead n={1} title="The client's two files"
            text={`The LNV is the client's catalogue – the master. The ${src} export brings the songs the stores have. The IPRS report is not needed yet: it is added in step 3, LNV vs IPRS, once step 2 is completed. Drop each file on its box; you can replace one any time.`} />
          <Guide id="step1" title="Add the client's files" steps={[
            <>Drop the client's <b>LNV</b> on the first box – the master catalogue everything is compared with.</>,
            <>Then the <b>{src} export</b> – the songs the stores have.</>,
            <>To replace a file, drop the new one on its box. When both are in, continue to step 2. The <b>IPRS report</b> comes later, in step 3.</>,
          ]} />
          <div className="cs-files two">
            <FileCard tone="lnv" label="LNV" what="The client's LNV report – the master" file={f.lnv?.name} text={f.lnv && `${n(f.lnv.stats.songs)} songs`}
              busy={busy.lnv} onFile={(x) => upload('lnv', x)} accept=".xlsx,.xlsm" />
            <FileCard tone="dsp" label={src} what="Muso, Spotify or Apple Music export" file={f.dsp?.name} text={f.dsp && `${n(f.dsp.stats.rows)} rows`}
              busy={busy.dsp} onFile={(x) => upload('dsp', x)} accept=".xlsx" disabled={!f.lnv} />
          </div>
          {!f.lnv && <p className="cs-files-note muted">Start with the LNV: the {src} export is compared with it.</p>}
        </>
      )}
      {step === 2 && (
        <>
          {!f.lnv || !f.dsp ? <Empty>This step needs the LNV and the {src} export – <button type="button" className="rv-link-btn" onClick={() => go(1)}>add them in step 1</button>.</Empty>
            : !shown ? <Wait />
              : <SongReview d={shown as Step1} save={(items) => save(() => api.mergeSave(clientId, items))} act={save} stage1={data.stage1} complete={complete} />}
        </>
      )}
      {step === 3 && (
        <>
          <Stage2Files data={data} clientId={clientId} busy={busy} upload={upload} go={go} compact={compact}
            open={(on) => setParams(on ? { step: '3', files: '1' } : { step: '3' })} />
          {!f.lnv ? <Empty>This step needs the LNV – <button type="button" className="rv-link-btn" onClick={() => go(1)}>add it in step 1</button>.</Empty>
            : !lnv3 ? <Empty>Complete step 2 first – <button type="button" className="rv-link-btn" onClick={() => go(2)}>Muso vs LNV</button>: its LNV is the one IPRS is checked against. Or upload a stage 2 LNV above.</Empty>
            : !f.iprs ? <Empty>Drop the client's IPRS report on its box above: the stage 2 LNV is checked against it.</Empty>
            : <>
              <Guide id="step3" title="Check the LNV against IPRS" steps={[
                <>Every LNV song is looked up in the IPRS report. <b>To decide</b>: pick the IPRS work that is the song, or say none is.</>,
                <><b>Amend</b>: IPRS has the song with other details – it goes on the amendment list.</>,
                <><b>Register</b>: IPRS does not have the song yet – it goes on the registration list.</>,
              ]} />
              <RunProvider key={data.run} runId={data.run!} onChange={() => { load(); refresh() }}><IprsStep /></RunProvider>
            </>}
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

/** Step 3's two files: the stage 2 LNV (step 2's result, or a corrected one uploaded in its place) and the IPRS report. */
function Stage2Files({ data, clientId, busy, upload, go, compact, open }: {
  data: StepsPayload; clientId: number; busy: Record<string, boolean>; upload: (slot: 'lnv2' | 'iprs', f: File) => void; go: (s: number) => void
  /** both files in: one line, the comparison right under it */
  compact: boolean; open: (on: boolean) => void
}) {
  const f = data.files
  const l2 = f.lnv2
  const ready = !!(l2 || data.stage1)
  const lnvText = l2 ? `${l2.origin === 'stage1' ? 'Extracted from Muso vs LNV' : `Uploaded ${fmtDate(l2.uploaded_at)}`} · ${n(l2.stats.songs)} songs` : 'The LNV as uploaded'
  if (compact) return (
    <div className="s2-line">
      <span className="s2-stage">Stage 2 · LNV vs IPRS</span>
      <span className="s2-file lnv"><b>Stage 2 LNV</b><span title={l2?.name ?? f.lnv?.name}>{lnvText}</span></span>
      <span className="s2-file iprs"><b>IPRS</b><span title={f.iprs!.name}>{f.iprs!.works != null ? `${n(f.iprs!.works)} works` : f.iprs!.name}</span></span>
      <span className="grow" />
      {l2 && <FileButton className="ghost" url={api.stage2Url(clientId)}>Stage 2 LNV</FileButton>}
      <Button onClick={() => open(true)}>Change files</Button>
    </div>
  )
  return (
    <>
      <StepHead n={3} title="The stage 2 LNV against IPRS"
        text={`The stage 2 LNV is the LNV after Muso vs LNV: the one step 2 made when it was completed, or a corrected copy uploaded in its place (after your own checks and approval). Every song in it is looked up in the client's IPRS report.`} />
      <div className="cs-files two">
        <FileCard tone="lnv" label="Stage 2 LNV" file={l2?.name} busy={busy.lnv2} onFile={(x) => upload('lnv2', x)} accept=".xlsx,.xlsm"
          what={data.stage1 ? 'The LNV after Muso vs LNV – drop a corrected one to use it instead' : 'Complete step 2, or drop the final LNV of step 2 here'}
          text={l2 && `${l2.origin === 'stage1' ? 'Made from step 2' : `Uploaded ${fmtDate(l2.uploaded_at)}`} · ${n(l2.stats.songs)} songs`} />
        <FileCard tone="iprs" label="IPRS" what="The client's IPRS works report" file={f.iprs?.name} text={f.iprs && (f.iprs.works != null ? `${n(f.iprs.works)} works` : 'Report added')}
          busy={busy.iprs} onFile={(x) => upload('iprs', x)} accept=".xlsx,.xlsm,.csv" disabled={!ready} disabledText="Complete step 2 first" />
      </div>
      <div className="cs-files-acts">
        {ready && f.iprs && <Button variant="primary" onClick={() => open(false)}>Go to the comparison<ArrowRight size={15} /></Button>}
        {l2 ? <FileButton url={api.stage2Url(clientId)}>Download stage 2 LNV</FileButton>
          : data.stage1 ? <span className="muted small">This client was checked against IPRS before stages: the LNV as uploaded is used. Drop a stage 2 LNV to use that instead.</span>
            : <Button variant="ghost" onClick={() => go(2)}><ArrowLeft size={15} />Complete step 2: Muso vs LNV</Button>}
        {f.dsp && <Stage1Download clientId={clientId} />}
        {l2 && <span className="muted small">Replacing the stage 2 LNV clears the values picked from IPRS in this step (its rows are other ones).</span>}
      </div>
    </>
  )
}

/** Step 3: the IPRS report's own screen, once the report is open. */
function IprsStep() {
  const { payload, loading, error } = useRun()
  if (loading && !payload) return <Wait />
  if (error || !payload) return <div className="alert bad">{error ?? 'Could not open the IPRS report.'}</div>
  return <IprsMatchStep />
}

/** Step 4: what the final LNV holds, and the downloads. Open doubts do not block it: the app's answer is used. */
function Final({ data, clientId, go }: { data: StepsPayload; clientId: number; go: (s: number) => void }) {
  const c1 = data.counts['1'], c3 = data.counts['3']
  const src = data.source
  if (!data.files.lnv) return <Empty>The final LNV needs the client's LNV – <button type="button" className="rv-link-btn" onClick={() => go(1)}>add it in step 1</button>.</Empty>
  const open = (c1?.needs ?? 0) + (c3?.review_open ?? 0)
  return (
    <>
      <StepHead n={4} title="The final LNV"
        text={`The stage 2 LNV with step 3's answers written in: IPRS codes and statuses, the values taken from IPRS (yellow), the works only IPRS has (green). Step 2's changes are in it already, listed on its "MRM changes" sheet; step 3's are on "MRM changes IPRS".`} />
      <Guide id="step4" title="Download the final LNV" steps={[
        <>Check the two boxes: what step 2 ({src}) and step 3 (IPRS) put into the LNV.</>,
        <><b>Download the final LNV</b>: the client's own file with every change coloured – <span className="t-warn">yellow</span> filled or changed, <span className="t-good">green</span> added, orange entered twice.</>,
        <>Its <b>MRM changes</b> sheet lists every change row by row. The amendment and registration lists go to IPRS.</>,
      ]} />
      {open > 0 && (
        <div className="alert warn cs-pending">
          <span className="grow"><b>{n(open)}</b> songs still need you{c1?.needs ? <> – {n(c1.needs)} in step 2</> : null}{c3?.review_open ? <> – {n(c3.review_open)} in step 3</> : null}.
            You can download now: where the app has an answer it is used; a song with no answer yet stays out of the final LNV.</span>
          {!!c1?.needs && <Button variant="ghost" onClick={() => go(2)}>Go to step 2</Button>}
          {!!c3?.review_open && <Button variant="ghost" onClick={() => go(3)}>Go to step 3</Button>}
        </div>
      )}
      {!!c3?.waiting && (
        <div className="alert warn cs-pending"><span className="grow">Finish step 3 before sending the lists to IPRS: <b>{n(c3.waiting)}</b> LNV songs are still waiting for your decision there, and until then they can show up on the Registration list even if IPRS already has them.</span></div>
      )}
      <div className="fin-grid">
        <section className="fin-card">
          <h3><span className="rv-badge muso">{src}</span> From step 2</h3>
          {c1 ? <ul>
            <li><b>{n(c1.in_lnv)}</b> {src} songs are in the LNV already</li>
            <li><b>{n(c1.filled_rows)}</b> LNV rows get details {src} has and the LNV left blank</li>
            <li><b>{n(c1.adding)}</b> new songs are added to the LNV</li>
            {c1.versions_new > 0 && <li><b>{n(c1.versions_new)}</b> versions (remix, lofi …) get rows of their own, with their original song and film in two new columns</li>}
            <li><b>{n(c1.not_ours)}</b> songs are left out – not the client's writing</li>
            {(c1.deleted ?? 0) > 0 && <li><b>{n(c1.deleted)}</b> songs deleted by you – nothing of them goes into the LNV</li>}
            {c1.undecided > 0 && <li><b>{n(c1.undecided)}</b> new songs have no answer yet, so they are not added</li>}
          </ul> : <p className="muted">Needs the {src} export.</p>}
        </section>
        <section className="fin-card">
          <h3><span className="rv-badge iprs">IPRS</span> From step 3</h3>
          {c3 ? <ul>
            <li><b>{n(c3.matched)}</b> LNV songs are registered at IPRS as in the LNV</li>
            <li><b>{n(c3.on_screen_amend)}</b> to amend at IPRS</li>
            <li><b>{n(c3.on_screen_register)}</b> to register at IPRS</li>
            <li><b>{n(c3.iprs_only)}</b> works only IPRS has are added to the LNV</li>
          </ul> : <p className="muted">Needs the IPRS report.</p>}
        </section>
      </div>
      <div className="fin-actions">
        <FileButton className="primary fin-main" url={api.lnvUpdateUrl(clientId)} size={17}>Download the final LNV</FileButton>
        {data.run && <>
          <FileButton url={api.exportUrl(data.run, 'amend_lnv')}>Amendment list{c3 ? ` (${n(c3.amend)})` : ''}</FileButton>
          <FileButton url={api.exportUrl(data.run, 'registration_lnv')}>Registration list{c3 ? ` (${n(c3.register)})` : ''}</FileButton>
        </>}
        {data.files.lnv2 && <FileButton className="ghost" url={api.stage2Url(clientId)}>Stage 2 LNV</FileButton>}
        {data.files.dsp && <FileButton className="ghost" url={api.mergeExportUrl(clientId)}>{src} merged by song</FileButton>}
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
      <div className="grow"><div className="eyebrow">{num <= 2 ? `Stage 1 · Step ${num} of 2` : num === 3 ? 'Stage 2 · LNV vs IPRS' : 'Stage 2 · Final LNV'}</div>
        <h2>{title}<button type="button" className="cs-more-link" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Less' : 'What is this step?'}</button></h2>
        {more && <p>{text}</p>}</div>
      {children && <div className="cs-head-side">{children}</div>}
    </header>
  )
}


/* ---------- a file's box ---------- */

/** One file's box: drop or click to add it, the same to replace it. Also used by the Add-client wizard. */
export function FileCard({ tone, label, what, file, text, busy, onFile, accept, disabled, disabledText = 'Add the LNV first' }: {
  tone: string; label: string; what: string; file?: string; text?: string | null; busy?: boolean
  onFile: (f: File) => void; accept: string; disabled?: boolean; disabledText?: string
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
        {busy ? <b>Reading the file…</b> : file ? <b title={file}>{text || 'Added'}</b> : <b>{disabled ? disabledText : 'Drop the file here'}</b>}
        <small title={file}>{file ?? what}</small>
      </span>
      {file && !busy && <span className="sc-file-replace">Replace</span>}
    </div>
  )
}
