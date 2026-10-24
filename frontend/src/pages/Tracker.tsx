import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronRight, RefreshCw, Trash2, UserPlus, Users } from 'lucide-react'
import type { CSSProperties } from 'react'
import { AppShell } from '../components/AppShell'
import { Button, ConfirmDialog, DataTable, Empty } from '../components/ui'
import type { Filter } from '../components/ui'
import { api } from '../lib/api'
import { fmtDate, pct, today } from '../lib/client'
import { useToast } from '../lib/toast'
import type { ClientMetrics, ClientRow, SocietySummary } from '../types'

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

/** One society for one client: status, step, and a bar of registered / to amend / to register. */
export function SocietyCell({ s, code }: { s?: SocietySummary; code?: string }) {
  if (!s) return <div className="soc-mini empty"><span className="soc-code">{code}</span><span className="small muted">Not added</span></div>
  const total = s.steps.length
  const step = s.report?.confirmed_step ?? 0
  const c = s.coverage
  const amend = (c?.statuses.needs_amend ?? 0) + (c?.statuses.duplicate ?? 0)
  const register = c?.statuses.not_registered ?? 0
  return (
    <div className={`soc-mini ${s.status}`}>
      <div className="soc-mini-head">
        <span className="soc-code">{s.code}</span>
        <span className={`soc-state ${s.status}`}>
          {s.status === 'completed' ? <><CheckCircle2 size={12} />Done</> : s.status === 'in_progress' ? `Step ${Math.min(step + 1, total)}/${total}` : 'Not started'}
        </span>
      </div>
      {c ? <>
        <span className="soc-bar" title={`${c.registered} registered · ${amend} to amend · ${register} to register (of ${c.total})`}>
          <i className="good" style={{ flexGrow: c.registered }} />
          <i className="warn" style={{ flexGrow: amend }} />
          <i className="bad" style={{ flexGrow: register }} />
        </span>
        <span className="soc-nums"><b>{pct(c.registered, c.total)}%</b>
          {amend > 0 && <span className="t-warn">{amend} amend</span>}
          {register > 0 && <span className="t-bad">{register} register</span>}</span>
      </> : <span className="small muted">Not checked yet</span>}
    </div>
  )
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase()
/** A steady hue per name, so each client keeps its avatar colour. */
export const hue = (name: string) => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)
const daysUntil = (d: string) => Math.round((new Date(d + 'T00:00:00').getTime() - new Date(today() + 'T00:00:00').getTime()) / 86400000)

function ago(d?: string | null) {
  if (!d) return 'No report'
  const n = -daysUntil(d.slice(0, 10))
  return n <= 0 ? 'Today' : n === 1 ? 'Yesterday' : n < 30 ? `${n} days ago` : fmtDate(d)
}

/** Registered share of the whole catalogue across societies. */
function Ring({ value }: { value: number }) {
  const r = 16, len = 2 * Math.PI * r
  return (
    <svg className={`ring ${value >= 95 ? 'good' : value >= 60 ? 'mid' : 'low'}`} width="44" height="44" viewBox="0 0 44 44" aria-hidden>
      <circle cx="22" cy="22" r={r} className="ring-track" />
      <circle cx="22" cy="22" r={r} className="ring-fill" strokeDasharray={`${(value / 100) * len} ${len}`} transform="rotate(-90 22 22)" />
      <text x="22" y="22" dy=".35em" textAnchor="middle">{value}%</text>
    </svg>
  )
}

function InlineOwner({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <label className={`owner-chip ${v ? '' : 'unset'}`} onClick={(e) => e.stopPropagation()}>
      <span className="owner-dot" style={{ '--h': hue(v || '?') } as CSSProperties}>{v ? initials(v) : <UserPlus size={12} />}</span>
      <input value={v} placeholder="Assign" size={Math.max(v.length, 6)} onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onSave(v)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} aria-label="Owner" />
    </label>
  )
}

/** Due date as a pill ("Due in 3 days", "5 days overdue"); clicking opens the date picker. */
function DuePill({ value, done, onSave }: { value: string | null; done: boolean; onSave: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const n = value ? daysUntil(value) : 0
  const tone = !value ? 'unset' : done ? 'done' : n < 0 ? 'overdue' : n <= 7 ? 'soon' : 'later'
  const text = !value ? 'Set due date' : done ? fmtDate(value)
    : n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'Due today' : n <= 7 ? `Due in ${n} day${n === 1 ? '' : 's'}` : fmtDate(value)
  return (
    <span className="due-wrap" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`due-pill ${tone}`} title={value ? `Due ${fmtDate(value)}` : 'Set a due date'}
        onClick={() => { try { ref.current?.showPicker() } catch { ref.current?.focus() } }}>
        <CalendarDays size={13} />{text}
      </button>
      <input ref={ref} type="date" className="due-input" tabIndex={-1} value={value ?? ''} aria-label="Due date"
        onChange={(e) => onSave(e.target.value || null)} />
    </span>
  )
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
    return {
      total: list.length,
      works: list.reduce((n, c) => n + c.works, 0),
      overdue: list.filter((c) => c.due_date && c.due_date < today() && c.stage.index < 3).length,
      byStage: STAGES.map((_, i) => list.filter((c) => c.stage.index === i).length),
    }
  }, [clients])
  const registered = (c: ClientRow) => {
    const cov = Object.values(c.coverage)
    return pct(cov.reduce((n, v) => n + v.registered, 0), cov.reduce((n, v) => n + v.total, 0))
  }

  const rows = (clients ?? []).filter((c) => stage === null || c.stage.index === stage)
  const societyCodes = [...new Set((clients ?? []).flatMap((c) => c.societies.map((s) => s.code)))]
  const owners = [...new Set((clients ?? []).map((c) => c.owner).filter(Boolean))]
  const filters: Filter<ClientRow>[] = [
    { label: 'Owner', options: [...owners.map((o) => ({ id: o, label: o })), { id: '__none', label: 'Unassigned' }], test: (c, v) => v === '__none' ? !c.owner : c.owner === v },
    { label: 'Due', options: [{ id: 'overdue', label: 'Overdue' }, { id: 'none', label: 'No due date' }], test: (c, v) =>
      v === 'none' ? !c.due_date : (!!c.due_date && c.due_date < today() && c.stage.index < 3) },
  ]

  return (
    <AppShell>
      <header className="page-header">
        <div><div className="eyebrow">MRM</div><h1>Clients</h1>
          <p className="lede">{loading ? 'Loading…' : <>{stats.total} client{stats.total === 1 ? '' : 's'} · {stats.works.toLocaleString()} works
            {stats.overdue > 0 && <> · <span className="t-bad">{stats.overdue} overdue</span></>}</>}</p></div>
        <div className="page-actions"><Button variant="primary" icon={<UserPlus size={15} />} onClick={() => navigate('/clients/new')}>Add client</Button></div>
      </header>

      <section className="card flush tracker">
        <div className="tracker-tabs" role="tablist" aria-label="Stage">
          <button type="button" role="tab" aria-selected={stage === null} className={stage === null ? 'active' : ''} onClick={() => setStage(null)}>
            All<span className="tab-count">{loading ? '…' : stats.total}</span></button>
          {STAGES.map((label, i) => (
            <button key={label} type="button" role="tab" aria-selected={stage === i} className={stage === i ? 'active' : ''} onClick={() => setStage(stage === i ? null : i)}>
              <span className={`stage-pip p${i}`} />{label}<span className="tab-count">{loading ? '…' : stats.byStage[i]}</span>
            </button>
          ))}
        </div>
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
                <div className="client-cell">
                  <span className="client-avatar" style={{ '--h': hue(c.name) } as CSSProperties}>{initials(c.name)}</span>
                  <div className="client-id"><strong>{c.name}</strong>
                    <span className="client-sub"><span>{c.works.toLocaleString()} works</span><span className="mono">IPI {c.ipi || '—'}</span></span></div>
                </div>
              ) },
              { key: 'progress', header: 'Progress', sort: (c) => c.stage.index * 1000 + registered(c), render: (c) => (
                <div className="progress-cell"><Ring value={registered(c)} />
                  <div><span className={`stage-name p${c.stage.index}`}>{STAGES[c.stage.index]}</span>
                    <span className="stage-steps" aria-hidden>{[0, 1, 2, 3].map((i) => <i key={i} className={i <= c.stage.index ? 'on' : ''} />)}</span></div>
                </div>
              ) },
              { key: 'societies', header: 'Societies', render: (c) => (
                <div className="soc-row">{societyCodes.map((code) => <SocietyCell key={code} code={code} s={c.societies.find((s) => s.code === code)} />)}</div>
              ) },
              { key: 'owner', header: 'Owner', sort: (c) => c.owner || '~', render: (c) => <InlineOwner value={c.owner} onSave={(v) => patch(c, { owner: v })} /> },
              { key: 'due', header: 'Due', sort: (c) => c.due_date ?? '9999', render: (c) => (
                <DuePill value={c.due_date ?? null} done={c.stage.index >= 3} onSave={(v) => patch(c, { due_date: v })} />
              ) },
              { key: 'report', header: 'Last report', sort: (c) => c.latest_report?.report_date ?? '', render: (c) => (
                <div className="report-cell"><span title={fmtDate(c.latest_report?.report_date)}>{ago(c.latest_report?.report_date)}</span>
                  <span className="muted">{c.report_count} report{c.report_count === 1 ? '' : 's'}</span></div>
              ) },
              { key: 'actions', header: '', render: (c) => (
                <div className="row-actions">
                  <button type="button" className="icon-btn danger" aria-label={`Delete ${c.name}`} title="Delete client"
                    onClick={(e) => { e.stopPropagation(); setAsk(c) }}><Trash2 size={15} /></button>
                  <ChevronRight size={16} className="row-go" aria-hidden />
                </div>
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
