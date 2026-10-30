import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, ExternalLink, Maximize2, Minimize2, Search, Undo2, X } from 'lucide-react'
import type { CleanDecisionIn } from '../../lib/api'
import type { CaseKind, CaseRecord, ReviewCase, Step1 } from '../../types'
import { cellOf, inList, list, n, norm } from './Block'

/** Step 1 – the LNV is the master; the DSP export (Muso) only brings changes to it. One case per song: the DSP song
 *  next to its LNV row, the names that differ marked, and – always on screen – one button per answer: same song ·
 *  add to the LNV · not the client's. The app's answer is the green button; Enter accepts it. Step 4 has the downloads. */

const KIND: Record<CaseKind, { label: string; short: string; tone: string }> = {
  names: { label: 'Same person?', short: 'Name', tone: 'warn' },
  check: { label: 'Which LNV row?', short: 'Which row?', tone: 'info' },
  versions: { label: 'Several versions', short: 'Versions', tone: 'brand' },
  isrc: { label: 'Data conflict', short: 'Conflict', tone: 'warn' },
  missing: { label: 'New – not in the LNV', short: 'New', tone: 'violet' },
  twice: { label: 'LNV duplicates', short: 'LNV twice', tone: 'bad' },
  left_out: { label: "Not the client's", short: 'Skip', tone: 'soft' },
}
const KINDS = Object.keys(KIND) as CaseKind[]
const SHOW = ['Title', 'Film / album', 'Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC', 'Year']
const RULE = {
  writers: { same: ['good', 'Same writers'], differ: ['bad', 'Different writers'], blank: ['warn', 'Writers missing – cannot check'] },
  publisher: { same: ['good', 'Same publisher'], differ: ['bad', 'Different publisher'], unchecked: ['warn', 'Publisher not checked'] },
} as const
const DECIDES = new Set(['Title', 'Lyricist', 'Composer'])
const WRITERS = new Set(['Lyricist', 'Composer'])

type Choice = 'same' | 'add' | 'not_ours' | 'different' | null
type Draft = { in: number[]; rows: number[]; choice: Choice; reject: string[] }

function draftOf(c: ReviewCase): Draft {
  const a = c.answer
  const reject = c.updates.filter((u) => !u.accept).map((u) => u.key)
  if (c.kind === 'names') return { in: [], rows: [], choice: (a.choice as Choice) ?? null, reject }
  if (c.kind === 'twice') {   // only an answer the app is sure of (or the reviewer's) is chosen
    if (!a.choice) return { in: [], rows: [], choice: null, reject }
    return a.choice === 'different' || a.choice === 'neither' ? { in: [], rows: [], choice: 'different', reject }
      : { in: [], rows: a.keep ? [a.keep] : [], choice: 'same', reject }
  }
  return { in: c.muso.filter((r) => r.in).map((r) => r.id!), rows: a.choice === 'same' ? a.rows ?? [] : [], choice: (a.choice as Choice) ?? null, reject }
}

/** The decisions one confirm saves (choice null on undo). */
function itemsOf(c: ReviewCase, d: Draft | null): CleanDecisionIn[] {
  if (c.kind === 'names') return [d ? { key: c.answer.key!, choice: d.choice as 'same' | 'different', data: { ...c.names! } } : { key: c.answer.key!, choice: null }]
  if (c.kind === 'twice') {
    if (!d) return [{ key: c.answer.key!, choice: null }]
    if (d.choice === 'different') return [{ key: c.answer.key!, choice: c.isrc ? 'neither' : 'different' }]
    return [{ key: c.answer.key!, choice: c.isrc ? 'owner' : 'duplicate', data: c.isrc ? { row: d.rows[0] } : { keep: d.rows[0] } }]
  }
  const out: CleanDecisionIn[] = []
  if (c.merge) {
    const all = c.muso.map((r) => r.id!)
    if (!d) out.push({ key: c.merge.key, choice: null })
    else if (d.in.length <= 1) out.push({ key: c.merge.key, choice: 'rejected' })
    else out.push({ key: c.merge.key, choice: 'accepted', data: { excluded: all.filter((id) => !d.in.includes(id)) } })
  }
  const song = c.answer.song!
  if (!d) out.push({ key: `link:${song}`, choice: null }, { key: `missing:${song}`, choice: null })
  else if (d.choice === 'same') {
    out.push({ key: `link:${song}`, choice: 'same', data: { rows: d.rows } }, { key: `missing:${song}`, choice: null })
    c.updates.filter((u) => d.rows.includes(u.row)).forEach((u) => out.push({ key: u.key, choice: d.reject.includes(u.key) ? 'reject' : 'accept' }))
  } else if (d.choice === 'add' || d.choice === 'not_ours') out.push({ key: `link:${song}`, choice: 'none' }, { key: `missing:${song}`, choice: d.choice })
  return out
}

const ready = (c: ReviewCase, d: Draft) => d.choice !== null && (c.kind === 'names' || d.choice !== 'same' || d.rows.length > 0)

/** How a song stands against the LNV. Exact: an LNV row with the same title and writers and a publisher name that
 *  really appears on both sides. Possible: it has LNV rows, but not such a row. New: no LNV row at all. */
type Match = 'exact' | 'possible' | 'new' | 'other'
const MATCHES = [['exact', 'Exact match'], ['possible', 'Possible match'], ['new', 'Not in the LNV']] as const
function matchOf(c: ReviewCase): Match {
  if (c.kind === 'names' || c.kind === 'twice') return 'other'
  if (!c.lnv.length) return 'new'
  const pubs = c.muso.flatMap((r) => list(r.fields.Publisher))
  const titles = list(c.muso[0]?.fields.Title)
  return c.lnv.some((r) => r.check?.writers === 'same' && r.check.publisher === 'same' && cellOf('Title', titles, list(r.fields.Title)) === 'same'
    && list(r.fields.Publisher).some((x) => inList('Publisher', pubs, x))) ? 'exact' : 'possible'
}

/** What a case does to the LNV, in two words – for the list. */
function verdict(c: ReviewCase, d: Draft) {
  if (c.kind === 'names') return d.choice === 'same' ? 'Same person' : d.choice === 'different' ? 'Two people' : 'Needs you'
  if (c.kind === 'twice') return d.choice === 'different' ? 'Different songs' : d.rows.length ? `Keep row ${d.rows[0]}` : 'Needs you'
  if (d.choice === 'same') return `Row ${d.rows.join(', ')}`
  return d.choice === 'add' ? 'Add to LNV' : d.choice === 'not_ours' ? 'Skip' : 'Needs you'
}

export default function SongReview({ d, save }: {
  d: Step1; save: (items: CleanDecisionIn[]) => Promise<boolean>
}) {
  const [q, setQ] = useState('')
  // needs: the app has no answer – a real doubt · sure: the app answered, confirm it · done: checked
  const [status, setStatus] = useState<'needs' | 'sure' | 'done' | 'all'>('needs')
  const [kind, setKind] = useState<CaseKind | 'all' | 'lnv_only'>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // a new filter starts at its first case
  const filterBy = (st: typeof status, k: typeof kind) => { setStatus(st); setKind(k); setSelectedId(null) }
  const [match, setMatch] = useState<Match | 'all'>('all')
  const matches = useMemo(() => new Map(d.cases.map((c) => [c.id, matchOf(c)])), [d])
  const inMatch = (c: ReviewCase) => match === 'all' ? !c.auto : matches.get(c.id) === match
  const matchCount = useMemo(() => {
    const t: Record<string, number> = {}
    matches.forEach((m) => { t[m] = (t[m] ?? 0) + 1 })
    return t
  }, [matches])
  // a match tab shows every song of its kind; "All songs" goes back to what needs you
  const matchBy = (m: typeof match) => { setMatch(m); setStatus(m === 'all' ? 'needs' : 'all'); setKind('all'); setSelectedId(null) }
  const [done, setDone] = useState<Record<string, boolean>>({})   // answered here, before the next load shows it
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  useEffect(() => { setDone({}) }, [d])
  const isDone = (c: ReviewCase) => done[c.id] ?? c.done
  const stateOf = (c: ReviewCase) => isDone(c) ? 'done' : ready(c, draftOf(c)) ? 'sure' : 'needs'
  const inStatus = (c: ReviewCase) => status === 'all' || stateOf(c) === status

  const counts = useMemo(() => {
    const k: Record<string, number> = {}
    d.cases.forEach((c) => { if (inStatus(c) && inMatch(c)) k[c.kind] = (k[c.kind] ?? 0) + 1 })
    return k
  }, [d, status, done, match])   // eslint-disable-line react-hooks/exhaustive-deps
  const tally = useMemo(() => {
    const t = { needs: 0, sure: 0, done: 0 }
    d.cases.forEach((c) => { if (inMatch(c)) t[stateOf(c)] += 1 })
    return t
  }, [d, done, match])   // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const s = norm(q)
    return d.cases.filter((c) => {
      if (c.id !== selectedId) {
        if (!inStatus(c) || !inMatch(c)) return false
        if (kind !== 'all' && c.kind !== kind) return false
      }
      return !s || norm(c.title).includes(s) || [...c.muso, ...c.lnv].some((r) => norm(`${r.ref} ${Object.values(r.fields).flat().join(' ')}`).includes(s))
    })
  }, [d, q, status, kind, selectedId, done, match])   // eslint-disable-line react-hooks/exhaustive-deps

  const sel = shown.find((c) => c.id === selectedId) ?? shown[0] ?? null
  const at = sel ? shown.indexOf(sel) : -1
  const go = (delta: number) => { const next = shown[at + delta]; if (next) setSelectedId(next.id) }
  const next = (from: ReviewCase) => {
    const after = shown.slice(at + 1).concat(shown.slice(0, at))
    const x = after.find((c) => c.id !== from.id && !isDone(c) && (status === 'all' || stateOf(c) === status || status === 'done'))
    if (x) setSelectedId(x.id)
  }
  useEffect(() => { if (sel) refs.current[sel.id]?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const [last, setLast] = useState<{ c: ReviewCase; text: string } | null>(null)   // the answer Undo takes back
  const answer = async (c: ReviewCase, draft: Draft | null) => {
    setLast(draft ? { c, text: verdict(c, draft) } : null)
    setDone((x) => ({ ...x, [c.id]: !!draft }))
    if (draft) next(c)
    if (!(await save(itemsOf(c, draft)))) setDone((x) => ({ ...x, [c.id]: c.done }))
  }
  /** Confirm the app's answer on every case shown that has one. */
  const confirmShown = () => {
    const todo = shown.filter((c) => !isDone(c) && ready(c, draftOf(c)))
    if (!todo.length) return
    setDone((x) => ({ ...x, ...Object.fromEntries(todo.map((c) => [c.id, true])) }))
    save(todo.flatMap((c) => itemsOf(c, draftOf(c))))
  }
  const undoLast = () => { if (last) { setSelectedId(last.c.id); answer(last.c, null) } }
  const confirmable = shown.filter((c) => !isDone(c) && ready(c, draftOf(c))).length
  const [wide, setWide] = useStored('mrm-wide', false)
  useKeys({ w: () => setWide(!wide) })

  return (
    <section className="cs-body rv">
      {d.wins.length > 0 && <Wins wins={d.wins} source={d.source} save={save} />}

      <div className={`sm-review ${wide ? 'wide' : ''}`}>
        <div className="sm-list">
          <div className="sm-list-head">
            <label className="cs-search sm-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search song, writer, ISRC, LNV row…" /></label>
            <div className="rv-tabs rv-match">
              <button type="button" className={match === 'all' ? 'on' : ''} onClick={() => matchBy('all')}>All songs</button>
              {MATCHES.map(([id, label]) => (
                <button key={id} type="button" className={match === id ? 'on' : ''} onClick={() => matchBy(id)}>{label}<span>{n(matchCount[id])}</span></button>
              ))}
            </div>
            <div className="rv-tabs">
              {([['needs', 'Needs you', tally.needs], ['sure', 'App answered', tally.sure], ['done', 'Done', tally.done],
                ['all', 'All', tally.needs + tally.sure + tally.done]] as const).map(([id, label, x]) => (
                <button key={id} type="button" className={status === id && kind !== 'lnv_only' ? 'on' : ''} onClick={() => filterBy(id, kind === 'lnv_only' ? 'all' : kind)}>{label}{x != null && <span>{n(x)}</span>}</button>
              ))}
            </div>
            <div className="rv-list-tools">
              <select className="rv-kind" value={kind} onChange={(e) => filterBy(status, e.target.value as typeof kind)} aria-label="Kind of case">
                <option value="all">Every kind</option>
                {KINDS.filter((k) => counts[k] || kind === k).map((k) => <option key={k} value={k}>{KIND[k].label} ({n(counts[k])})</option>)}
                <option value="lnv_only">Only in the LNV ({n(d.counts.lnv_only)})</option>
              </select>
              {kind !== 'lnv_only' && confirmable > 0 && (
                <button type="button" className="btn sm" onClick={confirmShown} title="Accept the app's answer on every song shown that has one">
                  <CheckCheck size={14} />Accept all {n(confirmable)}</button>
              )}
            </div>
          </div>
          <div className="sm-list-items">
            {kind === 'lnv_only' ? <p className="sm-list-none">The LNV songs {d.source} does not have are listed on the right.</p>
              : !shown.length ? <p className="sm-list-none">{status === 'needs' && !q ? 'Nothing needs you here – look at “App answered” and confirm.' : status === 'sure' && !q ? 'Every answer here is confirmed.' : 'Nothing matches.'}</p>
                : shown.map((x) => {
                  const v = verdict(x, draftOf(x))
                  return (
                    <button key={x.id} type="button" ref={(el) => { refs.current[x.id] = el }} className={`sm-item ${sel?.id === x.id ? 'on' : ''}`} onClick={() => setSelectedId(x.id)}>
                      <span className="sm-item-text">
                        <b>{x.title}</b>
                        <small>{x.kind === 'versions' ? '' : `${KIND[x.kind].label}${x.muso.length > 1 ? ' · ' : ''}`}{x.muso.length > 1 ? `${x.muso.length} versions` : ''}{v !== 'Needs you' && <> · <span className="rv-verdict">{v}</span></>}</small>
                      </span>
                      {isDone(x) && <Check size={15} strokeWidth={2.5} className="rv-done" />}
                    </button>
                  )
                })}
          </div>
        </div>
        {kind === 'lnv_only' ? <LnvOnly d={d} />
          : sel ? <CaseView key={`${sel.id}-${sel.done}-${JSON.stringify(sel.answer)}-${sel.merge?.status}`} c={sel} source={d.source} done={isDone(sel)}
            pos={at + 1} total={shown.length} prev={() => go(-1)} next={() => go(1)} possible={matches.get(sel.id) === 'possible'} answer={(draft) => answer(sel, draft)} last={last} undoLast={undoLast}
            wideBtn={<WideBtn wide={wide} toggle={() => setWide(!wide)} />} />
            : <div className="sm-detail sm-detail-none muted">Nothing to show.</div>}
      </div>
    </section>
  )
}

/** One answer that settles many songs at once – most songs first. */
function Wins({ wins, source, save }: { wins: Step1['wins']; source: string; save: (items: CleanDecisionIn[]) => Promise<boolean> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [open, setOpen] = useStored('mrm-wins-open', false)
  const answer = async (w: Step1['wins'][number], choice: CleanDecisionIn['choice']) => {
    setBusy(w.key)
    await save([{ key: w.key, choice, data: w.kind === 'writer' ? { name: w.name } : { a: w.a, b: w.b, songs: w.examples } }])
    setBusy(null)
  }
  const shown = all ? wins : wins.slice(0, 4)
  return (
    <div className={`rv-wins ${open ? '' : 'shut'}`}>
      <button type="button" className="rv-wins-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={15} className="rv-chev" /><b>Biggest wins</b>
        <span className="muted">{open ? 'One answer settles every song it counts – and counts for every client.'
          : `${wins.length} questions that settle ${n(wins.reduce((t, w) => t + w.songs, 0))} songs`}</span>
        <span className="grow" /><span className="rv-wins-toggle">{open ? 'Less' : 'More'}</span>
      </button>
      {open && shown.map((w) => (
        <div key={w.key} className={`rv-win ${busy === w.key ? 'busy' : ''}`}>
          <span className="rv-win-n"><b>{n(w.songs)}</b>songs</span>
          <div className="rv-win-text">
            <span>{w.kind === 'name' ? <>Are <b>{w.a}</b> and <b>{w.b}</b> one person?</>
              : w.kind === 'writer' ? <>{source} lists <b>{w.name}</b> as a writer where the LNV does not. Is {w.name} a writer of these songs?</>
                : <>Are <b>{w.a}</b> and <b>{w.b}</b> the same publisher?</>}</span>
            <small className="muted">e.g. {w.examples.join(' · ')}</small>
          </div>
          <div className="rv-win-btns">
            {busy === w.key ? <span className="spinner small-dark" /> : w.kind === 'name' ? (
              <><button type="button" className="btn sm primary" onClick={() => answer(w, 'same')}>Same person</button>
                <button type="button" className="btn sm" onClick={() => answer(w, 'different')}>Two people</button></>
            ) : w.kind === 'writer' ? (
              <><button type="button" className="btn sm primary" onClick={() => answer(w, 'ignore')}>Not a writer – ignore</button>
                <button type="button" className="btn sm" onClick={() => answer(w, 'keep')}>Is a writer</button></>
            ) : (
              <><button type="button" className="btn sm primary" onClick={() => answer(w, 'same')}>Same company</button>
                <button type="button" className="btn sm" onClick={() => answer(w, 'different')}>Different companies</button></>
            )}
          </div>
        </div>
      ))}
      {open && wins.length > 4 && <button type="button" className="cs-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${wins.length - 4} more`}</button>}
    </div>
  )
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="sm-kbd">{children}</kbd>
const value = (v?: string | string[]) => list(v).join(', ')

/** Enter / A = confirm, R = keep the versions apart, U = undo, ↑ ↓ = move – while not typing. */
export function useKeys(keys: Record<string, () => void>) {
  const ref = useRef(keys)
  ref.current = keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement
      const tick = t instanceof HTMLInputElement && (t.type === 'checkbox' || t.type === 'radio')   // keys still work after a tick
      if (/^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !tick)) return
      if (e.key === 'Enter' && /^(BUTTON|A)$/.test(t.tagName)) return
      const fn = ref.current[e.key === 'Enter' ? 'enter' : e.key.toLowerCase()]
      if (!fn) return
      e.preventDefault()
      fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** One column of a comparison: a record (Muso version, LNV row, IPRS work), its badge, and – when it can be
 *  chosen – the tick that chooses it. */
export type Col = {
  r: CaseRecord; badge: string; tone: 'muso' | 'lnv' | 'iprs' | 'add'
  pick?: { on: boolean; label: string; radio?: boolean; change: () => void }
}

const writersOf = (r: CaseRecord) => [...new Set([...list(r.fields.Lyricist), ...list(r.fields.Composer)])]

/** How a version's credits differ from the main version's, both ways. */
function creditsDiff(r: CaseRecord, main: CaseRecord) {
  const not = (f: string, a: string[], b: string[]) => a.filter((x) => !inList(f, b, x))
  const w = writersOf(r), mw = writersOf(main), p = list(r.fields.Publisher), mp = list(main.fields.Publisher)
  return ([['Writers also', not('Lyricist', w, mw)], ['Writers without', not('Lyricist', mw, w)],
    ['Publisher also', not('Publisher', p, mp)], ['Publisher without', not('Publisher', mp, p)]] as const).filter(([, names]) => names.length)
}

/** The same-song checks over a record's column: why it fits or not, in a few words. */
function Marks({ r, ref }: { r: CaseRecord; ref?: CaseRecord | null }) {
  const why = Array.isArray(r.why) ? r.why.filter((w) => !w.good || w.text.startsWith('Same')) : []
  const marks = why.length ? why.map((w) => [w.good ? 'good' : 'bad', w.text.split(' – ')[0]] as const)
    : r.check ? (['writers', 'publisher'] as const).map((k) => RULE[k][r.check![k] as keyof typeof RULE[typeof k]] as readonly [string, string]) : []
  if (!marks.length) return null
  // the rule looks at every version and at one company under two names: the names on screen may differ, so do not say "same"
  const pubs = list(ref?.fields.Publisher)
  const renamed = pubs.length > 0 && !list(r.fields.Publisher).some((x) => inList('Publisher', pubs, x))
  return <div className="rvc-marks">{marks.map(([tone, text]) => [tone, text === 'Same publisher' && renamed ? 'Publisher counted as same' : text] as const).map(([tone, text]) => <span key={text} className={tone}>{tone === 'good' ? <Check size={12} /> : tone === 'bad' ? <X size={12} /> : '?'}{text}</span>)}</div>
}

/** Records side by side, one column each and one line per field, so every difference sits on the same line. The
 *  title is marked against the `base` column; among the writers, only the names the other side does not have are. */
export function Compare({ cols, fields = SHOW, base = 0 }: { cols: Col[]; fields?: string[]; base?: number | null }) {
  const ref = base == null ? null : cols[base]?.r
  const rows = fields.filter((f) => DECIDES.has(f) || cols.some((c) => list(c.r.fields[f]).length))
  const odd = (f: string, i: number, x: string) => {
    if (base == null || !WRITERS.has(f) || cols.length < 2) return false
    // the backend knows aliases and group members: a column it calls the same writers has no odd names
    const sameWriters = (r: CaseRecord) => r.check?.writers === 'same' || (Array.isArray(r.why) && r.why.some((w) => w.text === 'Same writers'))
    if (i !== base && sameWriters(cols[i].r)) return false
    // lyricist or composer does not matter: DSPs list everyone under both, so a name counts if it is anywhere on the other side
    const against = i === base ? cols.filter((_, j) => j !== base).map((c) => c.r) : [ref!]
    return against.every((o) => !sameWriters(o) && writersOf(o).length > 0 && !inList(f, writersOf(o), x))
  }
  return (
    <table className="rvc" style={{ minWidth: 100 + cols.length * 240 }}>
      <thead>
        <tr>
          <th className="rvc-f" />
          {cols.map((c, i) => (
            <th key={i} className={`rvc-h ${c.tone} ${c.pick?.on ? 'on' : ''}`}>
              <span className="rvc-name">{c.badge}</span>
              {c.pick && <label className="rvc-pick"><input type={c.pick.radio ? 'radio' : 'checkbox'} checked={c.pick.on} onChange={c.pick.change} />{c.pick.label}</label>}
              <Marks r={c.r} ref={i === base ? null : ref} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f}>
            <th className="rvc-f">{f}</th>
            {cols.map((c, i) => {
              const v = list(c.r.fields[f])
              const cell = ref && i !== base && f === 'Title' ? cellOf(f, list(ref.fields[f]), v) : ''
              return <td key={i} className={`${cell ? `c-${cell}` : ''} ${f === 'Title' ? 'rvc-title' : ''} ${f === 'ISRC' || f === 'IPRS code' || f === 'ISWC' ? 'mono' : ''}`}>
                {v.length ? v.map((x, j) => <Fragment key={j}>{j > 0 && ', '}<span className={odd(f, i, x) ? 'rvc-odd' : ''}>{x}</span></Fragment>) : <span className="muted">—</span>}</td>
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** One answer of a case: green when it is the chosen one (Enter), otherwise its own key. */
export function Act({ on, k, onClick, disabled, children }: { on?: boolean; k?: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return <button type="button" className={`btn sm-big ${on ? 'primary' : ''}`} disabled={disabled} onClick={onClick}>{on && <Check size={15} />}{children}{on ? <Kbd>Enter</Kbd> : k && <Kbd>{k}</Kbd>}</button>
}

/** A part of a case that folds: its heading opens and closes it, and the choice is remembered. */
export function Part({ id, title, note, initial = true, children }: { id: string; title: ReactNode; note?: ReactNode; initial?: boolean; children: ReactNode }) {
  const [open, setOpen] = useStored(`mrm-part-${id}`, initial)
  return (
    <section className={`rv-sec ${open ? '' : 'shut'}`}>
      <button type="button" className="rv-sec-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={15} className="rv-chev" /><b>{title}</b>{note && <small className="muted">{note}</small>}
      </button>
      {open && <div className="rv-sec-body">{children}</div>}
    </section>
  )
}

/** A yes/no the viewer chose before (folded parts, the wide case, the slim sidebar), kept in this browser. */
export function useStored(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { const x = localStorage.getItem(key); return x == null ? initial : x === '1' } catch { return initial } })
  return [v, (x: boolean) => { setV(x); try { localStorage.setItem(key, x ? '1' : '0') } catch { /* private mode */ } }]
}

/** Show the case across the whole width (the list hidden), or the list and the case side by side. */
export const WideBtn = ({ wide, toggle }: { wide: boolean; toggle: () => void }) => (
  <button type="button" className="sm-nav wide-btn" onClick={toggle} title={wide ? 'Show the list (W)' : 'Expand – hide the list (W)'}>
    {wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}<span>{wide ? 'Show list' : 'Expand'}</span>
  </button>
)

function CaseView({ c, source, done, pos, total, prev, next, possible, answer, last, undoLast, wideBtn }: {
  c: ReviewCase; source: string; done: boolean; pos: number; total: number; prev: () => void; next: () => void
  possible: boolean; answer: (d: Draft | null) => void; last: { c: ReviewCase; text: string } | null; undoLast: () => void; wideBtn: ReactNode
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(c))
  const [allVersions, setAllVersions] = useState(c.muso.length <= 8 || c.kind === 'isrc')
  const twice = c.kind === 'twice'
  const merging = !!c.merge
  const names = c.names
  const main = c.muso[0]
  // LNV rows the same-song rule turned down: not the same song, so they stay folded away and are linked only by the reviewer
  const near = c.lnv.length > 0 && c.lnv.every((r) => r.check && (r.check.writers !== 'same' || r.check.publisher === 'differ'))
  const single = !twice && !near && c.lnv.length === 1
  // a song with one LNV row needs no tick: its button says which row
  const sameRows = draft.rows.length ? draft.rows : single ? [c.lnv[0].row!] : []
  const act = (choice: Choice, rows: number[] = []) => answer({ ...draft, choice, rows })
  const confirm = () => { if (ready(c, draft)) answer(draft) }
  const same = () => { if (sameRows.length) act('same', sameRows) }
  const add = () => { if (!names && !twice) act('add') }
  const skip = () => { if (!names && !twice) act('not_ours') }
  const apart = () => { if (merging) answer({ ...draft, in: [main.id!] }) }
  const isSame = () => { if (names) act('same') }
  const different = () => { if (names || twice) act('different') }
  useKeys({ enter: confirm, a: confirm, s: names ? isSame : same, n: add, x: skip, d: different, r: apart, u: () => { if (done) answer(null); else undoLast() }, arrowdown: next, j: next, arrowup: prev, k: prev })

  const toggleIn = (id: number) => setDraft({ ...draft, in: draft.in.includes(id) ? draft.in.filter((x) => x !== id) : [...draft.in, id] })
  const pick = (row: number) => {
    if (twice) { setDraft({ ...draft, rows: [row], choice: 'same' }); return }
    const rows = draft.rows.includes(row) ? draft.rows.filter((x) => x !== row) : [...draft.rows, row]
    setDraft({ ...draft, rows, choice: rows.length ? 'same' : null })
  }
  const adding = draft.choice === 'add' || draft.choice === 'not_ours'
  const updates = adding ? [] : c.updates.filter((u) => sameRows.includes(u.row))
  const toggleUpdate = (key: string) => setDraft({ ...draft, reject: draft.reject.includes(key) ? draft.reject.filter((k) => k !== key) : [...draft.reject, key] })
  const kept = updates.filter((u) => !draft.reject.includes(u.key)).length
  const versions = allVersions ? c.muso : c.muso.slice(0, 8)
  const inCount = merging ? draft.in.length : c.muso.length

  const fails = near ? [c.lnv.some((r) => r.check?.writers !== 'same') && 'writers', c.lnv.some((r) => r.check?.publisher === 'differ') && 'publisher'].filter(Boolean).join(' and ') : ''
  const outcome = names
    ? draft.choice === 'same' ? `From now on “${names.a}” and “${names.b}” are one person – for every client.`
      : draft.choice === 'different' ? 'They stay two people; the app stops asking.' : 'Are these two spellings one person?'
    : twice
    ? draft.choice === 'different' ? 'Nothing changes – they are two songs.'
      : draft.rows.length ? (c.isrc ? `The ISRC stays on LNV row ${draft.rows[0]} only.` : `LNV row ${draft.rows[0]} is kept; the other row is marked as a repeat, never deleted.`)
        : c.isrc ? 'Tick the LNV row the ISRC belongs to.' : 'Tick the LNV row to keep, or say they are different songs.'
    : draft.choice === 'same' ? `LNV row ${draft.rows.join(' + ')} ${kept ? `gets ${kept} blank detail${kept > 1 ? 's' : ''} filled from ${source}` : 'stays as it is'}.`
      : draft.choice === 'add' ? 'A new row is added to the LNV.'
        : draft.choice === 'not_ours' ? "Nothing goes into the LNV – not the client's song."
          : near ? `No LNV row has the same writers and publisher (they have different ${fails}). Add it as a new song, or skip it.`
            : c.lnv.length > 1 ? 'Tick the LNV row this song is, or add it as a new song.'
              : c.lnv.length ? `Is this ${source} song LNV row ${c.lnv[0].row}?` : 'Add it to the LNV, or skip it.'

  const lnvCols: Col[] = c.lnv.map((r) => ({
    r, badge: `LNV row ${r.row}`, tone: 'lnv',
    pick: single ? undefined : { on: draft.rows.includes(r.row!), radio: twice, change: () => pick(r.row!),
      label: twice ? (c.isrc ? 'Has the ISRC' : 'Keep this row') : near ? 'Link anyway' : 'This is the song' },
  }))
  const musoCol: Col[] = twice || !main ? [] : [{ r: main, badge: c.muso.length > 1 ? `${source} – main version` : source, tone: 'muso' }]
  // a turned-down row joins the comparison only once the reviewer ticks it
  const cols: Col[] = [...musoCol, ...(near ? lnvCols.filter((x) => x.pick?.on) : lnvCols)]
  const closest = near ? lnvCols.filter((x) => !x.pick?.on) : []
  const onSame = draft.choice === 'same' && ready(c, draft)

  return (
    <div className="sm-detail rv-case">
      <div className="sm-detail-top">
        <div className="sm-detail-nav">
          <span className="rv-kind-name">{KIND[c.kind].label}</span>
          {done && <span className="rv-done-name"><Check size={13} />Done</span>}
          <span className="grow" />
          <span className="muted rv-pos">{n(pos)} of {n(total)}</span>
          <button type="button" className="sm-nav" disabled={pos <= 1} onClick={prev} title="Previous (↑)"><ArrowLeft size={15} /></button>
          <button type="button" className="sm-nav" disabled={pos >= total} onClick={next} title="Next (↓)"><ArrowRight size={15} /></button>
          {wideBtn}
        </div>
        <h3>{c.title}</h3>
        <p className={`rv-why ${c.tone ?? ''}`}>{c.kind === 'versions' ? `${c.muso.length} ${source} versions – similar title, and the same writers as each other.` : c.why}{c.answer.by === 'app' && c.answer.why ? ` · App: ${c.answer.why}` : ''}</p>
      </div>

      <div className="rv-scroll">
        {names ? (
          <div className="rv-names">
            <b>{names.a}</b><span className="rv-names-eq">=?</span><b>{names.b}</b>
            {names.songs.length > 0 && <p className="rv-none">For example: {names.songs.join(' · ')}</p>}
          </div>
        ) : <Compare cols={cols} />}

        {closest.length > 0 && possible && (
          <section className="rv-fills">
            <h4>Possible LNV row{closest.length > 1 ? 's' : ''} – different {fails}. Tick one only if {source}'s credits are wrong.</h4>
            <Compare cols={[...musoCol, ...closest]} />
          </section>
        )}

        {closest.length > 0 && !possible && (
          <Part id="closest" initial={false} title={`Closest LNV row${closest.length > 1 ? 's' : ''} – not the same song`}
            note={`different ${fails}; open only if you think ${source}'s credits are wrong`}>
            <Compare cols={[...musoCol, ...closest]} />
          </Part>
        )}

        {updates.length > 0 && (
          <section className="rv-fills">
            <h4>Blank in the LNV – filled from {source}</h4>
            {updates.map((u) => (
              <label key={u.key} className={draft.reject.includes(u.key) ? 'off' : ''}>
                <input type="checkbox" checked={!draft.reject.includes(u.key)} onChange={() => toggleUpdate(u.key)} />
                <span className="muted">{single ? '' : `Row ${u.row} · `}{u.field}</span><b>{u.value}</b>{u.more > 0 && <small className="muted">+{u.more} more recordings</small>}
              </label>
            ))}
          </section>
        )}

        {draft.choice === 'add' && c.new_row && (
          <Part id="new-row" title="See the new LNV row" initial={false}>
            <Compare cols={[{ r: { fields: c.new_row } as CaseRecord, badge: 'New LNV row', tone: 'add' }]} fields={SHOW.concat(['Length', 'Label'])} base={null} />
          </Part>
        )}

        {c.muso.length > 1 && (
          <Part id={`versions-${c.kind === 'versions' || c.kind === 'isrc' ? 'open' : 'shut'}`} initial={c.kind === 'versions' || c.kind === 'isrc'}
            title={`${c.muso.length} ${source} versions`} note={merging ? `${inCount} counted as this song – untick one that is a different song` : undefined}>
            <div className="rv-table-wrap">
              <table className="rv-versions">
                <thead><tr>{merging && <th />}<th>Title</th><th>Album</th><th>Singer</th><th>ISRC</th><th>Year</th><th>Credits against the main version</th></tr></thead>
                <tbody>{versions.map((r, i) => {
                  const on = !merging || draft.in.includes(r.id!)
                  const diff = creditsDiff(r, main)
                  return (
                    <tr key={r.id} className={on ? '' : 'off'}>
                      {merging && <td>{i > 0 && <input type="checkbox" checked={on} onChange={() => toggleIn(r.id!)} aria-label="Same song" />}</td>}
                      <td><b>{value(r.fields.Title)}</b>{r.version && <span className="cs-tag">{r.version}</span>}
                        {r.link && <a className="sm-link" href={r.link} target="_blank" rel="noreferrer" title="Listen"><ExternalLink size={12} /></a>}</td>
                      <td className="muted">{value(r.fields['Film / album'])}</td>
                      <td>{value(r.fields.Singer)}</td>
                      <td className="mono small">{list(r.fields.ISRC).join(', ')}</td>
                      <td className="muted nowrap">{value(r.fields.Year).slice(0, 4)}</td>
                      <td>{i === 0 ? <span className="muted">Main version</span> : diff.length ? diff.map(([label, names]) => <div key={label}><span className="muted">{label}: </span><span className="rvc-odd">{names.join(', ')}</span></div>) : <span className="muted">Same</span>}</td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
            {!allVersions && <button type="button" className="cs-more" onClick={() => setAllVersions(true)}>Show all {c.muso.length} versions</button>}
          </Part>
        )}
      </div>

      {/* the answer – always on screen */}
      <div className="rv-bar">
        <p className="rv-outcome">{outcome}</p>
        <div className="sm-decide">
          {names ? (
            <>
              <Act on={draft.choice === 'same'} k="S" onClick={isSame}>Same person</Act>
              <Act on={draft.choice === 'different'} k="D" onClick={different}>Two people</Act>
            </>
          ) : twice ? (
            <>
              <Act on={onSame} onClick={confirm} disabled={!draft.rows.length}>{draft.rows.length ? (c.isrc ? `ISRC is on row ${draft.rows[0]}` : `Keep row ${draft.rows[0]}`) : 'Tick a row above'}</Act>
              <Act on={draft.choice === 'different'} k="D" onClick={different}>{c.isrc ? 'Belongs to neither' : 'Different songs'}</Act>
            </>
          ) : (
            <>
              {c.lnv.length > 0 && (!near || sameRows.length > 0) && <Act on={onSame} k="S" onClick={same} disabled={!sameRows.length}>{sameRows.length ? `Same song as row ${sameRows.join(' + ')}` : 'Tick an LNV row above'}</Act>}
              <Act on={draft.choice === 'add'} k="N" onClick={add}>{c.lnv.length && !near ? 'New song – add to LNV' : 'Add to the LNV'}</Act>
              <Act on={draft.choice === 'not_ours'} k="X" onClick={skip}>Not the client's</Act>
              {merging && <button type="button" className="rv-text-btn" onClick={apart}>Keep separate<Kbd>R</Kbd></button>}
            </>
          )}
          {done && <button type="button" className="rv-text-btn" onClick={() => answer(null)}><Undo2 size={14} />Undo<Kbd>U</Kbd></button>}
          {!done && last && last.c.id !== c.id && <button type="button" className="rv-text-btn rv-last" onClick={undoLast} title="Take this answer back"><Undo2 size={14} /><span>Saved {last.c.title}: {last.text}</span><b>Undo</b><Kbd>U</Kbd></button>}
        </div>
      </div>
    </div>
  )
}

function LnvOnly({ d }: { d: Step1 }) {
  const [limit, setLimit] = useState(60)
  return (
    <div className="sm-detail rv-case">
      <div className="sm-detail-top">
        <h3>Only in the LNV</h3>
        <p className="rv-why">{n(d.lnv_only.length)} LNV songs that no {d.source} song matched. They stay in the LNV as they are – older or unreleased works, or {d.source} does not list the client on them.</p>
      </div>
      <div className="rv-scroll">
        <table className="rv-versions">
          <thead><tr><th>LNV row</th><th>Song</th><th>Film / album</th><th>Year</th><th>Credits against the main version</th></tr></thead>
          <tbody>{d.lnv_only.slice(0, limit).map((x) => (
            <tr key={x.row}><td className="muted">{x.row}</td><td><b>{x.title}</b></td><td>{x.film}</td><td className="muted">{x.year}</td><td>{x.writers.join(', ')}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {d.lnv_only.length > limit && <button type="button" className="cs-more" onClick={() => setLimit(limit + 200)}>Show more ({n(d.lnv_only.length - limit)} left)</button>}
    </div>
  )
}
