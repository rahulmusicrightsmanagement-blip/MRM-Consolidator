import { useNavigate, useSearchParams } from 'react-router-dom'
import { Check, X } from 'lucide-react'
import { Badge, Card, DataTable, Mono } from '../../components/ui'
import type { Filter } from '../../components/ui'
import { REG_LABEL, TASK_TYPE, useClient } from '../../lib/client'
import type { RegStatus, WorkRow } from '../../types'

export function RegBadge({ status }: { status?: RegStatus }) {
  if (!status) return <span className="muted small">—</span>
  const r = REG_LABEL[status]
  return <Badge tone={r.tone}>{r.label}</Badge>
}

export default function Catalogue() {
  const { works, detail, clientId } = useClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const societies = Object.keys(detail?.coverage ?? {})
  const list = works ?? []
  // ?IPRS=not_registered style filters from the overview links
  const pre = societies.map((s) => [s, params.get(s)] as const).filter(([, v]) => v)
  const rows = list.filter((w) => pre.every(([s, v]) => w.registrations[s]?.status === v))
  const filters: Filter<WorkRow>[] = [
    { label: 'Tasks', options: [{ id: 'open', label: 'Has open tasks' }, { id: 'none', label: 'Nothing to do' }], test: (w, v) => (w.open_tasks > 0) === (v === 'open') },
    { label: 'Client credited', options: [{ id: 'yes', label: 'Credited' }, { id: 'no', label: 'Not credited' }], test: (w, v) => w.credited === (v === 'yes') },
    { label: 'Source', options: [{ id: 'master', label: 'In our master' }, { id: 'iprs', label: 'Added from IPRS' }], test: (w, v) => w.origin === v },
    { label: 'ISWC', options: [{ id: 'yes', label: 'Has ISWC' }, { id: 'no', label: 'No ISWC' }], test: (w, v) => !!w.identifiers.ISWC?.length === (v === 'yes') },
  ]
  if (!works) return <div className="loading"><span className="spinner" />Loading works…</div>
  return (
    <Card flush>
      {pre.length > 0 && (
        <div className="active-filter card-pad">
          Showing works that are {pre.map(([s, v]) => <b key={s}>{REG_LABEL[v!]?.label.toLowerCase()} at {s}</b>)}
          <button type="button" className="link-btn" onClick={() => setParams({}, { replace: true })}>Show all works</button>
        </div>
      )}
      <DataTable<WorkRow> rows={rows} rowKey={(w) => String(w.id)} filters={filters} onRowClick={(w) => navigate(`/clients/${clientId}/works/${w.id}`)}
        search={(w) => `${w.mrm_id} ${w.title} ${Object.values(w.identifiers).flat().join(' ')} ${w.writers.join(' ')}`}
        columns={[
          { key: 'title', header: 'Work', sort: (w) => w.title, render: (w) => (
            <div><strong>{w.title}</strong>{w.origin === 'iprs' && <span className="tag">added from IPRS</span>}{!w.in_latest && <span className="tag muted-tag">not in latest report</span>}
              <span className="small muted block"><Mono>{w.mrm_id}</Mono>{w.writers.length > 0 && ` · ${w.writers.slice(0, 2).join(', ')}${w.writers.length > 2 ? '…' : ''}`}</span></div>
          ) },
          { key: 'iswc', header: 'ISWC', render: (w) => <span className="small mono">{w.identifiers.ISWC?.[0] ?? <span className="t-bad">none</span>}</span> },
          ...societies.map((s) => ({
            key: s, header: s, sort: (w: WorkRow) => w.registrations[s]?.status ?? '',
            render: (w: WorkRow) => <div><RegBadge status={w.registrations[s]?.status} /><span className="small muted block mono">{w.registrations[s]?.codes.join(', ')}</span></div>,
          })),
          { key: 'credited', header: 'Credited', sort: (w) => Number(w.credited), render: (w) => w.credited ? <Check size={16} className="t-good" /> : <X size={16} className="t-bad" /> },
          { key: 'tasks', header: 'Open tasks', sort: (w) => w.open_tasks, render: (w) => w.open_tasks ? (
            <div className="task-mix">{w.task_types.map((t) => <span key={t} className={`mix-chip ${TASK_TYPE[t].tone}`}>{TASK_TYPE[t].short}</span>)}</div>
          ) : <span className="small t-good">none</span> },
        ]} />
    </Card>
  )
}
