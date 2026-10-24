import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Check, CheckCircle2, Download, ExternalLink, Info, Plus, RotateCcw, X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { StatusBar } from '../../components/StatusBar'
import {
  Badge, Button, Card, DataTable, Mono, StatusBadge, Tabs,
} from '../../components/ui'
import { useRun } from '../../lib/run'
import { songForWork } from '../../lib/model'
import { PairPanel, editable } from './PairPanel'
import type { Song } from '../../lib/model'
import type { Check as CheckT, Contributor, IprsWork, Link as MapLink, Status } from '../../types'

/* =================================================================== */
/* Step 5 – tune code check (read-only; follow-up lives in Tasks)       */
/* =================================================================== */

type TcFilter = 'all' | 'Match' | 'Amend' | 'Registration'

export function TunecodeTab() {
  const { model, payload, openSong } = useRun()
  const [params, setParams] = useSearchParams()
  const societies = model!.societies
  const soc = params.get('soc') || societies[0]
  const filter = (params.get('st') as TcFilter) || 'all'
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); n.set(k, v); setParams(n, { replace: true }) }
  const tc = payload!.result.tunecodes!
  const rows = model!.songs.filter((s) => filter === 'all' || s.tunecode?.societies[soc]?.status === filter)
  return (
    <div className="stack">
      <Explain>Each song's tune code is looked up at every society. <b>Match</b> – registered and agrees with our data.
        {' '}<b>Amend</b> – registered, but the society's registration is wrong or incomplete (e.g. the client is not credited).
        {' '}<b>Registration</b> – no tune code at that society. The Amend and Registration songs are in the two LNV reports above.</Explain>
      <div className={`soc-strip n${societies.length}`}>
        {societies.map((s) => {
          const c = tc.summary[s] as Record<Status, number>
          return (
            <div key={s} className="soc-strip-item">
              <strong>{s}</strong>
              <StatusBar label={`${s} tune codes`} segments={(['Match', 'Amend', 'Registration'] as Status[]).map((st) => ({
                label: st, value: c[st], tone: st === 'Match' ? 'good' : st === 'Amend' ? 'warning' : 'critical',
                onClick: () => { const n = new URLSearchParams(params); n.set('soc', s); n.set('st', st); setParams(n, { replace: true }) },
                active: soc === s && filter === st,
              }))} />
            </div>
          )
        })}
      </div>
      <Card flush>
        <div className="chip-filters">
          {(['all', 'Match', 'Amend', 'Registration'] as TcFilter[]).map((f) => (
            <button key={f} type="button" className={filter === f ? 'active' : ''} onClick={() => set('st', f)}>{f === 'all' ? 'All songs' : `${soc}: ${f}`}</button>
          ))}
          {societies.length > 1 && <select value={soc} onChange={(e) => set('soc', e.target.value)} aria-label="Society">{societies.map((s) => <option key={s}>{s}</option>)}</select>}
        </div>
        <DataTable<Song> rows={rows} rowKey={(s) => s.key} onRowClick={(s, vis) => openSong(s.key, vis.map((v) => v.key), `${soc}: ${filter === 'all' ? 'All songs' : filter}`)} search={(s) => `${s.title} ${Object.values(s.tunecode?.societies ?? {}).flatMap((x) => x.codes).join(' ')}`}
          columns={[
            { key: 'title', header: 'Song', sort: (s) => s.title, render: (s) => <div><strong>{s.title}</strong>{s.origin === 'iprs' && <span className="tag">added</span>}</div> },
            ...societies.flatMap((so) => [
              { key: so, header: so, sort: (s: Song) => s.tunecode?.societies[so]?.status ?? '', render: (s: Song) => s.tunecode ? <div><StatusBadge value={s.tunecode.societies[so].status} /><span className="small muted block mono">{s.tunecode.societies[so].codes.join(', ')}</span></div> : '—' },
            ]),
            { key: 'why', header: 'Why', render: (s) => <span className="small clamp">{Object.values(s.tunecode?.societies ?? {}).flatMap((x) => x.reasons)[0] ?? '—'}</span> },
          ]} />
      </Card>
    </div>
  )
}

function Candidates({ link }: { link: MapLink }) {
  const { decide, busy, payload } = useRun()
  const [manual, setManual] = useState('')
  return (
    <>
      {link.candidates.length > 0 && (
        <ul className="candidates">
          {link.candidates.map((c) => (
            <li key={c.row} className={c.row === link.master_row ? 'current' : ''}>
              <div><strong>{c.title}</strong> <span className="muted small">row {c.row}</span>
                <div className="small muted">{c.methods.length ? `Same ${c.methods.join(', ')}` : 'No shared identifier'} · title {c.title_score}% similar · {c.shared_contributors} shared contributor(s)</div></div>
              {c.row === link.master_row
                ? <Button size="sm" variant="danger" disabled={!!busy} onClick={() => decide(link.internal_no, 'reject', c.row)}>Not the same</Button>
                : <Button size="sm" variant="primary" disabled={!!busy} onClick={() => decide(link.internal_no, 'link', c.row)}>Link</Button>}
            </li>
          ))}
        </ul>
      )}
      <div className="manual">
        <select value={manual} onChange={(e) => setManual(e.target.value)} aria-label="Link to another master song">
          <option value="">Link to another master song…</option>
          {(payload!.result.master?.songs ?? []).map((s) => <option key={s.row} value={s.row}>{s.title} (row {s.row})</option>)}
        </select>
        <Button size="sm" disabled={!manual || !!busy} onClick={() => decide(link.internal_no, 'link', Number(manual))}>Link</Button>
        <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} disabled={!!busy} onClick={() => decide(link.internal_no, 'clear')}>Reset to automatic</Button>
      </div>
    </>
  )
}

/* =================================================================== */
/* Matching (steps 3 & 4)                                              */
/* =================================================================== */


/** What a difference between IPRS and our master leads to. */
export type DiffType = 'amend' | 'master' | 'info'
export const DIFF_TYPES: { id: DiffType; label: string; hint: string; tone: 'warn' | 'brand' | 'neutral' }[] = [
  { id: 'amend', label: 'Amend at IPRS', hint: 'writers, publishers, shares or ISWC disagree', tone: 'warn' },
  { id: 'master', label: 'Fix our master', hint: 'IPRS has the data, our master is empty', tone: 'brand' },
  { id: 'info', label: 'No action', hint: 'only title spelling, duration or version differ', tone: 'neutral' },
]
export function diffType(l: MapLink): DiffType | null {
  if (l.comparison?.status !== 'differences') return null
  const diff = l.comparison.fields.filter((f) => f.result === 'different' || f.result === 'missing_master')
  if (diff.some((f) => f.result === 'different' && ['Authors', 'Composers', 'Publishers', 'ISWC'].includes(f.field))) return 'amend'
  if (diff.some((f) => f.result === 'missing_master')) return 'master'
  return 'info'
}

type MapFilter = 'all' | 'review' | 'matched' | DiffType | 'unmatched' | 'master_only'
const MAP_FILTERS: { id: MapFilter; label: string; tone: string; explain: string }[] = [
  { id: 'all', label: 'All IPRS works', tone: '', explain: 'Every work in the IPRS report and the master song it was linked to (by IPRS tune code, then ISWC, then ISRC, then title + writer).' },
  { id: 'review', label: 'Needs your decision', tone: 'brand', explain: 'A master song with the same or a very close title was found, but there is no writer or identifier to prove it (e.g. the master row has no writers). Confirm or reject it above – "Confirm all" accepts every suggestion.' },
  { id: 'matched', label: 'Matched', tone: 'good', explain: 'Linked to our master and every field agrees (an ISWC / ISRC our master does not have yet is filled in step 3). Nothing to do.' },
  { id: 'amend', label: 'Amend at IPRS', tone: 'warn', explain: 'Linked, but writers, publishers, shares or ISWC disagree between IPRS and our master – the IPRS registration may need an amendment.' },
  { id: 'master', label: 'Fix our master', tone: 'brand', explain: 'Linked, IPRS has data that our master is missing (writers, publisher or ISWC) – update our master.' },
  { id: 'info', label: 'No action', tone: '', explain: 'Linked, only the title spelling, duration or version differ. Nothing changes who gets paid.' },
  { id: 'unmatched', label: 'Not in master', tone: 'bad', explain: 'IPRS works our master does not have. They are added to the final report.' },
  { id: 'master_only', label: 'Only in master', tone: '', explain: 'Songs in our master with no IPRS work – they need to be registered at IPRS.' },
]

/** Step "Map with master": one filter row, one table. */
export function MapTab() {
  const { payload, openSong, model, editMaster, busy, exportUrl } = useRun()
  const [params, setParams] = useSearchParams()
  // Old links used map=differences&dt=…; anything unknown falls back to "All IPRS works".
  const raw = params.get('map') === 'differences' ? params.get('dt') : params.get('map')
  const filter: MapFilter = MAP_FILTERS.some((x) => x.id === raw) ? raw as MapFilter : 'all'
  const setFilter = (f: MapFilter) => { const n = new URLSearchParams(params); n.set('map', f); n.delete('dt'); setParams(n, { replace: true }) }
  const mapping = payload!.result.mapping!
  const master = payload!.result.master!
  const test = (l: MapLink, f: MapFilter) => f === 'all' ? true : f === 'review' ? l.state === 'review'
    : l.state === 'review' ? false : f === 'matched' ? l.comparison?.status === 'matched'
    : f === 'unmatched' ? l.state === 'unmatched' : diffType(l) === f
  const count = (f: MapFilter) => f === 'master_only' ? mapping.master_only.length : mapping.links.filter((l) => test(l, f)).length
  const current = MAP_FILTERS.find((x) => x.id === filter)!
  const listKeys = () => mapping.links.filter((l) => test(l, filter)).map((l) => model ? songForWork(model, l.internal_no)?.key : undefined).filter((k): k is string => !!k)
  return (
    <div className="stack">
      <div className="map-filters" role="tablist">
        {MAP_FILTERS.filter((f) => f.id !== 'review' || count('review') > 0).map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`${f.tone} ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>
            <b>{count(f.id)}</b><span>{f.label}</span>
          </button>
        ))}
      </div>
      <div className="filter-bar">
        <p className="filter-explain grow">{current.explain}</p>
        {(() => {
          const edits = payload!.master_edits
          const missing = mapping.links.filter((l) => l.state === 'linked' && l.master_row && test(l, filter)).flatMap((l) =>
            l.comparison!.fields.filter((f) => f.result === 'missing_master' && editable(f)
              && !edits.some((e) => e.master_row === l.master_row && e.field === f.field))
              .map((f) => ({ master_row: l.master_row!, field: f.field, internal_no: l.internal_no, choice: 'iprs' as const })))
          const toMaster = edits.filter((e) => e.choice === 'iprs').length
          return (
            <>
              {missing.length > 0 && <Button size="sm" icon={<Plus size={14} />} disabled={!!busy} onClick={() => editMaster(missing)}>Add all {missing.length} missing to master</Button>}
              <a className="btn primary sm" href={exportUrl('final')} title="Our master with the IPRS songs it was missing and every value you chose to add or keep from IPRS">
                <Download size={14} />Download updated master (LNV){toMaster > 0 && <span className="btn-count">{toMaster}</span>}</a>
            </>
          )
        })()}
      </div>
      <Card flush>
        {filter === 'master_only' ? (
          <DataTable rows={mapping.master_only} rowKey={(m) => String(m.row)} search={(m) => m.title}
            expand={(m) => (
              <div className="detail" onClick={(e) => e.stopPropagation()}>
                <div className="decide-head"><h4>{m.title}</h4><Button size="sm" variant="ghost"
                  onClick={() => openSong(`M${m.row}`, mapping.master_only.map((v) => `M${v.row}`), 'Only in master')}>Open song<ExternalLink size={13} /></Button></div>
                <PairPanel work={null} row={m.row} />
              </div>
            )}
            columns={[
              { key: 'title', header: 'Song in our master', render: (m) => <strong>{m.title}</strong>, sort: (m) => m.title },
              { key: 'row', header: 'Row', render: (m) => m.row, sort: (m) => m.row },
              { key: 'codes', header: 'IPRS code in master', render: (m) => m.iprs_codes.join(', ') || <span className="muted">none</span> },
            ]} />
        ) : (
          <DataTable<MapLink> rows={mapping.links.filter((l) => test(l, filter))} rowKey={(l) => l.internal_no}
            search={(l) => `${l.internal_no} ${l.title} ${l.master_title ?? ''}`}
            columns={[
              { key: 'title', header: 'IPRS work', sort: (l) => l.title, render: (l) => <div><strong>{l.title}</strong><span className="small muted block mono">{l.internal_no}</span></div> },
              { key: 'master', header: 'Our master', sort: (l) => l.master_title ?? '', render: (l) => {
                if (l.state === 'review' && l.candidates[0]) return <div>{l.candidates[0].title}<span className="small muted block">row {l.candidates[0].row} · suggested</span></div>
                if (!l.master_row) return <Badge tone="bad">not in master</Badge>
                const renamed = l.state === 'linked' && payload!.master_edits.some((e) => e.master_row === l.master_row && e.field === 'Title' && e.choice === 'iprs')
                return renamed ? <div>{l.title}<span className="small muted block">row {l.master_row} · was <s>{l.master_title}</s></span></div>
                  : <div>{l.master_title}<span className="small muted block">row {l.master_row}{l.also_rows?.length ? ` + also row${l.also_rows.length === 1 ? '' : 's'} ${l.also_rows.join(', ')}` : ''}</span></div>
              } },
              { key: 'type', header: 'Result', sort: (l) => diffType(l) ?? l.comparison?.status ?? l.state, render: (l) => {
                const d = DIFF_TYPES.find((x) => x.id === diffType(l))
                if (l.state === 'review') return <Badge tone="brand" icon={false}>Needs your decision</Badge>
                return d ? <Badge tone={d.tone} icon={false}>{d.label}</Badge> : l.comparison ? <Badge tone="good">Matched</Badge> : <Badge tone="bad">Added</Badge>
              } },
              { key: 'diff', header: 'What differs', render: (l) => {
                const fields = l.comparison?.fields.filter((f) => f.result === 'different' || f.result === 'missing_master') ?? []
                const open = fields.filter((f) => editable(f) && !payload!.master_edits.some((e) => e.master_row === l.master_row && e.field === f.field)).length
                const chosen = fields.filter(editable).length - open
                return <span className="small">{fields.map((f) => f.field).join(', ') || '—'}{l.state === 'linked' && chosen > 0 && <span className={`tag ${open ? 'pending' : ''}`}>{open ? `${chosen} of ${chosen + open} chosen` : 'all chosen'}</span>}</span>
              } },
              { key: 'method', header: 'Linked by', render: (l) => <span className="small muted">{l.method || '—'}</span> },
            ]}
            expand={(l) => {
              const song = model ? songForWork(model, l.internal_no) : null
              return (
                <div className="detail" onClick={(e) => e.stopPropagation()}>
                  {l.reason && <div className="alert info small">{l.reason}</div>}
                  <PairPanel work={l.internal_no} row={l.state === 'review' ? l.master_row ?? l.candidates[0]?.row ?? null : l.master_row}
                    rowNote={l.state === 'review' ? 'Compared with the suggested master song – not linked yet' : undefined}
                    link={l} />
                  <div className="decide">
                    <div className="decide-head"><h4>Change this link</h4>{song && <Button size="sm" variant="ghost" onClick={() => openSong(song.key, listKeys(), current.label)}>Open song<ExternalLink size={13} /></Button>}</div>
                    <Candidates link={l} />
                  </div>
                </div>
              )
            }} />
        )}
      </Card>
      {master.issues.length > 0 && (
        <details className="more-detail"><summary>See the {master.issues.length} problems found inside our master</summary>
          <DataTable rows={master.issues} rowKey={(i) => `${i.row}-${i.code}-${i.message}`} onRowClick={(i, vis) => openSong(`M${i.row}`, vis.map((v) => `M${v.row}`), 'Problems inside our master')} search={(i) => `${i.title} ${i.message}`} pageSize={10}
            columns={[
              { key: 'title', header: 'Song', render: (i) => <div>{i.title}<span className="small muted block">row {i.row}</span></div>, sort: (i) => i.title },
              { key: 'code', header: 'Problem', render: (i) => issueLabel(i.code) },
              { key: 'msg', header: 'Detail', render: (i) => <span className="small">{i.message}</span> },
            ]} />
        </details>
      )}
    </div>
  )
}

/* =================================================================== */
/* Data quality (steps 1 & 2)                                          */
/* =================================================================== */

const ISSUE_LABELS: Record<string, string> = {
  MISSING_ISWC: 'Missing ISWC', MISSING_ISRC: 'Missing ISRC', INVALID_ISWC: 'Invalid ISWC', INVALID_ISRC: 'Invalid ISRC',
  SHARE_TOTAL: 'Shares ≠ 100%', NO_SYNC_SHARE: 'No sync share', NO_MEC_SHARE: 'No mechanical share', NO_PER_SHARE: 'No performance share',
  NO_IPI: 'No IPI number', NON_MEMBER: 'Non-member (NS)', DUPLICATE_ISWC: 'Same ISWC on 2+ works', DUPLICATE_TITLE: 'Same title on 2+ works',
  NAME_WRAPPED: 'Name split over rows', MULTIPLE_SETS: 'Several share sets', CLIENT_NOT_ON_WORK: 'Client not on work',
  FOOTER_MISMATCH: 'Work count mismatch', MISSING_TITLE: 'Missing title', NO_CONTRIBUTORS: 'No contributors',
  NO_CREDITS: 'No credits in master', MASTER_ROLE_COLUMN: 'Role code in the wrong column', DUPLICATE_CODE: 'Tune code used twice', ID_IN_WRONG_COLUMN: 'ID in wrong column',
}
const issueLabel = (c: string) => ISSUE_LABELS[c] ?? c
const roleName = (c: string) => ({ A: 'Author', C: 'Composer', CA: 'Composer/Author', E: 'Publisher' } as Record<string, string>)[c] ?? c
const pct = (v: number | null) => (v === null ? '—' : `${v}%`)

type QView = 'iprs' | 'cleanup'

function Explain({ children }: { children: ReactNode }) {
  return <div className="explain"><Info size={16} /><div>{children}</div></div>
}

/** Step 1 – the IPRS three-line report: format check, what was cleaned, data issues. */
export function ImportTab() {
  const { payload, model, openSong } = useRun()
  const [view, setView] = useState<QView>('iprs')
  const iprs = payload!.result.iprs!
  const sev = (s: string) => ({ error: 0, warning: 1, info: 2 } as Record<string, number>)[s]
  const openWork = (no?: string) => { const s = no && model ? songForWork(model, no) : null; if (s) openSong(s.key) }
  const counts = (() => {
    const m = new Map<string, { code: string; severity: string; n: number }>()
    for (const i of iprs.issues) m.set(i.code, { code: i.code, severity: i.severity, n: (m.get(i.code)?.n ?? 0) + 1 })
    return [...m.values()].sort((a, b) => sev(a.severity) - sev(b.severity) || b.n - a.n)
  })()
  return (
    <div className="stack">
      <Explain>The client's IPRS report is checked against the fixed IPRS column format, then <b>formatting</b> is cleaned
        (spaces, number formats, names split over two rows). <b>Data</b> is never changed – problems are only flagged below.</Explain>
      <div className="grid-2">
        <Card title="Format check"><CheckList checks={iprs.checks} /></Card>
        <Card title="Cleaned automatically">
          <ul className="plain clean-list">
            {Object.entries(iprs.cleanup.reduce<Record<string, number>>((m, c) => ({ ...m, [c.action]: (m[c.action] ?? 0) + 1 }), {})).map(([a, n]) => (
              <li key={a}><Check size={14} />{a}<b>{n}</b></li>
            ))}
          </ul>
        </Card>
      </div>
      <Card flush>
        <div className="card-pad"><Tabs value={view} onChange={setView} tabs={[
          { id: 'iprs', label: 'Data issues in the IPRS report', count: iprs.issues.length },
          { id: 'cleanup', label: 'Clean-up log', count: iprs.cleanup.length },
        ]} /></div>
        {view === 'iprs' ? (
          <>
            <div className="chips card-pad">{counts.map((c) => <span key={c.code} className={`chip ${c.severity}`}>{issueLabel(c.code)} <b>{c.n}</b></span>)}</div>
            <DataTable rows={iprs.issues} rowKey={(i) => `${i.internal_no}-${i.code}-${i.message}`} onRowClick={(i) => openWork(i.internal_no)}
              search={(i) => `${i.internal_no} ${i.title} ${i.message}`} initialSort={{ key: 'sev' }}
              filters={[{ label: 'Issue', options: counts.map((c) => ({ id: c.code, label: issueLabel(c.code) })), test: (i, v) => i.code === v }]}
              columns={[
                { key: 'sev', header: 'Severity', render: (i) => <StatusBadge value={i.severity} />, sort: (i) => sev(i.severity), width: '120px' },
                { key: 'title', header: 'Work', render: (i) => <div>{i.title || '—'}<span className="small muted block mono">{i.internal_no}</span></div>, sort: (i) => i.title },
                { key: 'code', header: 'Issue', render: (i) => issueLabel(i.code), sort: (i) => i.code },
                { key: 'msg', header: 'Detail', render: (i) => <span className="small">{i.message}</span> },
              ]} />
          </>
        ) : (
          <DataTable rows={iprs.cleanup} rowKey={(c) => `${c.row}-${c.column}-${c.action}`} search={(c) => `${c.original} ${c.cleaned} ${c.column}`}
            columns={[
              { key: 'row', header: 'Excel row', render: (c) => c.row, sort: (c) => c.row, width: '100px' },
              { key: 'col', header: 'Column', render: (c) => c.column, sort: (c) => c.column },
              { key: 'orig', header: 'Original', render: (c) => <code className="ws">{c.original}</code> },
              { key: 'clean', header: 'Cleaned', render: (c) => <code>{c.cleaned}</code> },
              { key: 'action', header: 'Action', render: (c) => <span className="small">{c.action}</span> },
            ]} />
        )}
      </Card>
    </div>
  )
}

/** Step 2 – one row per work. */
export function OneLineTab() {
  const { payload, exportUrl } = useRun()
  const iprs = payload!.result.iprs!
  return (
    <div className="stack">
      <Explain>IPRS lists each work over several rows (one per author, composer and publisher). Here every work is <b>one row</b>:
        {' '}{iprs.stats.contributor_rows} rows became {iprs.stats.works} works, grouped by IPRS Internal No. Click a work to see its original rows.</Explain>
      <Card flush title="One-line IPRS base" actions={<a className="btn default" href={exportUrl('step2')}>Download one-line (.xlsx)</a>}>
        <OneLineTable works={iprs.works} />
      </Card>
    </div>
  )
}

/** Step 4 – songs added to the final report and gaps filled in master rows. */
export function GapsTab() {
  const { payload, model, openSong, exportUrl } = useRun()
  const final = payload!.result.final!
  const added = model!.songs.filter((x) => x.origin === 'iprs')
  const filled = model!.songs.filter((x) => x.origin === 'master' && x.final.fills.length)
  return (
    <div className="stack">
      <Explain>Every IPRS work that is <b>not in our master</b> is added to the final report so no work is missed
        ({final.summary.master_songs} in master + {final.summary.added} added = <b>{final.summary.final_total}</b>).
        Identifiers IPRS has but our master row is missing are filled in too.</Explain>
      <Card flush title={`Added to the final report (${added.length})`} actions={<a className="btn primary" href={exportUrl('final')}>Download final report</a>}>
        <DataTable<Song> rows={added} rowKey={(r) => r.key} onRowClick={(r, vis) => openSong(r.key, vis.map((v) => v.key), 'Added from IPRS')} search={(r) => r.title}
          empty="Nothing missing – every IPRS work is already in our master."
          columns={[
            { key: 'title', header: 'Song', render: (r) => <strong>{r.title}</strong>, sort: (r) => r.title },
            { key: 'no', header: 'IPRS tune code', render: (r) => <Mono>{r.final.iprs_works[0]}</Mono> },
            { key: 'iswc', header: 'ISWC', render: (r) => <Mono>{r.final.iswc || '—'}</Mono> },
            { key: 'writers', header: 'Writers', render: (r) => <span className="small">{r.iprs[0]?.contributors.filter((c) => c.role !== 'E').map((c) => c.name).join('; ')}</span> },
          ]} />
      </Card>
      <Card flush title={`Filled in on existing master rows (${filled.length})`}>
        <DataTable<Song> rows={filled} rowKey={(r) => r.key} onRowClick={(r, vis) => openSong(r.key, vis.map((v) => v.key), 'Gaps filled in our master')} empty="No master rows needed filling."
          columns={[
            { key: 'title', header: 'Song', render: (r) => <div><strong>{r.title}</strong><span className="small muted block">master row {r.master?.row}</span></div>, sort: (r) => r.title },
            { key: 'fills', header: 'Filled in', render: (r) => <ul className="plain">{r.final.fills.map((f) => <li key={f.field + f.value} className="small"><b>{f.field}</b> <Mono>{f.value}</Mono> <span className="muted">– {f.reason}</span></li>)}</ul> },
          ]} />
      </Card>
    </div>
  )
}

function People({ list }: { list: Contributor[] }) {
  if (!list.length) return <span className="muted">—</span>
  return <span className="people">{list.slice(0, 2).map((c) => <span key={c.source_row + c.role}>{c.name} <span className="muted">{pct(c.per_own)}</span></span>)}
    {list.length > 2 && <span className="more">+{list.length - 2} more</span>}</span>
}

function OneLineTable({ works }: { works: IprsWork[] }) {
  return (
    <DataTable<IprsWork> rows={works} rowKey={(w) => w.internal_no}
      search={(w) => `${w.internal_no} ${w.title} ${w.iswc} ${w.isrc} ${w.contributors.map((c) => c.name).join(' ')}`}
      columns={[
        { key: 'title', header: 'Work', sort: (w) => w.title, render: (w) => <div><strong>{w.title}</strong><span className="small muted block mono">{w.internal_no}</span></div> },
        { key: 'ids', header: 'ISWC / ISRC', render: (w) => <div className="small mono">{w.iswc || <span className="t-bad">no ISWC</span>}<br />{w.isrc || <span className="t-bad">no ISRC</span>}</div> },
        { key: 'a', header: 'Authors', render: (w) => <People list={w.authors} /> },
        { key: 'c', header: 'Composers', render: (w) => <People list={w.composers} />, sort: (w) => w.composers.length },
        { key: 'p', header: 'Publishers', render: (w) => <People list={w.publishers} /> },
      ]}
      expand={(w) => (
        <table className="kv-table">
          <thead><tr><th>Excel row</th><th>Role</th><th>Name</th><th>IPI</th><th>Society</th><th>PER</th><th>MEC</th><th>SYNC</th></tr></thead>
          <tbody>{w.contributors.map((c) => (
            <tr key={c.source_row}><td>{c.source_row}</td><td>{roleName(c.role)}</td><td>{c.name}</td><td><Mono>{c.ipi || '—'}</Mono></td>
              <td>{c.society}</td><td>{pct(c.per_own)}</td><td>{pct(c.mec_own)}</td><td>{pct(c.sync_own)}</td></tr>
          ))}</tbody>
        </table>
      )} />
  )
}

function CheckList({ checks }: { checks: CheckT[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.label} className={c.passed ? 'ok' : 'fail'}>
          {c.passed ? <CheckCircle2 size={16} /> : <X size={16} />}
          <div><strong>{c.label}</strong><span className="small muted">{c.detail}</span></div>
        </li>
      ))}
    </ul>
  )
}
