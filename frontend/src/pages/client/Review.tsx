import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronRight, ExternalLink, Plus, Search, Undo2, X } from 'lucide-react'
import { Button, ConfirmDialog } from '../../components/ui'
import { api } from '../../lib/api'
import { useToast } from '../../lib/toast'
import type { CleanDecisionIn } from '../../lib/api'
import type { CompareCandidate, CompareItem, ComparePayload } from '../../types'

/** Step 2: every recording of the DSP sheet in one of three buckets. Exact and Not found need nobody; only Possible
 *  asks a question, with both sides shown field by field. */

type Bucket = 'possible' | 'exact' | 'new'
const PAGE = 40
const fmt = (x: number) => x.toLocaleString('en-IN')

const BUCKETS: { id: Bucket; label: string; note: (c: ComparePayload['counts']) => string }[] = [
  { id: 'possible', label: 'Possible match', note: (c) => c.open ? `${fmt(c.open)} need your review` : 'All reviewed' },
  { id: 'exact', label: 'Exact match', note: () => 'Linked automatically' },
  { id: 'new', label: 'Not found', note: (c) => `${fmt(c.added)} added as new rows` },
]

const matches = (i: CompareItem, q: string) => {
  if (!q) return true
  const m = i.muso, l = i.candidates[0]?.lnv
  return `${m.title} ${m.album} ${m.isrcs.join(' ')} ${l?.title ?? ''} ${l?.album ?? ''} ${i.original?.title ?? ''}`.toLowerCase().includes(q)
}

export default function Review({ clientId, source, onChanged, onNext }: { clientId: number; source: string; onChanged: () => void; onNext: () => void }) {
  const toast = useToast()
  const [data, setData] = useState<ComparePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bucket, setBucket] = useState<Bucket | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try { setData((await api.compare(clientId)).compare); setError(null) } catch (e) { setError((e as Error).message) }
  }, [clientId])
  useEffect(() => { load() }, [load])

  const answer = async (items: CleanDecisionIn[]) => {
    const keys = items.map((x) => x.key.slice(4))
    setBusy((b) => new Set([...b, ...keys]))
    try {
      await api.mergeSave(clientId, items)
      await load()
      onChanged()
    } catch (e) { toast(`Not saved: ${(e as Error).message}`, 'bad') } finally {
      setBusy((b) => { const n = new Set(b); keys.forEach((k) => n.delete(k)); return n })
    }
  }

  if (error && !data) return <div className="alert bad">{error}</div>
  if (!data) return <div className="loading"><span className="spinner" />Comparing the two files…</div>
  const c = data.counts
  const shown = bucket ?? (c.open ? 'possible' : 'exact')
  const q = query.trim().toLowerCase()
  const act = { answer, busy }

  return (
    <div className="rc">
      <div className="rc-tiles" role="tablist" aria-label="Results">
        {BUCKETS.map((b) => (
          <button key={b.id} type="button" role="tab" aria-selected={shown === b.id} className={`rc-tile ${b.id} ${shown === b.id ? 'on' : ''}`} onClick={() => setBucket(b.id)}>
            <span className="rc-tile-label">{b.label}</span>
            <b>{fmt(c[b.id])}</b>
            <small>{b.note(c)}</small>
          </button>
        ))}
      </div>
      <p className="rc-scope muted">{fmt(c.recordings)} {source} recordings in {fmt(c.families)} songs, compared with {fmt(c.lnv_rows)} LNV rows on title, album, ISRC and credits.
        The oldest release of each song is its original.</p>

      <label className="rc-search"><Search size={15} />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, album, ISRC…" aria-label="Search" /></label>

      {shown === 'possible' && <PossibleList data={data} q={q} source={source} {...act} />}
      {shown === 'exact' && <ExactList data={data} q={q} source={source} {...act} />}
      {shown === 'new' && <NewList data={data} q={q} {...act} />}

      <div className="rc-next">
        <span className="muted">{c.open ? `${fmt(c.open)} possible matches left. They stay out of the output until you answer them.` : 'Nothing left to review.'}</span>
        <Button variant="primary" onClick={onNext}>Continue<ArrowRight size={15} /></Button>
      </div>
    </div>
  )
}

interface Acts { answer: (items: CleanDecisionIn[]) => Promise<void>; busy: Set<string> }

function More({ total, shown, onMore }: { total: number; shown: number; onMore: () => void }) {
  if (shown >= total) return null
  return <div className="rc-more"><Button onClick={onMore}>Show more ({fmt(total - shown)} left)</Button></div>
}

/* ---------- possible ---------- */

function PossibleList({ data, q, source, answer, busy }: { data: ComparePayload; q: string; source: string } & Acts) {
  const [reason, setReason] = useState<string | null>(null)
  const [view, setView] = useState<'open' | 'done'>('open')
  const [count, setCount] = useState(PAGE)
  const [ask, setAsk] = useState(false)
  const all = useMemo(() => data.items.filter((i) => i.status === 'possible'), [data])
  const open = all.filter((i) => i.final === 'pending')
  const pool = view === 'open' ? open : all.filter((i) => i.final !== 'pending')
  const groups = useMemo(() => {
    const m = new Map<string, number>()
    open.forEach((i) => i.reason && m.set(i.reason, (m.get(i.reason) ?? 0) + 1))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [open])
  const list = pool.filter((i) => (!reason || view === 'done' || i.reason === reason) && matches(i, q))
  const group = reason ? open.filter((i) => i.reason === reason) : []

  return (
    <section className="rc-section">
      <div className="rc-tabs">
        <button type="button" className={view === 'open' ? 'on' : ''} onClick={() => setView('open')}>To review <span>{fmt(open.length)}</span></button>
        <button type="button" className={view === 'done' ? 'on' : ''} onClick={() => setView('done')}>Reviewed <span>{fmt(all.length - open.length)}</span></button>
      </div>
      {view === 'open' && groups.length > 0 && (
        <div className="rc-groups" role="group" aria-label="Filter by what differs">
          <button type="button" className={!reason ? 'on' : ''} onClick={() => setReason(null)}>All <span>{fmt(open.length)}</span></button>
          {groups.map(([k, v]) => (
            <button key={k} type="button" className={reason === k ? 'on' : ''} onClick={() => setReason(k)}>{data.reasons[k] ?? k} <span>{fmt(v)}</span></button>
          ))}
        </div>
      )}
      {view === 'open' && group.length > 0 && (
        <div className="rc-bulk"><span>Every recording in this group matches the same way.</span>
          <Button onClick={() => setAsk(true)}><Check size={15} />Mark all {fmt(group.length)} as same song</Button></div>
      )}
      {!list.length && <div className="rc-none">{view === 'open' ? (q ? 'Nothing matches the search.' : 'No possible matches left to review.') : 'Nothing reviewed yet.'}</div>}
      {list.slice(0, count).map((i) => <PossibleCard key={i.key} item={i} source={source} answer={answer} busy={busy} reasons={data.reasons} />)}
      <More total={list.length} shown={count} onMore={() => setCount(count + PAGE)} />
      <ConfirmDialog open={ask} tone="primary" title={`Mark ${fmt(group.length)} as same song?`} confirmLabel="Mark all as same song" onCancel={() => setAsk(false)}
        onConfirm={async () => {
          setAsk(false)
          await answer(group.map((i) => ({ key: `rec:${i.key}`, choice: 'same', data: { row: i.candidates[0].row } })))
          setReason(null)
        }}>
        <p>{data.reasons[reason ?? '']}.</p>
        <p>Each recording is linked to its closest LNV row and that row's blanks are filled from {source}, in yellow. You can undo any of them under Reviewed.</p>
      </ConfirmDialog>
    </section>
  )
}

function PossibleCard({ item, source, answer, busy, reasons }: { item: CompareItem; source: string; reasons: Record<string, string> } & Acts) {
  const [pick, setPick] = useState(() => Math.max(0, item.candidates.findIndex((x) => x.row === item.row)))
  const c = item.candidates[pick] ?? item.candidates[0]
  const saving = busy.has(item.key)
  const key = `rec:${item.key}`
  return (
    <article className={`rc-card ${item.final !== 'pending' ? 'done' : ''}`}>
      <header>
        <div className="grow"><h3>{item.muso.title}</h3>
          <p className="muted">{reasons[c?.reason ?? item.reason ?? ''] ?? ''}</p></div>
        {item.original && <OriginalChip o={item.original} />}
      </header>
      {item.candidates.length > 1 && (
        <div className="rc-pick" role="tablist" aria-label="LNV row">
          {item.candidates.map((x, n) => <button key={x.row} type="button" role="tab" aria-selected={pick === n} className={pick === n ? 'on' : ''} onClick={() => setPick(n)}>LNV row {x.row}</button>)}
        </div>
      )}
      {c && <CompareTable item={item} c={c} source={source} />}
      <footer>
        {item.final === 'pending' ? <>
          <Button variant="primary" disabled={saving} onClick={() => answer([{ key, choice: 'same', data: { row: c.row } }])}><Check size={15} />Same song</Button>
          <Button disabled={saving} onClick={() => answer([{ key, choice: 'new' }])}><Plus size={15} />Different song, add as new row</Button>
          <Button variant="ghost" disabled={saving} onClick={() => answer([{ key, choice: 'skip' }])}><X size={15} />Leave out</Button>
          {saving && <span className="spinner small-dark" />}
        </> : <>
          <span className={`rc-state ${item.final}`}>{item.final === 'linked' ? <><Check size={14} />Linked to LNV row {item.row}</> : item.final === 'add' ? <><Plus size={14} />Added as a new row</> : <><X size={14} />Left out</>}</span>
          <Button variant="ghost" disabled={saving} onClick={() => answer([{ key, choice: null }])}><Undo2 size={15} />Undo</Button>
        </>}
      </footer>
    </article>
  )
}

const OriginalChip = ({ o }: { o: NonNullable<CompareItem['original']> }) => (
  <span className="rc-orig" title="Written in the Original Work and Original Movie / Album columns">Version of <b>{o.title}</b>{o.album && <> · {o.album}</>}</span>
)

/* ---------- the side-by-side table ---------- */

const GOOD = new Set(['same'])
const WORD: Record<string, string> = { same: 'Same', similar: 'Similar', differ: 'Different', close: 'A little different', blank: 'Blank in one file', none: 'None on the sheet' }
const CHECK_TEXT = (field: 'isrc' | 'other', v: string) => field === 'isrc' && v === 'blank' ? 'LNV has none' : WORD[v] ?? v
const tone = (v: string) => GOOD.has(v) ? 'good' : v === 'blank' || v === 'none' ? 'blank' : 'bad'

function Names({ names, odd }: { names: string[]; odd: string[] }) {
  if (!names.length) return <span className="muted">Blank</span>
  return <>{names.map((x, i) => <span key={x + i} className={odd.includes(x) ? 'rc-odd' : undefined}>{x}{i < names.length - 1 ? ', ' : ''}</span>)}</>
}

function CompareTable({ item, c, source }: { item: CompareItem; c: CompareCandidate; source: string }) {
  const m = item.muso, l = c.lnv
  const rows: [string, React.ReactNode, React.ReactNode, string, 'isrc' | 'other'][] = [
    ['Title', m.title, l.title, c.title, 'other'],
    ['Album', m.album || <span className="muted">Blank</span>, l.album || <span className="muted">Blank</span>, c.album, 'other'],
    ['ISRC', m.isrcs.join(', ') || <span className="muted">Blank</span>, l.isrcs.join(', ') || <span className="muted">Blank</span>, c.isrc, 'isrc'],
    ['Composer', <Names names={m.composers} odd={c.only_muso} />, <Names names={l.composers} odd={c.only_lnv} />, c.credits, 'other'],
    ['Lyricist', <Names names={m.lyricists} odd={c.only_muso} />, <Names names={l.lyricists} odd={c.only_lnv} />, c.credits, 'other'],
  ]
  return (
    <div className="rc-table-wrap">
      <table className="rc-compare">
        <thead><tr><th scope="col" /><th scope="col">{source}{m.date && <small> · released {m.date}</small>}{m.link && <a href={m.link} target="_blank" rel="noreferrer" aria-label="Open the song"><ExternalLink size={12} /></a>}</th>
          <th scope="col">LNV row {l.row}{l.year && <small> · {l.year}</small>}</th><th scope="col" /></tr></thead>
        <tbody>
          {rows.map(([name, a, b, check, kind]) => (
            <tr key={name} className={tone(check)}>
              <th scope="row">{name}</th><td>{a}</td><td>{b}</td>
              <td className="rc-check"><span className={`rc-mark ${tone(check)}`}>{CHECK_TEXT(kind, check)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- exact ---------- */

function ExactList({ data, q, source, answer, busy }: { data: ComparePayload; q: string; source: string } & Acts) {
  const [count, setCount] = useState(PAGE)
  const [open, setOpen] = useState<string | null>(null)
  const list = data.items.filter((i) => i.status === 'exact' && matches(i, q))
  return (
    <section className="rc-section">
      <p className="rc-help">Title, album, ISRC and credits all agree. Blanks in these LNV rows are filled from {source} in yellow. Nothing to do here.</p>
      <div className="rc-table-wrap"><table className="rc-rows">
        <thead><tr><th scope="col" /><th scope="col">{source} song</th><th scope="col">ISRC</th><th scope="col">LNV row</th><th scope="col">Original</th></tr></thead>
        <tbody>
          {list.slice(0, count).map((i) => {
            const c = i.candidates.find((x) => x.row === i.row) ?? i.candidates[0]
            const isOpen = open === i.key
            return <ExactRow key={i.key} i={i} c={c} isOpen={isOpen} toggle={() => setOpen(isOpen ? null : i.key)} source={source} answer={answer} busy={busy} />
          })}
          {!list.length && <tr><td colSpan={5} className="rc-none">{q ? 'Nothing matches the search.' : 'No exact matches.'}</td></tr>}
        </tbody>
      </table></div>
      <More total={list.length} shown={count} onMore={() => setCount(count + PAGE)} />
    </section>
  )
}

function ExactRow({ i, c, isOpen, toggle, source, answer, busy }: { i: CompareItem; c: CompareCandidate; isOpen: boolean; toggle: () => void; source: string } & Acts) {
  const key = `rec:${i.key}`
  const off = i.final !== 'linked'
  return <>
    <tr className={`rc-row ${off ? 'off' : ''}`} onClick={toggle}>
      <td className="rc-twist">{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
      <td><b>{i.muso.title}</b><small>{i.muso.album}</small></td>
      <td className="mono">{i.muso.isrcs[0]}{i.muso.isrcs.length > 1 && <small>+{i.muso.isrcs.length - 1}</small>}</td>
      <td>{off ? <span className="rc-state add"><Plus size={13} />New row instead</span> : <><b>{c.row}</b> <span className="muted">{c.lnv.title}</span></>}{i.also.length > 0 && <small>also row {i.also.join(', ')}</small>}</td>
      <td>{i.original ? <>{i.original.title}<small>{i.original.album}</small></> : <span className="muted">{i.muso.variant ? '–' : 'Is the original'}</span>}</td>
    </tr>
    {isOpen && <tr className="rc-open"><td /><td colSpan={4}>
      <CompareTable item={i} c={c} source={source} />
      <div className="rc-open-actions">
        {off ? <Button variant="ghost" onClick={() => answer([{ key, choice: null }])}><Undo2 size={15} />Undo</Button>
          : <Button variant="ghost" disabled={busy.has(i.key)} onClick={() => answer([{ key, choice: 'new' }])}>Not the same song? Add as a new row</Button>}
      </div>
    </td></tr>}
  </>
}

/* ---------- not found ---------- */

function NewList({ data, q, answer, busy }: { data: ComparePayload; q: string } & Acts) {
  const [view, setView] = useState<'add' | 'out'>('add')
  const [count, setCount] = useState(PAGE)
  const all = data.items.filter((i) => i.status === 'new')
  const adding = all.filter((i) => i.final === 'add')
  const out = all.filter((i) => i.final !== 'add')
  const list = (view === 'add' ? adding : out).filter((i) => matches(i, q))
  return (
    <section className="rc-section">
      <div className="rc-tabs">
        <button type="button" className={view === 'add' ? 'on' : ''} onClick={() => setView('add')}>Adding as new rows <span>{fmt(adding.length)}</span></button>
        <button type="button" className={view === 'out' ? 'on' : ''} onClick={() => setView('out')}>Left out <span>{fmt(out.length)}</span></button>
      </div>
      <p className="rc-help">{view === 'add' ? 'Nothing in the LNV lines up with these. Each becomes a new yellow row; versions name their original.'
        : 'Your LNV file already lists these on another sheet, or you left them out. Add one back if that was a mistake.'}</p>
      <div className="rc-table-wrap"><table className="rc-rows">
        <thead><tr><th scope="col">Song</th><th scope="col">ISRC</th><th scope="col">Released</th><th scope="col">Original</th><th scope="col" /></tr></thead>
        <tbody>
          {list.slice(0, count).map((i) => (
            <tr key={i.key} className="rc-row flat">
              <td><b>{i.muso.title}</b><small>{i.muso.album}</small>
                {i.hold && <span className="rc-flag">On the “{i.hold}” sheet</span>}
                {!i.credited && <span className="rc-flag">Client not credited as a writer</span>}</td>
              <td className="mono">{i.muso.isrcs[0] ?? '–'}</td>
              <td>{i.muso.date || '–'}</td>
              <td>{i.original ? <>{i.original.title}<small>{i.original.album}</small></> : <span className="muted">–</span>}</td>
              <td className="rc-cell-action">
                {view === 'add'
                  ? <Button variant="ghost" size="sm" disabled={busy.has(i.key)} onClick={() => answer([{ key: `rec:${i.key}`, choice: 'skip' }])}>Leave out</Button>
                  : <Button size="sm" disabled={busy.has(i.key)} onClick={() => answer([{ key: `rec:${i.key}`, choice: 'add' }])}><Plus size={14} />Add</Button>}
              </td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan={5} className="rc-none">{q ? 'Nothing matches the search.' : 'Nothing here.'}</td></tr>}
        </tbody>
      </table></div>
      <More total={list.length} shown={count} onMore={() => setCount(count + PAGE)} />
    </section>
  )
}
