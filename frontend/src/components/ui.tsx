import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleDashed, CircleHelp,
  Download as DownloadIcon, FileSpreadsheet, Info, Search, Trash2, UploadCloud, X, XCircle,
} from 'lucide-react'

/* ---------- layout ---------- */

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="lede">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function Card({ title, description, actions, children, className = '', flush }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; flush?: boolean
}) {
  return (
    <section className={`card ${flush ? 'flush' : ''} ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {description && <p className="muted">{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <CircleDashed size={22} />}</div>
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  )
}

/* ---------- small pieces ---------- */

export function Stat({ label, value, hint, tone, icon, onClick, active }: {
  label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'info' | 'brand'
  icon?: ReactNode; onClick?: () => void; active?: boolean
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag className={`stat ${tone ?? ''} ${onClick ? 'clickable' : ''} ${active ? 'active' : ''}`} onClick={onClick}
      type={onClick ? 'button' : undefined}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-icon">{icon}</span>}
      </div>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </Tag>
  )
}

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'brand'
const TONE_ICON: Record<Tone, ReactNode> = {
  good: <CheckCircle2 size={13} />, warn: <AlertTriangle size={13} />, bad: <XCircle size={13} />,
  info: <Info size={13} />, neutral: <CircleDashed size={13} />, brand: <CircleHelp size={13} />,
}

export function Badge({ tone = 'neutral', children, icon = true }: { tone?: Tone; children: ReactNode; icon?: boolean }) {
  return <span className={`badge ${tone}`}>{icon && TONE_ICON[tone]}{children}</span>
}

const VALUE_TONES: Record<string, [Tone, string]> = {
  Match: ['good', 'Match'], Amend: ['warn', 'Amend'], Registration: ['bad', 'Registration'],
  matched: ['good', 'Matched'], differences: ['warn', 'Differences'], linked: ['good', 'Linked'],
  review: ['info', 'Needs review'], unmatched: ['bad', 'Not in master'],
  same: ['good', 'Same'], different: ['warn', 'Different'], missing_master: ['bad', 'Missing in master'],
  missing_iprs: ['info', 'Missing in IPRS'], fill: ['info', 'Filled in step 3'], ipi_mismatch: ['warn', 'IPI differs'],
  error: ['bad', 'Error'], warning: ['warn', 'Warning'], info: ['info', 'Info'],
  todo: ['neutral', 'To do'], in_progress: ['info', 'In progress'], submitted: ['brand', 'Submitted'],
  done: ['good', 'Done'], ignored: ['neutral', 'Not needed'],
}

export function StatusBadge({ value }: { value: string }) {
  const [tone, label] = VALUE_TONES[value] ?? ['neutral', value]
  return <Badge tone={tone}>{label}</Badge>
}

export function Button({ children, variant = 'default', size, icon, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'danger-solid'; size?: 'sm'; icon?: ReactNode
}) {
  return (
    <button type="button" {...rest} className={`btn ${variant} ${size ?? ''} ${rest.className ?? ''}`}>
      {icon}{children}
    </button>
  )
}

export function DownloadLink({ href, children, primary }: { href: string; children: ReactNode; primary?: boolean }) {
  return <a className={`btn ${primary ? 'primary' : 'default'}`} href={href}><DownloadIcon size={15} />{children}</a>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (id: T) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={value === t.id ? 'active' : ''}
          onClick={() => onChange(t.id)}>
          {t.label}{t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Progress({ value, max, tone = 'brand' }: { value: number; max: number; tone?: string }) {
  const pct = max ? Math.round((value / max) * 100) : 0
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-fill ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="mono">{children}</span>
}

/* ---------- file drop ---------- */

export function FileDrop({ title, hint, accept, fileName, busy, onFile, compact }: {
  title: string; hint: string; accept: string; fileName?: string | null; busy?: boolean; onFile: (f: File) => void; compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      className={`drop ${over ? 'over' : ''} ${fileName ? 'has-file' : ''} ${compact ? 'compact' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
      onClick={() => !busy && input.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click() }}
      role="button" tabIndex={0} aria-label={title}
    >
      <input ref={input} type="file" accept={accept} hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
      <div className="drop-icon" aria-hidden>
        {busy ? <span className="spinner" /> : fileName ? <FileSpreadsheet size={20} /> : <UploadCloud size={20} />}
      </div>
      <div className="drop-text">
        <strong>{fileName ?? title}</strong>
        <span className="muted">{busy ? 'Checking the file…' : fileName ? 'Drop a new file or click to replace' : hint}</span>
      </div>
    </div>
  )
}

/* ---------- drawer ---------- */

export function Drawer({ open, onClose, title, subtitle, children, width = 720 }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" style={{ width }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="drawer-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="drawer-sub">{subtitle}</div>}
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close" icon={<X size={18} />} />
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  )
}

/* ---------- data table ---------- */

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  sort?: (row: T) => string | number
  width?: string
  align?: 'right'
}

export interface Filter<T> {
  label: string
  options: { id: string; label: string }[]
  test: (row: T, id: string) => boolean
}

export function DataTable<T>({
  rows, columns, rowKey, search, filters, onRowClick, expand, pageSize = 50, empty, toolbar, selectable, bulk, initialSort,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  search?: (row: T) => string
  filters?: Filter<T>[]
  onRowClick?: (row: T, visible: T[]) => void
  expand?: (row: T) => ReactNode
  pageSize?: number
  empty?: ReactNode
  toolbar?: ReactNode
  selectable?: boolean
  bulk?: (selected: T[], clear: () => void) => ReactNode
  initialSort?: { key: string; desc?: boolean }
}) {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [sortKey, setSortKey] = useState<string | null>(initialSort?.key ?? null)
  const [desc, setDesc] = useState(initialSort?.desc ?? false)
  const [open, setOpen] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    let out = rows.filter((r) => (!q || !search || search(r).toLowerCase().includes(q)) &&
      (filters ?? []).every((f) => !chosen[f.label] || f.test(r, chosen[f.label])))
    const col = columns.find((c) => c.key === sortKey)
    if (col?.sort) {
      const get = col.sort
      out = [...out].sort((a, b) => {
        const x = get(a), y = get(b)
        const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
        return desc ? -cmp : cmp
      })
    }
    return out
  }, [rows, query, chosen, sortKey, desc, columns, filters, search])

  const pages = Math.max(1, Math.ceil(visible.length / pageSize))
  const current = Math.min(page, pages - 1)
  const slice = visible.slice(current * pageSize, (current + 1) * pageSize)
  const selectedRows = rows.filter((r) => selected.has(rowKey(r)))
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(rowKey(r)))
  const toggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(visible.map(rowKey)))
  const extraCols = (expand ? 1 : 0) + (selectable ? 1 : 0)

  return (
    <div className="table-wrap">
      {(search || filters?.length || toolbar) && <div className="table-toolbar">
        {search && (
          <label className="search">
            <Search size={15} />
            <input type="search" placeholder="Search…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} />
          </label>
        )}
        {(filters ?? []).map((f) => (
          <select key={f.label} value={chosen[f.label] ?? ''} aria-label={f.label} className={chosen[f.label] ? 'set' : ''}
            onChange={(e) => { setChosen({ ...chosen, [f.label]: e.target.value }); setPage(0) }}>
            <option value="">{f.label}: all</option>
            {f.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        ))}
        <span className="muted small grow">{visible.length === rows.length ? `${rows.length} rows` : `${visible.length} of ${rows.length} rows`}</span>
        {toolbar}
      </div>}
      {selectable && bulk && selectedRows.length > 0 && (
        <div className="bulk-bar">
          <strong>{selectedRows.length} selected</strong>
          {bulk(selectedRows, () => setSelected(new Set()))}
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="table-empty">{empty ?? 'Nothing matches.'}</div>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                {selectable && <th className="check"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select all" /></th>}
                {expand && <th className="check" />}
                {columns.map((c) => (
                  <th key={c.key} style={{ width: c.width }} className={`${c.sort ? 'sortable' : ''} ${c.align === 'right' ? 'right' : ''}`}
                    onClick={() => { if (!c.sort) return; if (sortKey === c.key) setDesc(!desc); else { setSortKey(c.key); setDesc(false) } }}>
                    <span>{c.header}{sortKey === c.key && (desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slice.map((r) => {
                const k = rowKey(r)
                const isOpen = open === k
                const clickable = !!(onRowClick || expand)
                return [
                  <tr key={k} className={`${clickable ? 'clickable' : ''} ${isOpen ? 'open' : ''} ${selected.has(k) ? 'selected' : ''}`}
                    onClick={() => { if (onRowClick) onRowClick(r, visible); else if (expand) setOpen(isOpen ? null : k) }}>
                    {selectable && (
                      <td className="check" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(k)} aria-label="Select row"
                          onChange={() => { const n = new Set(selected); if (n.has(k)) n.delete(k); else n.add(k); setSelected(n) }} />
                      </td>
                    )}
                    {expand && <td className="check chevron">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>}
                    {columns.map((c) => <td key={c.key} className={c.align === 'right' ? 'right' : ''}>{c.render(r)}</td>)}
                  </tr>,
                  isOpen && expand ? (
                    <tr key={k + '-detail'} className="detail-row"><td colSpan={columns.length + extraCols}>{expand(r)}</td></tr>
                  ) : null,
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="pager">
          <span className="muted small">Page {current + 1} of {pages}</span>
          <Button size="sm" disabled={current === 0} onClick={() => setPage(current - 1)} icon={<ChevronLeft size={14} />}>Prev</Button>
          <Button size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next<ChevronRight size={14} /></Button>
        </div>
      )}
    </div>
  )
}

/* ---------- confirm dialog ---------- */

export function ConfirmDialog({ open, title, children, confirmLabel = 'Delete', onConfirm, onCancel, tone = 'danger' }: {
  open: boolean; title: ReactNode; children: ReactNode; confirmLabel?: string
  onConfirm: () => Promise<void> | void; onCancel: () => void
  /** 'primary' for a confirmation that removes nothing. */
  tone?: 'danger' | 'primary'
}) {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])
  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className={`modal-icon ${tone}`}>{tone === 'danger' ? <Trash2 size={20} /> : <Check size={20} />}</div>
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <Button variant="ghost" disabled={busy} onClick={onCancel} autoFocus>Cancel</Button>
          <Button variant={tone === 'danger' ? 'danger-solid' : 'primary'} disabled={busy} icon={busy ? <span className="spinner small" /> : tone === 'danger' ? <Trash2 size={15} /> : <Check size={15} />}
            onClick={async () => { setBusy(true); try { await onConfirm() } finally { setBusy(false) } }}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  )
}
