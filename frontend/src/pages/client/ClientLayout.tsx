import { useState } from 'react'
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import { AppShell } from '../../components/AppShell'
import { Button, ConfirmDialog, Empty, Mono } from '../../components/ui'
import { api } from '../../lib/api'
import { ClientProvider, fmtDate, today, useClient } from '../../lib/client'
import { useToast } from '../../lib/toast'
import { StageDots } from '../Tracker'

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
  const overdue = !!c.due_date && c.due_date < today() && detail.stage.index < 5
  const base = `/clients/${clientId}`
  const cleanOpen = Object.entries(detail.clean?.summary.open ?? {}).reduce((n, [q, v]) => n + (q === 'matched' || q === 'fills' ? 0 : v), 0)
  return (
    <AppShell trail={<span className="trail-name">{c.name}</span>}>
      <header className="client-header card">
        <div className="client-header-top">
          <span className="avatar lg">{c.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
          <div className="grow"><h1>{c.name}</h1><p className="muted">IPI <Mono>{c.ipi || '—'}</Mono> · {detail.works} works in catalogue</p></div>
          <div className="run-actions">
            <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setConfirm(true)} aria-label="Delete client" title="Delete client" />
          </div>
        </div>
        <div className="client-meta">
          <label><span>Stage</span><StageDots stage={detail.stage} /></label>
          <label><span>Owner</span><input key={c.owner} className="inline-input" defaultValue={c.owner} placeholder="Assign…"
            onBlur={(e) => e.target.value !== c.owner && saveClient({ owner: e.target.value })} /></label>
          <label><span>Due date</span><input type="date" className={`inline-input date ${overdue ? 'overdue' : ''}`} value={c.due_date ?? ''}
            onChange={(e) => saveClient({ due_date: e.target.value || null })} /></label>
          <label><span>Home society</span><b className="meta-value">{c.home_society}</b></label>
          <label><span>Last report</span><b className="meta-value">{fmtDate(detail.latest_report?.report_date)}</b></label>
        </div>
      </header>

      <nav className="sub-tabs" aria-label="Client sections">
        <NavLink to={base} end>Home</NavLink>
        <NavLink to={`${base}/clean`}>Data clean{cleanOpen > 0 && <span className="mv-count warn">{cleanOpen.toLocaleString()}</span>}</NavLink>
        {detail.societies.map((s) => (
          <NavLink key={s.code} to={`${base}/societies/${s.code}`} className={({ isActive }) => `soc-link ${isActive ? 'active' : ''}`}>
            <span className={`soc-dot ${s.status}`} />{s.code}
          </NavLink>
        ))}
      </nav>

      <Outlet />

      <ConfirmDialog open={confirm} title={`Delete ${c.name}?`} confirmLabel="Delete client" onCancel={() => setConfirm(false)}
        onConfirm={async () => { await api.deleteClient(c.id); toast(`${c.name} deleted`, 'good'); navigate('/') }}>
        <p>This removes the client, our master, every society's reports and their history. This cannot be undone.</p>
      </ConfirmDialog>
    </AppShell>
  )
}
