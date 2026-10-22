import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlarmClock, AlertTriangle, CheckCircle2, FilePlus2, ListChecks, RefreshCw, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppShell } from '../components/AppShell'
import { Button, ConfirmDialog, DataTable, Empty } from '../components/ui'
import type { Filter } from '../components/ui'
import { api } from '../lib/api'
import { TASK_TYPES, fmtDate, pct, today } from '../lib/client'
import { useToast } from '../lib/toast'
import type { ClientMetrics, ClientRow, Coverage, SocietySummary } from '../types'

export const STAGES = ['Needs master', 'Master loaded', 'Societies in progress', 'All societies complete']

export function StageDots({ stage }: { stage?: ClientMetrics['stage'] }) {
  const n = stage?.index ?? 0
  return (
    <div className="stage-cell" title={STAGES[n]}>
      <span className="stage-dots" aria-hidden>
        {[1, 2, 3].map((i) => <span key={i} className={i <= n ? (n === 3 ? 'on done' : 'on') : ''} />)}
      </span>
      <span className={`stage-label s${n}`}>{STAGES[n]}</span>
    </div>
  )
}

/** Registered share of the catalogue at one society, with what is still wrong. */
export function CoverageCell({ c }: { c?: Coverage }) {
  if (!c) return <span className="muted small">not checked</span>
  const p = pct(c.registered, c.total)
  const amend = (c.statuses.needs_amend ?? 0) + (c.statuses.duplicate ?? 0)
  return (
    <div className="cov-cell" title={`${c.registered} of ${c.total} works registered`}>
      <div className="cov-top"><b>{p}%</b><span className="muted small">{c.registered}/{c.total}</span></div>
      <span className="pct-bar"><span style={{ width: `${p}%` }} /></span>
      {amend > 0 && <span className="small t-warn">{amend} need amendment</span>}
    </div>
  )
}

/** One society for one client: status, step, registered share, what to amend / register. */
export function SocietyCell({ s }: { s?: SocietySummary }) {
  if (!s) return <span className="muted small">not added</span>
  const total = s.steps.length
  const step = s.report?.confirmed_step ?? 0
  return (
    <div className="soc-cell">
      <span className={`soc-status ${s.status}`}><span className={`soc-dot ${s.status}`} />
        {s.status === 'completed' ? 'Completed' : s.status === 'in_progress' ? `Step ${Math.min(step + 1, total)}/${total}` : 'Not started'}</span>
      {s.coverage && <span className="small"><b>{pct(s.coverage.registered, s.coverage.total)}%</b> registered · <b className="t-warn">{s.coverage.statuses.needs_amend ?? 0}</b> amend · <b className="t-bad">{s.coverage.statuses.not_registered ?? 0}</b> register</span>}
    </div>
  )
}

export function TaskMix({ byType }: { byType: ClientMetrics['tasks']['by_type'] }) {
  const open = TASK_TYPES.map((t) => ({ ...t, n: Object.entries(byType).filter(([k]) => k.endsWith('|' + t.id)).reduce((s, [, v]) => s + v.open, 0) }))
    .filter((t) => t.n > 0)
  if (!open.length) return <span className="work-count clear"><CheckCircle2 size={12} /> none open</span>
  return <div className="task-mix">{open.map((t) => <span key={t.id} className={`mix-chip ${t.tone}`}>{t.n} {t.short}</span>)}</div>
}

function InlineOwner({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  return <input className="inline-input" value={v} placeholder="Assign…" onClick={(e) => e.stopPropagation()}
    onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} aria-label="Owner" />
}

/** The last list loaded, shown at once when the tracker is opened again while a fresh copy loads. */
let lastClients: ClientRow[] | null = null

export default function Tracker() {
  const [clients, setClients] = useState<ClientRow[] | null>(lastClients)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<number | null>(null)
  const [ask, setAsk] = useState<ClientRow | null>(null)
  const navigate = useNavigate()
  const toast = useToast()
  const load = useCallback(() => {
    setError(null)
    api.clients().then((d) => setClients(d.clients)).catch((e) => setError((e as Error).message))
  }, [])
  useEffect(load, [load])
  useEffect(() => { if (clients) lastClients = clients }, [clients])
  const loading = clients === null

  const patch = async (c: ClientRow, p: { owner?: string; due_date?: string | null }) => {
    await api.updateClient(c.id, p)
    setClients((cs) => (cs ?? []).map((x) => x.id === c.id ? { ...x, ...p } : x))
    toast('Saved', 'good')
  }

  const stats = useMemo(() => {
    const list = clients ?? []
    const works = list.reduce((n, c) => n + c.works, 0)
    const registered = list.reduce((n, c) => n + Object.values(c.coverage).reduce((m, v) => m + v.registered, 0), 0)
    const slots = list.reduce((n, c) => n + Object.values(c.coverage).reduce((m, v) => m + v.total, 0), 0)
    return {
      total: list.length, works,
      coverage: pct(registered, slots),
      amend: list.reduce((n, c) => n + Object.values(c.coverage).reduce((m, v) => m + (v.statuses.needs_amend ?? 0), 0), 0),
      register: list.reduce((n, c) => n + Object.values(c.coverage).reduce((m, v) => m + (v.statuses.not_registered ?? 0), 0), 0),
      overdue: list.filter((c) => (c.due_date && c.due_date < today() && c.stage.index < 3) ).length,
      byStage: STAGES.map((_, i) => list.filter((c) => c.stage.index === i).length),
    }
  }, [clients])

  const rows = (clients ?? []).filter((c) => stage === null || c.stage.index === stage)
  const societyCodes = [...new Set((clients ?? []).flatMap((c) => c.societies.map((s) => s.code)))]
  const owners = [...new Set((clients ?? []).map((c) => c.owner).filter(Boolean))]
  const filters: Filter<ClientRow>[] = [
    { label: 'Owner', options: [...owners.map((o) => ({ id: o, label: o })), { id: '__none', label: 'Unassigned' }], test: (c, v) => v === '__none' ? !c.owner : c.owner === v },
    { label: 'Due', options: [{ id: 'overdue', label: 'Overdue' }, { id: 'none', label: 'No due date' }], test: (c, v) =>
      v === 'none' ? !c.due_date : (!!c.due_date && c.due_date < today() && c.stage.index < 3) },
  ]

  const tile = (icon: ReactNode, value: ReactNode, label: string, tone: string, hint?: string) => (
    <div className={`tile ${tone}`}><span className="tile-icon">{icon}</span>
      <span className="tile-value">{loading ? <span className="skeleton" aria-label="Loading" /> : value}</span>
      <span className="tile-label">{label}</span>{hint && <span className="tile-hint">{hint}</span>}</div>
  )

  return (
    <AppShell>
      <header className="page-header">
        <div><div className="eyebrow">MRM</div><h1>Client tracker</h1>
          <p className="lede">Every client's catalogue: how much is registered at each society, what is still open, who owns it and when it is due.</p></div>
        <div className="page-actions"><Button variant="primary" icon={<UserPlus size={15} />} onClick={() => navigate('/clients/new')}>Add client</Button></div>
      </header>

      <div className="tiles six">
        {tile(<Users size={18} />, stats.total, 'Clients', 'neutral', loading ? 'Loading…' : `${stats.works} works`)}
        {tile(<ShieldCheck size={18} />, `${stats.coverage}%`, 'Registered', 'good', 'across all societies checked')}
        {tile(<ListChecks size={18} />, stats.amend, 'To amend', 'warn', 'all clients, all societies')}
        {tile(<FilePlus2 size={18} />, stats.register, 'To register', 'bad', 'all clients, all societies')}
        {tile(<AlarmClock size={18} />, stats.overdue, 'Clients overdue', stats.overdue ? 'bad' : 'neutral')}
        {tile(<FilePlus2 size={18} />, stats.byStage[3], 'Completed', 'info', 'all societies complete')}
      </div>

      <div className="stage-filter" role="tablist" aria-label="Stage">
        <button type="button" className={stage === null ? 'active' : ''} onClick={() => setStage(null)}>All<span>{loading ? '…' : stats.total}</span></button>
        {STAGES.map((label, i) => (
          <button key={label} type="button" className={stage === i ? 'active' : ''} onClick={() => setStage(stage === i ? null : i)}>
            <span className={`stage-pip s${i}`} />{label}<span>{loading ? '…' : stats.byStage[i]}</span>
          </button>
        ))}
      </div>

      <section className="card flush">
        {loading ? (error ? (
          <Empty icon={<AlertTriangle size={22} />} title="Could not load the clients"
            action={<Button icon={<RefreshCw size={14} />} onClick={load}>Try again</Button>}>{error}</Empty>
        ) : (
          <div className="loading"><span className="spinner" />Loading clients…</div>
        )) : clients.length === 0 ? (
          <Empty icon={<Users size={22} />} title="No clients yet" action={<Button variant="primary" onClick={() => navigate('/clients/new')}>Add the first client</Button>}>
            Add a client, load our master, then work through IPRS and PRS one at a time.
          </Empty>
        ) : (
          <DataTable<ClientRow> rows={rows} rowKey={(c) => String(c.id)} filters={filters}
            search={(c) => `${c.name} ${c.ipi} ${c.owner}`} onRowClick={(c) => navigate(`/clients/${c.id}`)}
            empty="No clients at this stage."
            columns={[
              { key: 'client', header: 'Client', sort: (c) => c.name, render: (c) => (
                <div className="client-cell"><span className="avatar sm">{c.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
                  <div><strong>{c.name}</strong><span className="small muted block">{c.works} works · IPI {c.ipi || '—'}</span></div></div>
              ) },
              { key: 'stage', header: 'Stage', sort: (c) => c.stage.index, render: (c) => <StageDots stage={c.stage} /> },
              ...societyCodes.map((code) => ({ key: code, header: code, sort: (c: ClientRow) => c.societies.find((s) => s.code === code)?.status ?? '',
                render: (c: ClientRow) => <SocietyCell s={c.societies.find((s) => s.code === code)} /> })),
              { key: 'owner', header: 'Owner', sort: (c) => c.owner, render: (c) => <InlineOwner value={c.owner} onSave={(v) => patch(c, { owner: v })} /> },
              { key: 'due', header: 'Due', sort: (c) => c.due_date ?? '9999', render: (c) => {
                const overdue = !!c.due_date && c.due_date < today() && c.stage.index < 3
                return (
                  <div>
                    <input type="date" className={`inline-input date ${overdue ? 'overdue' : ''}`} value={c.due_date ?? ''} aria-label="Due date"
                      onClick={(e) => e.stopPropagation()} onChange={(e) => patch(c, { due_date: e.target.value || null })} />
                  </div>
                )
              } },
              { key: 'report', header: 'Latest report', sort: (c) => c.latest_report?.report_date ?? '', render: (c) => (
                <div className="small"><span className="block">{fmtDate(c.latest_report?.report_date)}</span><span className="muted">{c.report_count} report{c.report_count === 1 ? '' : 's'}</span></div>
              ) },
              { key: 'del', header: '', render: (c) => (
                <button type="button" className="icon-btn danger" aria-label={`Delete ${c.name}`} title="Delete client"
                  onClick={(e) => { e.stopPropagation(); setAsk(c) }}><Trash2 size={15} /></button>
              ) },
            ]} />
        )}
      </section>

      <ConfirmDialog open={!!ask} title={`Delete ${ask?.name}?`} confirmLabel="Delete client" onCancel={() => setAsk(null)}
        onConfirm={async () => {
          await api.deleteClient(ask!.id)
          setClients((cs) => (cs ?? []).filter((x) => x.id !== ask!.id))
          toast(`${ask!.name} deleted`, 'good')
          setAsk(null)
        }}>
        <p>This removes the client, our master, every society's reports and their history. This cannot be undone.</p>
      </ConfirmDialog>
    </AppShell>
  )
}
