import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, CalendarDays, ChevronRight, RefreshCw, Trash2, UserPlus, Users } from 'lucide-react'
import type { CSSProperties } from 'react'
import { AppShell } from '../components/AppShell'
import { Button, ConfirmDialog, DataTable, Empty } from '../components/ui'
import { api } from '../lib/api'
import { fmtDate, today } from '../lib/client'
import { useToast } from '../lib/toast'
import type { ClientMetrics, ClientRow } from '../types'

/** The consolidate flow every client goes through, one step after the other. */
export const STAGES = ['Upload files', 'Review matches', 'IPRS check', 'Download']
const at = (c: ClientMetrics) => (c.journey?.step ?? 1) - 1

/** What still needs a person in the client's current step, in a few words. */
export function journeyNote(j?: ClientMetrics['journey']) {
  if (!j) return ''
  if (j.step === 1) return [!j.files.lnv && 'the LNV', !j.files.dsp && `the ${j.source} export`].filter(Boolean).join(' and ').replace(/^/, 'Needs ')
  const n = j.needs[String(j.step) as '2' | '3']
  if (j.step === 4) return 'Ready to download'
  return n == null ? 'Not opened yet' : `${n.toLocaleString('en-IN')} to review`
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase()
/** A steady hue per name, so each client keeps its avatar colour. */
export const hue = (name: string) => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)
const daysUntil = (d: string) => Math.round((new Date(d + 'T00:00:00').getTime() - new Date(today() + 'T00:00:00').getTime()) / 86400000)

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

  const overdue = useMemo(() => (clients ?? []).filter((c) => c.due_date && c.due_date < today() && at(c) < 3).length, [clients])
  const rows = clients ?? []

  return (
    <AppShell>
      <header className="page-header">
        <div><h1>Clients</h1>
          <p className="lede">{loading ? 'Loading…' : <>{rows.length} client{rows.length === 1 ? '' : 's'}
            {overdue > 0 && <> · <span className="t-bad">{overdue} overdue</span></>}</>}</p></div>
        <div className="page-actions"><Button variant="primary" icon={<UserPlus size={15} />} onClick={() => navigate('/clients/new')}>Add client</Button></div>
      </header>

      <section className="card flush tracker">
        {loading ? (error ? (
          <Empty icon={<AlertTriangle size={22} />} title="Could not load the clients"
            action={<Button icon={<RefreshCw size={14} />} onClick={load}>Try again</Button>}>{error}</Empty>
        ) : (
          <div className="loading"><span className="spinner" />Loading clients…</div>
        )) : clients.length === 0 ? (
          <Empty icon={<Users size={22} />} title="No clients yet" action={<Button variant="primary" onClick={() => navigate('/clients/new')}>Add the first client</Button>}>
            Add a client, upload the LNV and the Muso export, review the possible matches, download the updated LNV.
          </Empty>
        ) : (
          <DataTable<ClientRow> rows={rows} rowKey={(c) => String(c.id)} 
            search={(c) => `${c.name} ${c.ipi} ${c.owner}`} onRowClick={(c) => navigate(`/clients/${c.id}`)}
            empty="No clients match."
            columns={[
              { key: 'client', header: 'Client', sort: (c) => c.name, render: (c) => (
                <div className="client-cell">
                  <span className="client-avatar" style={{ '--h': hue(c.name) } as CSSProperties}>{initials(c.name)}</span>
                  <div className="client-id"><strong>{c.name}</strong>
                    <span className="client-sub"><span>{c.works.toLocaleString()} works</span><span className="mono">IPI {c.ipi || '—'}</span></span></div>
                </div>
              ) },
              { key: 'progress', header: 'Next step', sort: (c) => at(c) * 100000 - (c.journey.needs[String(at(c) + 1) as '2'] ?? 0), render: (c) => (
                <div className="next-cell"><b>{STAGES[at(c)]}</b><span className="muted">{journeyNote(c.journey)}</span></div>
              ) },
              { key: 'owner', header: 'Owner', sort: (c) => c.owner || '~', render: (c) => <InlineOwner value={c.owner} onSave={(v) => patch(c, { owner: v })} /> },
              { key: 'due', header: 'Due', sort: (c) => c.due_date ?? '9999', render: (c) => (
                <DuePill value={c.due_date ?? null} done={at(c) >= 3} onSave={(v) => patch(c, { due_date: v })} />
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
