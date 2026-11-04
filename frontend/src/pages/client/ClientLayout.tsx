import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Check, ListChecks, Library, Trash2, Wrench } from 'lucide-react'
import type { CSSProperties } from 'react'
import { AppShell } from '../../components/AppShell'
import { Button, ConfirmDialog, Empty, Mono } from '../../components/ui'
import { api } from '../../lib/api'
import { ClientProvider, today, useClient } from '../../lib/client'
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

const FLOW = ['Files', 'Muso & LNV', 'LNV vs IPRS', 'Final LNV']

/** The open client in the sidebar: its four steps (done, current, to come) and its other pages. */
function ClientNav({ base, name, journey }: { base: string; name: string; journey: ClientMetrics['journey'] }) {
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const onFlow = pathname === base || pathname === `${base}/consolidate`
  const shown = Number(params.get('step')) || journey.step
  return (
    <div className="side-client">
      <div className="side-label">Client</div>
      <Link to={base} className="side-client-name" title={name}><span className="client-avatar" style={{ '--h': hue(name) } as CSSProperties}>{initials(name)}</span><b>{name}</b></Link>
      <ol className="side-steps">
        {FLOW.map((title, i) => {
          const n = i + 1
          const done = n < journey.step
          const needs = n === journey.step && (n === 2 || n === 3) ? journey.needs[String(n) as '2' | '3'] : null
          return (
            <li key={title}>
              <Link to={`${base}?step=${n}`} title={`Step ${n}: ${title}`} className={`${onFlow && shown === n ? 'active' : ''} ${done ? 'done' : ''} ${n === journey.step ? 'now' : ''}`}>
                <span className="side-step-n">{done ? <Check size={11} strokeWidth={3} /> : n}</span>
                <span className="grow lbl">{title}</span>
                {needs ? <span className="side-count">{needs.toLocaleString('en-IN')}</span> : null}
              </Link>
            </li>
          )
        })}
      </ol>
      <nav className="side-nav">
        <NavLink to={`${base}/tasks`} title="Follow-up tasks"><ListChecks size={16} /><span className="lbl">Follow-up tasks</span></NavLink>
        <NavLink to={`${base}/catalogue`} title="Catalogue"><Library size={16} /><span className="lbl">Catalogue</span></NavLink>
        <NavLink to={`${base}/tools`} className={({ isActive }) => isActive || pathname.includes('/societies/') ? 'active' : ''}><Wrench size={16} /><span className="lbl">More tools</span></NavLink>
      </nav>
    </div>
  )
}
