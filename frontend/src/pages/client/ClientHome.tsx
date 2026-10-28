import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, FileSpreadsheet, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { Button, Card, ConfirmDialog } from '../../components/ui'
import { api } from '../../lib/api'
import { fmtDate, pct, useClient } from '../../lib/client'
import { useToast } from '../../lib/toast'
import type { SocietySummary } from '../../types'

const STATUS: Record<SocietySummary['status'], { label: string; tone: string }> = {
  not_started: { label: 'Not started', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  completed: { label: 'Completed', tone: 'good' },
}

function SocietyCard({ s, clientId }: { s: SocietySummary; clientId: number }) {
  const navigate = useNavigate()
  const { refresh } = useClient()
  const toast = useToast()
  const [ask, setAsk] = useState(false)
  const confirmed = s.report?.confirmed_step ?? 0
  const total = s.steps.length
  const cov = s.coverage
  const go = () => navigate(`/clients/${clientId}/societies/${s.code}`)
  return (
    <div className={`soc-tile ${s.status}`}>
      <div className="soc-tile-head">
        <div><b>{s.meta.name}</b><small>{s.meta.kind} · {s.meta.country}</small></div>
        <span className={`badge ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span>
      </div>
      <ol className="mini-steps" aria-label="Steps">
        {s.steps.map((label, i) => <li key={label} className={i < confirmed || s.status === 'completed' ? 'done' : ''} title={label} />)}
      </ol>
      <p className="small muted">{s.status === 'not_started' ? `${total} steps · needs the ${s.meta.file || s.code + ' export'}`
        : s.status === 'completed' ? `All ${total} steps done · completed ${fmtDate(s.report?.completed_at)}`
          : `Step ${Math.min(confirmed + 1, total)} of ${total}: ${s.steps[Math.min(confirmed, total - 1)]}`}</p>
      {cov && (
        <div className="soc-tile-figs">
          <span><b>{pct(cov.registered, cov.total)}%</b> registered</span>
          <span><b className="t-warn">{cov.statuses.needs_amend ?? 0}</b> to amend</span>
          <span><b className="t-bad">{cov.statuses.not_registered ?? 0}</b> to register</span>
          {s.review > 0 && <span className="t-warn"><b>{s.review}</b> to review</span>}
        </div>
      )}
      <div className="soc-tile-actions">
        <Button variant={s.status === 'completed' ? 'default' : 'primary'} onClick={go}>
          {s.status === 'not_started' ? `Start ${s.code}` : s.status === 'completed' ? 'Open' : 'Continue'}<ArrowRight size={15} />
        </Button>
        <span className="grow" />
        <Button variant="ghost" icon={<Trash2 size={15} />} aria-label={`Delete ${s.code}`} title={`Delete ${s.code}`} onClick={() => setAsk(true)} />
      </div>
      <ConfirmDialog open={ask} title={`Delete ${s.meta.name}?`} confirmLabel={`Delete ${s.code}`} onCancel={() => setAsk(false)}
        onConfirm={async () => { await api.removeSociety(clientId, s.code); setAsk(false); await refresh(); toast(`${s.code} deleted`, 'good') }}>
        <p>This removes {s.code} for this client:</p>
        <ul>
          <li>{s.report_count} {s.code} report{s.report_count === 1 ? '' : 's'} and the uploaded file{s.report_count === 1 ? '' : 's'}</li>
          <li>the {s.code} status of every song (registered / amend / register) and its history</li>
          {s.code === 'IPRS' && <li>the songs that only the IPRS report added to the catalogue</li>}
        </ul>
        <p className="small muted">Our master and the other societies are not affected. You can add {s.code} again later. This cannot be undone.</p>
      </ConfirmDialog>
    </div>
  )
}

/** Step 1 – today's LNV against one DSP sheet: what is still open in the review. */
function CleanTile({ clientId }: { clientId: number }) {
  const { detail } = useClient()
  const navigate = useNavigate()
  const c = detail?.clean
  const open = c?.summary.open
  const left = open ? open.duplicates + open.names + open.missing + open.check : 0
  return (
    <div className={`soc-tile ${!c ? 'not_started' : left ? 'in_progress' : 'completed'}`}>
      <div className="soc-tile-head">
        <div><b>Data clean</b><small>Step 1 · compare the LNV with the Muso / Spotify / Apple export</small></div>
        <span className={`badge ${!c ? 'neutral' : left ? 'info' : 'good'}`}>{!c ? 'Not started' : left ? 'In review' : 'Reviewed'}</span>
      </div>
      {c ? (
        <>
          <p className="small"><Sparkles size={14} className="inline-icon" />{c.source} · {c.name}</p>
          {open && (
            <div className="soc-tile-figs">
              <span><b>{c.summary.matched ?? 0}</b> songs found</span>
              <span><b className="t-warn">{open.duplicates}</b> duplicates</span>
              <span><b className="t-bad">{open.missing}</b> missing</span>
              <span><b>{open.names}</b> name spellings</span>
            </div>
          )}
        </>
      ) : <p className="small muted">Compare today's LNV with the client's DSP sheet from MRM-Extractor: duplicates, name spellings and missing songs in one pass.</p>}
      <div className="soc-tile-actions">
        <Button variant={c && !left ? 'default' : 'primary'} disabled={!detail?.master} onClick={() => navigate(`/clients/${clientId}/clean`)}>
          {c ? (left ? `Continue – ${left.toLocaleString()} to decide` : 'Open') : 'Start data clean'}<ArrowRight size={15} />
        </Button>
      </div>
    </div>
  )
}

function AddSociety() {
  const { detail, clientId, refresh } = useClient()
  const [open, setOpen] = useState(false)
  const options = (detail?.available_societies ?? []).filter((s) => !s.added)
  if (!options.length) return null
  return (
    <div className="soc-tile add">
      {!open ? (
        <button type="button" className="add-soc" onClick={() => setOpen(true)}><Plus size={20} /><b>Add a society</b><small>PRS, ASCAP, SOCAN…</small></button>
      ) : (
        <div className="add-soc-list">
          {options.map((s) => (
            <button key={s.code} type="button" disabled={!s.available} onClick={async () => { await api.addSocieties(clientId, [s.code]); await refresh(); setOpen(false) }}>
              <b>{s.name}</b><small>{s.available ? s.country : 'coming soon'}</small>
            </button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      )}
    </div>
  )
}

export default function ClientHome() {
  const { detail, clientId, refresh } = useClient()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [askMaster, setAskMaster] = useState(false)
  const d = detail!
  const m = d.master
  const replace = async (f: File) => {
    setBusy(true)
    try { await api.uploadMaster(clientId, f); await refresh(); toast('Master replaced – every society is re-checked against it', 'good') }
    catch (e) { toast((e as Error).message, 'bad') } finally { setBusy(false) }
  }

  return (
    <div className="stack">
      <section>
        <h2 className="section-h">Reconciliation</h2>
        <div className="soc-tiles">
          <div className={`soc-tile master ${m ? 'completed' : 'not_started'}`}>
            <div className="soc-tile-head">
              <div><b>Our master</b><small>Central catalogue · shared by every society</small></div>
              <span className={`badge ${m ? 'good' : 'bad'}`}>{m ? 'Loaded' : 'Missing'}</span>
            </div>
            {m ? (
              <>
                <p className="small"><FileSpreadsheet size={14} className="inline-icon" />{m.name}</p>
                <div className="soc-tile-figs">
                  <span><b>{m.stats.songs}</b> songs</span><span><b>{d.works}</b> works in catalogue</span>
                  {!!m.stats.issues && <span className="t-warn"><b>{m.stats.issues}</b> problems</span>}
                </div>
                <p className="small muted">Uploaded {fmtDate(m.uploaded_at)}</p>
              </>
            ) : <p className="small muted">Upload the client's LNV master before starting a society.</p>}
            <div className="soc-tile-actions">
              <input ref={input} type="file" hidden accept=".xlsx,.xlsm" onChange={(e) => { const f = e.target.files?.[0]; if (f) replace(f); e.target.value = '' }} />
              <Button variant={m ? 'default' : 'primary'} icon={busy ? <span className="spinner small-dark" /> : <RefreshCw size={14} />} onClick={() => input.current?.click()}>
                {m ? 'Replace master' : 'Upload master'}
              </Button>
              {m && <><span className="grow" /><Button variant="ghost" icon={<Trash2 size={15} />} aria-label="Delete master" title="Delete master" onClick={() => setAskMaster(true)} /></>}
            </div>
          </div>
          <CleanTile clientId={clientId} />
          {d.societies.map((s) => <SocietyCard key={s.code} s={s} clientId={clientId} />)}
          <AddSociety />
        </div>
      </section>

      <ConfirmDialog open={askMaster} title="Delete our master?" confirmLabel="Delete master" onCancel={() => setAskMaster(false)}
        onConfirm={async () => { await api.deleteMaster(clientId); setAskMaster(false); await refresh(); toast('Master deleted', 'good') }}>
        <p>The master file <b>{m?.name}</b> (and any older versions) is removed.</p>
        <p className="small muted">The societies keep their reports but cannot be compared until you upload a new master – use “Upload master” on this card.</p>
      </ConfirmDialog>

      {d.works > 0 && (
        <div>
          <Card title="Catalogue health" description="Across all societies checked so far.">
            <div className="health-rows">
              {Object.entries(d.coverage).map(([soc, c]) => (
                <div key={soc} className="health-row"><span>Registered at {soc}</span><span className="pct-bar"><span className="good" style={{ width: `${pct(c.registered, c.total)}%` }} /></span><b>{pct(c.registered, c.total)}%</b><small className="muted">{c.registered}/{c.total}</small></div>
              ))}
              <div className="health-row"><span>Client credited</span><span className="pct-bar"><span className="good" style={{ width: `${pct(d.credited, d.works)}%` }} /></span><b>{pct(d.credited, d.works)}%</b><small className="muted">{d.credited}/{d.works}</small></div>
              <div className="health-row"><span>Have an ISWC</span><span className="pct-bar"><span className="warn" style={{ width: `${pct(d.with_iswc, d.works)}%` }} /></span><b>{pct(d.with_iswc, d.works)}%</b><small className="muted">{d.with_iswc}/{d.works}</small></div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
