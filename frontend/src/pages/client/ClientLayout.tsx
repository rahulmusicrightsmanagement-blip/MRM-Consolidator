import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Check, ListChecks, Library, Trash2, Wrench } from 'lucide-react'
import type { CSSProperties } from 'react'
import { AppShell } from '../../components/AppShell'
import { Button, ConfirmDialog, Empty, Mono } from '../../components/ui'
import { api } from '../../lib/api'
import { ClientProvider, fmtDate, today, useClient } from '../../lib/client'
import { useToast } from '../../lib/toast'
import { STAGES, hue, initials, journeyNote } from '../Tracker'
import type { ClientMetrics } from '../../types'

export default function ClientLayout() {
  const { clientId } = useParams()
  return (
    <ClientProvider clientId={Number(clientId)}>
      <ClientFrame />
    </ClientProvider>
  )
}

function ClientFrame() {
  const { detail, error, saveClient, clientId } = useClient()
  const navigate = useNavigate()
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  if (error) return <AppShell><Empty title="Client not found">{error}</Empty></AppShell>
  if (!detail) return <AppShell><div className="loading"><span className="spinner" />Loading…</div></AppShell>
  const c = detail.client
  const overdue = !!c.due_date && c.due_date < today() && detail.journey.step < 4
  const base = `/clients/${clientId}`
  return (
    <AppShell trail={<span className="trail-name">{c.name}</span>} side={<ClientNav base={base} name={c.name} journey={detail.journey} />}>
      <header className="client-top">
        <span className="client-avatar xl" style={{ '--h': hue(c.name) } as CSSProperties}>{initials(c.name)}</span>
        <div className="grow">
          <h1>{c.name}</h1>
          <dl className="client-props">
            <div><dt>IPI</dt><dd><Mono>{c.ipi || '—'}</Mono></dd></div>
            <div><dt>Catalogue</dt><dd>{detail.works.toLocaleString('en-IN')} works</dd></div>
            <div><dt>Owner</dt><dd><input key={c.owner} className="inline-input" defaultValue={c.owner} placeholder="Assign…"
              onBlur={(e) => e.target.value !== c.owner && saveClient({ owner: e.target.value })} /></dd></div>
            <div><dt>Due</dt><dd><input type="date" className={`inline-input date ${overdue ? 'overdue' : ''}`} value={c.due_date ?? ''}
              onChange={(e) => saveClient({ due_date: e.target.value || null })} /></dd></div>
            <div><dt>Status</dt><dd><span className={`status-pill p${detail.journey.step - 1}`}>Step {detail.journey.step} · {STAGES[detail.journey.step - 1]}</span>
              <span className="muted">{journeyNote(detail.journey)}</span></dd></div>
          </dl>
        </div>
        <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setConfirm(true)} aria-label="Delete client" title="Delete client" />
      </header>

      <Outlet />

      <ConfirmDialog open={confirm} title={`Delete ${c.name}?`} confirmLabel="Delete client" onCancel={() => setConfirm(false)}
        onConfirm={async () => { await api.deleteClient(c.id); toast(`${c.name} deleted`, 'good'); navigate('/') }}>
        <p>This removes the client, our master, every society's reports and their history. This cannot be undone.</p>
      </ConfirmDialog>
    </AppShell>
  )
}

/** The open client in the sidebar: its two stages, each with its own steps (done, current, to come), and its other
 *  pages. Stage 1, Muso vs LNV: the files, then the check – marked completed. Stage 2, LNV vs IPRS: the stage 2 LNV
 *  (extracted from stage 1, or uploaded), the check against the IPRS report, the final LNV. */
function ClientNav({ base, name, journey }: { base: string; name: string; journey: ClientMetrics['journey'] }) {
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const onFlow = pathname === base || pathname === `${base}/consolidate`
  const shown = Number(params.get('step')) || journey.step
  const filesShown = params.get('files') === '1'
  const f = journey.files, st1 = journey.stage1, l2 = journey.lnv2
  const n2 = journey.needs['2'], n3 = journey.needs['3']
  const lnv3 = !!(l2 || st1)   // the LNV stage 2 checks: extracted, uploaded – or, from before stages, the one uploaded
  const fmt = (x: number) => x.toLocaleString('en-IN')
  type Item = { key: string; n: number; title: string; note: string; to: string; on: boolean; done: boolean; now: boolean; count?: number | null }
  const stages: { label: string; items: Item[] }[] = [
    { label: 'Stage 1 · Muso vs LNV', items: [
      { key: 'files', n: 1, title: 'Files', note: f.lnv && f.dsp ? 'LNV and Muso export in' : 'Add the LNV and the Muso export',
        to: `${base}?step=1`, on: shown === 1, done: f.lnv && f.dsp, now: journey.step === 1 },
      { key: 'muso', n: 2, title: 'Muso vs LNV', note: st1 ? `Completed ${fmtDate(st1.done_at)}` : n2 == null ? 'Not opened yet' : n2 ? `${fmt(n2)} need you` : 'Ready to mark completed',
        to: `${base}?step=2`, on: shown === 2, done: !!st1, now: journey.step === 2, count: !st1 && n2 ? n2 : null },
    ] },
    { label: 'Stage 2 · LNV vs IPRS', items: [
      { key: 'lnv2', n: 1, title: 'Stage 2 LNV', note: l2 ? (l2.origin === 'stage1' ? 'Extracted from stage 1' : `Uploaded ${fmtDate(l2.uploaded_at)}`)
        : st1 ? 'The LNV as uploaded' : 'After stage 1 – or upload one',
        to: `${base}?step=3&files=1`, on: shown === 3 && (filesShown || !f.iprs), done: lnv3, now: journey.step === 3 && !lnv3 },
      { key: 'iprs', n: 2, title: 'LNV vs IPRS', note: !f.iprs ? 'Needs the IPRS report' : n3 == null ? 'Not opened yet' : n3 ? `${fmt(n3)} need you` : 'Every song checked',
        to: `${base}?step=3`, on: shown === 3 && !filesShown && !!f.iprs, done: journey.step >= 4, now: journey.step === 3 && lnv3, count: f.iprs && n3 ? n3 : null },
      { key: 'final', n: 3, title: 'Final LNV', note: journey.step >= 4 ? 'Ready to download' : 'With the IPRS answers',
        to: `${base}?step=4`, on: shown === 4, done: false, now: journey.step === 4 },
    ] },
  ]
  return (
    <div className="side-client">
      <div className="side-label">Client</div>
      <Link to={base} className="side-client-name" title={name}><span className="client-avatar" style={{ '--h': hue(name) } as CSSProperties}>{initials(name)}</span><b>{name}</b></Link>
      {stages.map((st) => (
        <div key={st.label} className="side-stage">
          <div className="side-stage-label lbl">{st.label}</div>
          <ol className="side-steps">
            {st.items.map((x) => (
              <li key={x.key}>
                <Link to={x.to} title={`${st.label} – ${x.title}: ${x.note}`} className={`${onFlow && x.on ? 'active' : ''} ${x.done ? 'done' : ''} ${x.now ? 'now' : ''}`}>
                  <span className="side-step-n">{x.done ? <Check size={11} strokeWidth={3} /> : x.n}</span>
                  <span className="grow lbl side-step-text"><span>{x.title}</span><small>{x.note}</small></span>
                  {x.count ? <span className="side-count">{fmt(x.count)}</span> : null}
                </Link>
              </li>
            ))}
          </ol>
        </div>
      ))}
      <nav className="side-nav">
        <NavLink to={`${base}/tasks`} title="Follow-up tasks"><ListChecks size={16} /><span className="lbl">Follow-up tasks</span></NavLink>
        <NavLink to={`${base}/catalogue`} title="Catalogue"><Library size={16} /><span className="lbl">Catalogue</span></NavLink>
        <NavLink to={`${base}/tools`} title="The society workspaces and other tools." className={({ isActive }) => isActive || pathname.includes('/societies/') ? 'active' : ''}><Wrench size={16} /><span className="lbl">More tools</span></NavLink>
      </nav>
    </div>
  )
}
