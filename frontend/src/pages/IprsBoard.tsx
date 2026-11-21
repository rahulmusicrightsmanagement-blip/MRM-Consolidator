import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CircleCheckBig, GitCompareArrows, RefreshCw, Search } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, Empty, FileButton, Guide } from '../components/ui'
import { api } from '../lib/api'
import { fmtDate } from '../lib/client'
import { useToast } from '../lib/toast'
import type { ClientRow } from '../types'
import { FileCard } from './client/Consolidate'
import { Stage1Download } from './client/LnvStages'
import { hue, initials } from './Tracker'

/** LNV vs IPRS: every client whose Muso vs LNV is completed. Each one's stage 1 LNV (step 2's result, to download A–Z by
 *  song or by album), its stage 2 LNV (that result kept, or a corrected one uploaded in its place) and its IPRS report
 *  – added here, not when the client is added. Compare opens the client's step 3. */

type Tab = 'all' | 'iprs' | 'review' | 'done'
const stateOf = (c: ClientRow): Exclude<Tab, 'all'> => !c.journey.iprs ? 'iprs' : c.journey.step >= 4 ? 'done' : 'review'
const TABS: [Tab, string][] = [['all', 'All'], ['iprs', 'Needs the IPRS report'], ['review', 'To compare'], ['done', 'Done']]
const fmt = (x: number) => x.toLocaleString('en-IN')

let lastClients: ClientRow[] | null = null

export default function IprsBoard() {
  const [clients, setClients] = useState<ClientRow[] | null>(lastClients)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [params] = useSearchParams()
  const focus = Number(params.get('client')) || null
  const toast = useToast()
  const navigate = useNavigate()
  const load = useCallback(() => api.clients().then((d) => { setClients(d.clients); lastClients = d.clients; setError(null) })
    .catch((e) => setError((e as Error).message)), [])
  useEffect(() => { void load() }, [load])
  // opened from a client's step 2: its card on screen
  useEffect(() => { if (focus && clients) document.getElementById(`ib-${focus}`)?.scrollIntoView({ block: 'center' }) }, [focus, clients])

  const ready = useMemo(() => (clients ?? []).filter((c) => c.journey.stage1), [clients])
  const waiting = useMemo(() => (clients ?? []).filter((c) => !c.journey.stage1 && c.journey.files.lnv && c.journey.files.dsp), [clients])
  const count = (t: Tab) => t === 'all' ? ready.length : ready.filter((c) => stateOf(c) === t).length
  const s = q.trim().toLowerCase()
  const shown = ready.filter((c) => (tab === 'all' || stateOf(c) === tab) && (!s || `${c.name} ${c.ipi} ${c.owner}`.toLowerCase().includes(s)))

  const upload = async (c: ClientRow, slot: 'lnv2' | 'iprs', file: File) => {
    const k = `${c.id}-${slot}`
    setBusy((b) => ({ ...b, [k]: true }))
    try {
      if (slot === 'lnv2') await api.uploadStage2(c.id, file)
      else await api.uploadIprs(c.id, file, c.journey.iprs?.run)
      toast(slot === 'lnv2' ? `${c.name}: stage 2 LNV read – IPRS is checked against it now` : `${c.name}: IPRS report read`, 'good')
      // both files in: straight on to the comparison
      if (slot === 'iprs' || c.journey.iprs) navigate(`/clients/${c.id}?step=3`)
      else await load()
    } catch (e) { toast((e as Error).message, 'bad') } finally { setBusy((b) => ({ ...b, [k]: false })) }
  }

  return (
    <AppShell trail={<span className="trail-name">LNV vs IPRS</span>}>
      <header className="page-header">
        <div><div className="eyebrow">Stage 2</div><h1>LNV vs IPRS</h1>
          <p className="lede">{clients === null ? 'Loading…' : <>{fmt(ready.length)} client{ready.length === 1 ? '' : 's'} with Muso vs LNV completed
            {waiting.length > 0 && <> · {fmt(waiting.length)} still in Muso vs LNV</>}</>}</p></div>
      </header>

      <Guide id="iprs-board" title="Check the LNV against IPRS" steps={[
        <>A client is here once its <b>Muso vs LNV</b> (step 2) is marked completed. Its result is the <b>stage 1 LNV</b> – download it A–Z by song or by album.</>,
        <>That LNV is kept as the <b>stage 2 LNV</b>. Made corrections after your own checks and approval? Drop the final file on <b>Stage 2 LNV</b>: it is used instead.</>,
        <>Drop the client's <b>IPRS report</b> on its box, then <b>Compare</b>: every song of the stage 2 LNV is looked up in IPRS – registered, to amend, to register.</>,
      ]} />

      <div className="ib-tools">
        <div className="rv-tabs" role="tablist" aria-label="Where the client is">
          {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}<span>{fmt(count(id))}</span></button>)}
        </div>
        <label className="cs-search ib-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client: name, IPI, owner…" /></label>
      </div>

      {clients === null ? (error
        ? <Empty icon={<AlertTriangle size={22} />} title="Could not load the clients" action={<Button icon={<RefreshCw size={14} />} onClick={load}>Try again</Button>}>{error}</Empty>
        : <div className="loading"><span className="spinner" />Loading clients…</div>)
        : !ready.length ? (
          <Empty icon={<GitCompareArrows size={22} />} title="No client has completed Muso vs LNV yet">
            Open a client, finish step 2 – Muso vs LNV – and press <b>Mark as completed</b>. The client then shows up here with its stage 2 LNV.
          </Empty>
        ) : !shown.length ? <p className="sm-list-none">No client matches.</p> : (
          <div className="ib-list">
            {shown.map((c) => {
              const j = c.journey
              const st = stateOf(c)
              const needs = j.needs['3']
              return (
                <article key={c.id} id={`ib-${c.id}`} className={`ib-card ${focus === c.id ? 'focus' : ''}`}>
                  <header className="ib-head">
                    <span className="client-avatar" style={{ '--h': hue(c.name) } as CSSProperties}>{initials(c.name)}</span>
                    <div className="ib-id"><Link to={`/clients/${c.id}`}><b>{c.name}</b></Link>
                      <small className="muted"><span className="mono">IPI {c.ipi || '—'}</span>{c.owner && <> · {c.owner}</>}</small></div>
                    <span className={`ib-state ${st}`}>{st === 'iprs' ? 'Needs the IPRS report' : st === 'done' ? <><CircleCheckBig size={14} />Done</>
                      : needs ? `${fmt(needs)} need you` : 'To compare'}</span>
                    <Link className={`btn ${st === 'iprs' ? '' : 'primary'}`} to={`/clients/${c.id}?step=${st === 'done' ? 4 : 3}`}>
                      {st === 'done' ? 'Final LNV' : 'Compare'}<ArrowRight size={15} /></Link>
                  </header>
                  <div className="ib-files">
                    <div className="ib-box">
                      <span className="sc-file-label">Stage 1 LNV · Muso vs LNV</span>
                      <b>Completed {fmtDate(j.stage1!.done_at)}</b>
                      <small className="muted">{j.stage1!.by ? `by ${j.stage1!.by}` : 'before stages'}</small>
                      <Stage1Download clientId={c.id} label="Download" />
                    </div>
                    <div className="ib-col">
                      <FileCard tone="lnv" label="Stage 2 LNV" file={j.lnv2?.name} busy={busy[`${c.id}-lnv2`]} onFile={(f) => upload(c, 'lnv2', f)} accept=".xlsx,.xlsm"
                        what={j.lnv2 ? 'Drop a corrected one to use it instead' : 'The LNV as uploaded is used – drop the final LNV here to use it instead'}
                        text={j.lnv2 && `${j.lnv2.origin === 'stage1' ? 'Made from step 2' : `Uploaded ${fmtDate(j.lnv2.uploaded_at)}${j.lnv2.by ? ` by ${j.lnv2.by}` : ''}`} · ${fmt(j.lnv2.stats.songs ?? 0)} songs`} />
                      {j.lnv2 && <FileButton className="ghost sm" url={api.stage2Url(c.id)}>Download stage 2 LNV</FileButton>}
                    </div>
                    <FileCard tone="iprs" label="IPRS report" file={j.iprs?.name} busy={busy[`${c.id}-iprs`]} onFile={(f) => upload(c, 'iprs', f)} accept=".xlsx,.xlsm,.csv"
                      what="The client's IPRS works report" text={j.iprs && (j.iprs.works != null ? `${fmt(j.iprs.works)} works` : 'Report added')} />
                  </div>
                </article>
              )
            })}
          </div>
        )}

      {waiting.length > 0 && (
        <section className="ib-wait">
          <h4>Still in Muso vs LNV <span className="muted">{fmt(waiting.length)}</span></h4>
          <div className="ib-wait-list">
            {waiting.map((c) => (
              <Link key={c.id} to={`/clients/${c.id}?step=2`} className="ib-wait-item">
                <span className="client-avatar sm" style={{ '--h': hue(c.name) } as CSSProperties}>{initials(c.name)}</span>
                <b>{c.name}</b><small className="muted">{c.journey.needs['2'] == null ? 'Not opened yet' : c.journey.needs['2'] ? `${fmt(c.journey.needs['2'])} need you` : 'Ready to mark completed'}</small>
              </Link>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  )
}
