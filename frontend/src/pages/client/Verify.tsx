import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import { Badge, Button, Card } from '../../components/ui'
import { api } from '../../lib/api'
import { useRun } from '../../lib/run'
import type { CheckStatus, PreviewCell, PreviewColumn, PreviewRow, VerifyCheck, VerifyResult } from '../../types'

const STEP_NAMES: Record<number, string> = { 1: 'Step 1 · Upload file & check headers', 2: 'Step 2 · Match & review – links to our master', 3: 'Step 2 · Match & review – IPRS columns (read back from the generated master)', 4: 'Step 3 · Reports' }
const ICON: Record<CheckStatus, React.ReactNode> = {
  pass: <CheckCircle2 size={17} />, warn: <AlertTriangle size={17} />, fail: <XCircle size={17} />, info: <Info size={17} />,
}

/** Step 4: independent checks of every step plus a before/after preview of the final master. */
export function VerifyAndPreview() {
  const { runId, payload } = useRun()
  const [data, setData] = useState<VerifyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [focus, setFocus] = useState<number | null>(null)
  const [nonce, setNonce] = useState(0)
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    api.verify(runId).then((d) => { if (live) { setData(d); setError(null) } })
      .catch((e) => { if (live) setError(e.message) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [runId, payload, nonce])

  const jump = (row: number) => { setFocus(row); previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }

  return (
    <div className="stack">
      <Card title={<span className="title-icon"><ShieldCheck size={18} />Verification</span>}
        description="Every step is checked again from the files themselves: the generated master is read back and compared with the uploaded master, cell by cell."
        actions={<Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} disabled={loading} onClick={() => setNonce((n) => n + 1)}>Check again</Button>}>
        {loading && !data ? <div className="loading"><span className="spinner" />Building the files and checking them…</div>
          : error ? <div className="alert bad small">{error}</div>
          : data && <Checks data={data} onJump={jump} />}
      </Card>
      <div ref={previewRef}>
        {data && <Preview data={data} focus={focus} clearFocus={() => setFocus(null)} />}
      </div>
    </div>
  )
}

function Checks({ data, onJump }: { data: VerifyResult; onJump: (row: number) => void }) {
  const s = data.summary
  const counted = s.pass + s.warn + s.fail
  const verdict = s.fail ? { tone: 'bad', text: `${s.fail} check${s.fail === 1 ? '' : 's'} failed – fix these before sending the files` }
    : s.warn ? { tone: 'warn', text: `No errors · ${s.warn} check${s.warn === 1 ? '' : 's'} need a look` }
    : { tone: 'good', text: `All ${counted} checks passed – the files are consistent` }
  return (
    <div className="stack">
      <div className={`verdict ${verdict.tone}`}>
        {verdict.tone === 'good' ? <CheckCircle2 size={22} /> : verdict.tone === 'warn' ? <AlertTriangle size={22} /> : <XCircle size={22} />}
        <b className="grow">{verdict.text}</b>
        <span className="verdict-stats">
          <span><b>{s.pass}</b> passed</span><span><b>{s.warn}</b> to check</span><span><b>{s.fail}</b> failed</span>
          <span><b>{s.cells_changed}</b> cells changed</span><span className={s.cells_unexplained ? 't-bad' : ''}><b>{s.cells_unexplained}</b> unexplained</span>
        </span>
      </div>
      {[1, 2, 3, 4].map((step) => {
        const list = data.checks.filter((c) => c.step === step)
        if (!list.length) return null
        return (
          <div key={step} className="check-group">
            <h4>{STEP_NAMES[step]}</h4>
            {list.map((c) => <CheckRow key={c.id} c={c} onJump={onJump} />)}
          </div>
        )
      })}
    </div>
  )
}

function CheckRow({ c, onJump }: { c: VerifyCheck; onJump: (row: number) => void }) {
  const [open, setOpen] = useState(c.status === 'fail')
  const can = c.items.length > 0
  return (
    <div className={`check-row ${c.status}`}>
      <button type="button" className="check-head" onClick={() => can && setOpen(!open)} aria-expanded={open} disabled={!can}>
        <span className="check-icon">{ICON[c.status]}</span>
        <span className="grow"><b>{c.label}</b><span className="small muted block">{c.detail}</span></span>
        {can && <><Badge tone="neutral" icon={false}>{c.items.length}</Badge>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</>}
      </button>
      {open && can && (
        <table className="kv-table check-items">
          <thead><tr><th>Row</th><th>IPRS work</th><th>Song</th><th>Detail</th><th /></tr></thead>
          <tbody>{c.items.map((i, n) => (
            <tr key={n}><td>{i.row ?? '—'}</td><td className="mono">{i.code ?? '—'}</td><td>{i.title || '—'}</td><td className="small">{i.detail}</td>
              <td>{i.row ? <Button size="sm" variant="ghost" onClick={() => onJump(i.row!)}>Show in preview</Button> : null}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  )
}

/* ---------------- preview of the final master ---------------- */

type RowFilter = 'all' | 'changed' | 'added' | 'amend' | 'unexpected'
const groupKey = (g: string) => g.replace(/\s+\d+$/, '')

function Preview({ data, focus, clearFocus }: { data: VerifyResult; focus: number | null; clearFocus: () => void }) {
  const { exportUrl } = useRun()
  const { columns, rows } = data.preview
  const groups = useMemo(() => [...new Set(columns.map((c) => groupKey(c.group)))], [columns])
  const [shown, setShown] = useState<Set<string>>(() => new Set(['Work details', 'IPRS']))
  const [onlyChanged, setOnlyChanged] = useState(true)
  const [rowFilter, setRowFilter] = useState<RowFilter>('all')
  const [query, setQuery] = useState('')
  const [showBefore, setShowBefore] = useState(false)
  const [picked, setPicked] = useState<{ row: PreviewRow; col: PreviewColumn; cell: PreviewCell | null } | null>(null)

  const changedCols = useMemo(() => new Set(rows.flatMap((r) => r.cells.filter((c) => c[3] !== 'same').map((c) => c[0]))), [rows])
  const cols = columns.filter((c) => shown.has(groupKey(c.group)) && (!onlyChanged || changedCols.has(c.col) || c.header.toLowerCase().startsWith('work')))
  const counts: Record<RowFilter, number> = {
    all: rows.length, changed: rows.filter((r) => r.changed).length, added: rows.filter((r) => r.kind === 'added').length,
    amend: rows.filter((r) => r.amend).length, unexpected: rows.filter((r) => r.unexpected).length,
  }
  const visible = rows.filter((r) => (focus ? r.row === focus : true)
    && (rowFilter === 'all' || (rowFilter === 'changed' ? r.changed > 0 : rowFilter === 'added' ? r.kind === 'added' : rowFilter === 'amend' ? r.amend : r.unexpected > 0))
    && (!query || r.title.toLowerCase().includes(query.toLowerCase())))
  // Column-group header cells (consecutive columns of one group share one header).
  const spans: { group: string; n: number }[] = []
  for (const c of cols) {
    if (spans.length && spans[spans.length - 1].group === c.group) spans[spans.length - 1].n++
    else spans.push({ group: c.group, n: 1 })
  }
  const toggle = (g: string) => setShown((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n })

  return (
    <Card flush title="Preview of the final master" description="Exactly what the downloaded master contains. Yellow = filled or changed, green = new song from IPRS, red = changed without a reason. Click a cell to see where its value came from."
      actions={<a className="btn primary sm" href={exportUrl('final')}>Download this master</a>}>
      <div className="preview-controls">
        <div className="chip-filters">
          {groups.map((g) => <button key={g} type="button" className={shown.has(g) ? 'active' : ''} onClick={() => toggle(g)}>{g === 'IPRS' ? 'IPRS blocks' : g === 'PRS' ? 'PRS blocks' : g}</button>)}
        </div>
        <div className="chip-filters">
          {(['all', 'changed', 'added', 'amend', 'unexpected'] as RowFilter[]).map((f) => (
            <button key={f} type="button" className={rowFilter === f ? 'active' : ''} onClick={() => { setRowFilter(f); clearFocus() }}>
              {{ all: 'All songs', changed: 'Changed', added: 'New from IPRS', amend: 'Amend', unexpected: 'Unexplained' }[f]} <b>{counts[f]}</b></button>
          ))}
          <input className="inline-input" placeholder="Search song…" value={query} onChange={(e) => { setQuery(e.target.value); clearFocus() }} />
          <label className="check-label"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />Only columns that changed</label>
          <label className="check-label"><input type="checkbox" checked={showBefore} onChange={(e) => setShowBefore(e.target.checked)} />Show old values</label>
        </div>
        {focus && <div className="alert info small">Showing row {focus} only. <button type="button" className="link-btn" onClick={clearFocus}>Show all rows</button></div>}
        {picked && (
          <div className="cell-detail">
            <div><span className="muted small">Cell</span><b>{picked.col.letter}{picked.row.row}</b><span className="small">{picked.col.header} · {picked.col.group}</span></div>
            <div><span className="muted small">Song</span><b>{picked.row.title}</b><span className="small">{picked.row.kind === 'added' ? 'new row from IPRS' : `master row ${picked.row.row}`}</span></div>
            <div><span className="muted small">Before</span><b className="mono">{picked.cell?.[1] || '—'}</b></div>
            <div><span className="muted small">After</span><b className="mono">{picked.cell?.[2] || '—'}</b></div>
            <div className="grow"><span className="muted small">Where it came from</span><b>{picked.cell ? (picked.cell[3] === 'same' ? 'Unchanged from our master' : picked.cell[4]) : 'Empty in both'}</b></div>
            <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Close</Button>
          </div>
        )}
      </div>
      <div className="sheet-wrap">
        <table className="sheet">
          <thead>
            <tr className="group-row"><th className="sticky c0" /><th className="sticky c1" />{spans.map((s, i) => <th key={i} colSpan={s.n}>{s.group}</th>)}</tr>
            <tr><th className="sticky c0">Row</th><th className="sticky c1">Work</th>{cols.map((c) => <th key={c.col} title={c.header}><span className="letter">{c.letter}</span>{c.header}</th>)}</tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const byCol = new Map(r.cells.map((c) => [c[0], c]))
              return (
                <tr key={r.row} className={r.kind}>
                  <th className="sticky c0">{r.row}</th>
                  <th className="sticky c1" title={r.title}>{r.title}{r.kind === 'added' && <span className="tag">new</span>}</th>
                  {cols.map((c) => {
                    const cell = byCol.get(c.col)
                    const state = cell?.[3] ?? 'same'
                    return (
                      <td key={c.col} className={`${state} ${picked?.row.row === r.row && picked.col.col === c.col ? 'picked' : ''}`}
                        title={cell ? `${c.letter}${r.row} ${c.header}\nBefore: ${cell[1] || '—'}\nAfter: ${cell[2] || '—'}${state !== 'same' ? `\n${cell[4]}` : ''}` : undefined}
                        onClick={() => setPicked({ row: r, col: c, cell: cell ?? null })}>
                        {cell ? <Fragment>{showBefore && state !== 'same' && cell[1] && <s className="old">{cell[1]}</s>}{cell[2]}</Fragment> : ''}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!visible.length && <p className="muted center pad">No songs match.</p>}
      </div>
    </Card>
  )
}
