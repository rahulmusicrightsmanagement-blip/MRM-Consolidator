import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ListChecks, Library, Trash2, Wrench } from 'lucide-react'
import type { CSSProperties } from 'react'
import { AppShell } from '../../components/AppShell'
import { Button, ConfirmDialog, Empty } from '../../components/ui'
import { api } from '../../lib/api'
import { ClientProvider, today, useClient } from '../../lib/client'
import { useToast } from '../../lib/toast'
import { hue, initials } from '../Tracker'

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
    <AppShell trail={<span className="trail-name">{c.name}</span>} side={<ClientNav base={base} name={c.name} />}>
      <header className="client-top slim">
        <span className="client-avatar" style={{ '--h': hue(c.name) } as CSSProperties}>{initials(c.name)}</span>
        <div className="grow">
          <h1>{c.name}</h1>
          <p className="muted">{[c.ipi && `IPI ${c.ipi}`, detail.works > 0 && `${detail.works.toLocaleString('en-IN')} works`].filter(Boolean).join(' · ')}</p>
        </div>
        <label className="client-field">Owner<input key={c.owner} className="inline-input" defaultValue={c.owner} placeholder="Assign…"
          onBlur={(e) => e.target.value !== c.owner && saveClient({ owner: e.target.value })} /></label>
        <label className="client-field">Due<input type="date" className={`inline-input date ${overdue ? 'overdue' : ''}`} value={c.due_date ?? ''}
          onChange={(e) => saveClient({ due_date: e.target.value || null })} /></label>
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

/** The open client in the sidebar: its flow, and the pages beside it. */
function ClientNav({ base, name }: { base: string; name: string }) {
  const { pathname } = useLocation()
  return (
    <div className="side-client">
      <div className="side-label">Client</div>
      <Link to={base} className="side-client-name" title={name}><span className="client-avatar" style={{ '--h': hue(name) } as CSSProperties}>{initials(name)}</span><b>{name}</b></Link>
      <nav className="side-nav">
        <NavLink to={`${base}/tasks`} title="Follow-up tasks"><ListChecks size={16} /><span className="lbl">Follow-up tasks</span></NavLink>
        <NavLink to={`${base}/catalogue`} title="Catalogue"><Library size={16} /><span className="lbl">Catalogue</span></NavLink>
        <NavLink to={`${base}/tools`} className={({ isActive }) => isActive || pathname.includes('/societies/') ? 'active' : ''}><Wrench size={16} /><span className="lbl">More tools</span></NavLink>
      </nav>
    </div>
  )
}
