import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, CheckCheck, ChevronRight, FilePlus2, Keyboard, PartyPopper, Save, Search, SkipForward, Undo2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, Empty, Kbd } from '../../components/ui'
import type { DecisionItem, MasterEditIn } from '../../lib/api'
import type { ReviewItem } from '../../lib/model'
import { samePerson } from '../../lib/names'
import { useRun } from '../../lib/run'
import type { Candidate, Contributor, IprsWork, MasterPerson, MasterSong } from '../../types'

/** A decision made on screen, sent to the server in batches (one reprocessing instead of one per click). */
type Pending = { action: 'link'; rows: number[]; alt: boolean } | { action: 'new'; rows: number[] }
type Confidence = 'strong' | 'likely' | 'weak'
type View = 'todo' | 'ready'
const AUTO_SAVE = 20

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const CONF_LABEL: Record<Confidence, string> = { strong: 'Strong', likely: 'Likely', weak: 'Weak' }

/** The master songs a reviewer can pick from: the current link first, then the candidates. */
function optionsOf(item: ReviewItem): Candidate[] {
  const l = item.link
  const list = [...l.candidates]
  if (l.master_row && !list.some((c) => c.row === l.master_row))
    list.unshift({ row: l.master_row, title: l.master_title ?? '', methods: [], title_score: 0, shared_contributors: 0, match: l.match })
  return list
}
const suggestedRow = (item: ReviewItem) => item.link.master_row ?? item.link.candidates[0]?.row ?? null

function confidence(item: ReviewItem): Confidence {
  const opts = optionsOf(item)
  const top = opts.find((c) => c.row === suggestedRow(item))
  if (!top) return 'weak'
  const rival = opts.find((c) => c.row !== top.row)
  const proof = top.methods.length > 0 || top.shared_contributors > 0
  const clear = !rival || rival.title_score < 100 || (rival.match?.score ?? 0) <= (top.match?.score ?? 0) - 1
  if (top.title_score >= 100 && proof && clear) return 'strong'
  if (top.title_score < 92 && !top.methods.length) return 'weak'
  return 'likely'
}

/** The reason in plain words. */
function plainWhy(item: ReviewItem, options: number) {
  const why = item.why || ''
  if (/more than one master song/i.test(why)) return `The same IPRS code is on ${options} songs in our master – pick the right one.`
  if (/title only/i.test(why)) return 'Only the title matches – no code or writer in common to prove it.'
  if (/score only/i.test(why)) return 'Linked, but the evidence is weak – please check it is the same song.'
  if (item.kind === 'confirm_title') return 'Linked by title and a shared writer only – no code in common.'
  return why
}

const people = (list: Contributor[]) => list.filter((c, i) => list.findIndex((x) => norm(x.name) === norm(c.name)) === i)
const masterPeople = (list: MasterPerson[]) => list.filter((c, i) => list.findIndex((x) => norm(x.name) === norm(c.name)) === i)

type Mark = 'same' | 'diff' | 'missing' | 'none'
function markOf(a: string[], b: string[], eq = (x: string, y: string) => norm(x) === norm(y)): Mark {
  const x = a.filter(Boolean), y = b.filter(Boolean)
  if (!x.length && !y.length) return 'none'
  if (!x.length || !y.length) return 'missing'
  return x.some((v) => y.some((w) => eq(v, w))) ? 'same' : 'diff'
}

function Row({ label, iprs, master, mark }: { label: string; iprs: ReactNode; master: ReactNode; mark: Mark }) {
  return (
    <div className={`cmp-row ${mark}`}>
      <span className="cmp-label">{label}</span>
      <span className="cmp-val">{iprs || <span className="muted">—</span>}</span>
      <span className="cmp-val">{master || <span className="muted">—</span>}</span>
      <span className="cmp-mark">{mark === 'same' ? <><Check size={13} />Same</> : mark === 'diff' ? <><X size={13} />Different</> : mark === 'missing' ? 'One side only' : ''}</span>
    </div>
  )
}

function PeopleCell({ list, other, share }: { list: { name: string; ipi: string; role: string; share: number | null }[]; other: { name: string; ipi: string }[]; share?: boolean }) {
  if (!list.length) return null
  return (
    <span className="cmp-people">
      {list.map((p) => {
        const ok = other.some((o) => samePerson(p.name, o.name, p.ipi, o.ipi))
        return <span key={p.name + p.role} className={`person ${other.length ? (ok ? 'ok' : 'no') : ''}`} title={p.ipi ? `IPI ${p.ipi}` : undefined}>
          {other.length > 0 && (ok ? <Check size={11} /> : <X size={11} />)}{p.name}<em>{p.role}{share && p.share !== null ? ` · ${p.share}%` : ''}</em></span>
      })}
    </span>
  )
}

/** IPRS work next to one master song, field by field. */
function Comparison({ work, song, option }: { work: IprsWork; song: MasterSong; option?: Candidate }) {
  const writersI = people([...work.authors, ...work.composers]).map((c) => ({ name: c.name, ipi: c.ipi, role: c.role, share: c.per_own }))
  const writersM = masterPeople([...song.authors, ...song.composers]).map((c) => ({ name: c.name, ipi: c.ipi, role: c.role, share: c.perf }))
  const pubI = people(work.publishers).map((c) => ({ name: c.name, ipi: c.ipi, role: c.role, share: c.per_own }))
  const pubM = masterPeople(song.publishers).map((c) => ({ name: c.name, ipi: c.ipi, role: c.role, share: c.perf }))
  const codes = song.registrations.filter((r) => r.society === 'IPRS' && r.code).map((r) => r.code)
  const pEq = (lists: [typeof writersI, typeof writersM]) =>
    !lists[0].length && !lists[1].length ? 'none' : !lists[0].length || !lists[1].length ? 'missing'
      : lists[0].every((p) => lists[1].some((o) => samePerson(p.name, o.name, p.ipi, o.ipi))) ? 'same' : 'diff'
  const titleMark: Mark = norm(work.title) === norm(song.title) ? 'same' : option?.alt_title ? 'same' : 'diff'
  return (
    <div className="cmp">
      <div className="cmp-row cmp-head">
        <span />
        <span className="src iprs"><b>IPRS report</b><small>work {work.internal_no}</small></span>
        <span className="src master"><b>Our master (LNV)</b><small>row {song.row}{song.sn ? ` · SN ${song.sn}` : ''}</small></span>
        <span />
      </div>
      <Row label="Title" iprs={<b>{work.title}</b>} master={<b>{song.title}</b>} mark={titleMark} />
      <Row label="Alternate title" iprs={work.alt_title} master={song.alt_title && <>{song.alt_title}{option?.alt_title && <span className="cmp-note">matched “{option.alt_title}”</span>}</>}
        mark={work.alt_title || song.alt_title ? markOf([work.title, work.alt_title], [song.title, ...(song.alt_title ?? '').split(';')]) : 'none'} />
      <Row label="IPRS tunecode" iprs={<span className="mono">{work.internal_no}</span>} master={codes.length ? <span className="mono">{codes.join(', ')}</span> : null}
        mark={codes.length ? (codes.includes(work.internal_no) ? 'same' : 'diff') : 'missing'} />
      <Row label="ISWC" iprs={<span className="mono">{work.iswc}</span>} master={<span className="mono">{song.iswcs.join(', ')}</span>} mark={markOf([work.iswc], song.iswcs)} />
      <Row label="ISRC" iprs={<span className="mono">{work.isrc}</span>} master={<span className="mono">{song.isrcs.join(', ')}</span>} mark={markOf([work.isrc], song.isrcs)} />
      <Row label="Writers" iprs={<PeopleCell list={writersI} other={writersM} share />} master={<PeopleCell list={writersM} other={writersI} share />} mark={pEq([writersI, writersM])} />
      <Row label="Publishers" iprs={<PeopleCell list={pubI} other={pubM} />} master={<PeopleCell list={pubM} other={pubI} />} mark={pEq([pubI, pubM])} />
      <Row label="Film / album" iprs={work.production} master={song.movie} mark={markOf([work.production], [song.movie ?? ''])} />
      <Row label="Singers" iprs={work.performer} master={song.singers.map((s) => s.name).join(', ')}
        mark={markOf(work.performer ? work.performer.split(/[,/&]/) : [], song.singers.map((s) => s.name), (a, b) => samePerson(a, b))} />
      <Row label="Length" iprs={work.duration} master={song.duration} mark={markOf([work.duration], [song.duration ?? ''])} />
      <Row label="Language" iprs={work.language} master={null} mark="none" />
    </div>
  )
}

/** Step "Map with master": the IPRS works that wait for a person, one at a time, side by side with our master. */
export function SuggestionReview() {
  const { model, payload, saveDecisions, busy, decide } = useRun()
  const items = useMemo(() => model?.review ?? [], [model])
  const songs = useMemo(() => new Map((payload?.result.master?.songs ?? []).map((s) => [s.row, s])), [payload])
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [picked, setPicked] = useState<Record<string, number>>({})   // the option shown in the comparison
  const [same, setSame] = useState<Record<string, number[]>>({})     // the options ticked as the same song
  const [cursor, setCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [view, setView] = useState<View>('todo')
  const [query, setQuery] = useState('')
  const [help, setHelp] = useState(false)

  const conf = useMemo(() => new Map(items.map((i) => [i.id, confidence(i)])), [items])
  const todo = items.filter((i) => !pending[i.id])
  const ready = items.filter((i) => pending[i.id])
  const q = norm(query)
  const visible = (view === 'todo' ? todo : ready).filter((i) => !q || norm(i.title).includes(q)
    || norm(songs.get(suggestedRow(i) ?? 0)?.title).includes(q) || i.id.includes(query.trim()))
  const item = items.find((i) => i.id === cursor) ?? visible[0] ?? null
  const options = item ? optionsOf(item) : []
  const row = item ? picked[item.id] ?? suggestedRow(item) : null
  const option = options.find((c) => c.row === row)
  const song = row ? songs.get(row) : undefined
  const work = item ? model?.works.get(item.id) : undefined
  const decided = item ? pending[item.id] : undefined
  const sameRows = (i: ReviewItem) => same[i.id] ?? (suggestedRow(i) ? [suggestedRow(i)!] : [])
  const ticked = item ? sameRows(item) : []
  const toggleSame = (r: number) => item && setSame((cur) => {
    const list = sameRows(item)
    return { ...cur, [item.id]: list.includes(r) ? list.filter((x) => x !== r) : [...list, r] }
  })
  /** A master song whose title and alternate titles all differ from the IPRS title. */
  const needsAlt = (w: IprsWork | undefined, r: number) => {
    const sg = songs.get(r)
    return !!(w && sg && norm(w.title) !== norm(sg.title) && !(sg.alt_title ?? '').split(';').some((t) => norm(t) === norm(w.title)))
  }
  const altRows = ticked.filter((r) => needsAlt(work, r))
  const [altOn, setAltOn] = useState(true)
  useEffect(() => { setAltOn(true) }, [item?.id])

  // Save everything on screen; keeps the reviewer's place.
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const save = useCallback(async (which = pendingRef.current) => {
    const entries = Object.entries(which)
    if (!entries.length) return
    const decisions: DecisionItem[] = entries.map(([id, p]) => p.action === 'link'
      ? { internal_no: id, master_row: p.rows[0], also_rows: p.rows.slice(1) } : { internal_no: id, action: 'new', rejected_rows: p.rows })
    const edits: MasterEditIn[] = entries.flatMap(([id, p]) => p.action === 'link' && p.alt
      ? p.rows.filter((r) => needsAlt(model?.works.get(id), r)).map((r) => ({ master_row: r, field: 'Alternate title', internal_no: id, choice: 'iprs' as const })) : [])
    if (await saveDecisions(decisions, edits))
      setPending((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => !(id in which))))
  }, [saveDecisions]) // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the step (or the page) never loses decisions.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => () => { if (Object.keys(pendingRef.current).length) void saveRef.current(pendingRef.current) }, [])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (Object.keys(pendingRef.current).length) e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const nextAfter = (id: string, remaining: ReviewItem[]) => {
    const list = remaining.filter((i) => i.id !== id)
    const at = visible.findIndex((i) => i.id === id)
    return (visible.slice(at + 1).find((i) => list.includes(i)) ?? list[0])?.id ?? null
  }
  const record = (patch: Record<string, Pending>) => {
    const next = { ...pending, ...patch }
    setPending(next)
    if (Object.keys(next).length >= AUTO_SAVE && !busy) void save(next)
  }
  const linkPatch = (rows: number[], alt: boolean): Pending => ({ action: 'link', rows, alt })
  const newPatch = (i: ReviewItem): Pending => ({ action: 'new', rows: optionsOf(i).map((c) => c.row) })

  const accept = () => {
    if (!item || !ticked.length) return
    // The suggested song leads when it is ticked; the other ticked rows are versions of the same song.
    const lead = suggestedRow(item)
    const rows = lead && ticked.includes(lead) ? [lead, ...ticked.filter((r) => r !== lead)] : ticked
    record({ [item.id]: linkPatch(rows, altRows.length > 0 && altOn) })
    if (view === 'todo') setCursor(nextAfter(item.id, todo))
  }
  const markNew = () => {
    if (!item) return
    record({ [item.id]: newPatch(item) })
    if (view === 'todo') setCursor(nextAfter(item.id, todo))
  }
  const skip = () => { if (item) setCursor(nextAfter(item.id, visible)) }
  const undo = (id: string) => setPending((cur) => { const n = { ...cur }; delete n[id]; return n })
  const move = (d: number) => {
    const at = visible.findIndex((i) => i.id === item?.id)
    const n = visible[Math.min(Math.max(at + d, 0), visible.length - 1)]
    if (n) setCursor(n.id)
  }

  const bulk = (mode: 'accept' | 'new', ids: string[]) => {
    const patch: Record<string, Pending> = {}
    for (const id of ids) {
      const i = items.find((x) => x.id === id)
      if (!i) continue
      const rows = sameRows(i)
      if (mode === 'new') patch[id] = newPatch(i)
      else if (rows.length) patch[id] = linkPatch(rows, rows.some((r) => needsAlt(model?.works.get(id), r)))
    }
    record(patch)
    setSelected(new Set())
  }
  const strong = todo.filter((i) => conf.get(i.id) === 'strong')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea, .drawer') || e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'a' || k === 'enter') { e.preventDefault(); if (decided) return; accept() }
      else if (k === 'n') { e.preventDefault(); if (!decided) markNew() }
      else if (k === 's') { e.preventDefault(); skip() }
      else if (k === 'u' && item && decided) { e.preventDefault(); undo(item.id) }
      else if (k === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
      else if (k === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
      else if (k === 'x' && item) { e.preventDefault(); setSelected((s) => { const n = new Set(s); if (n.has(item.id)) n.delete(item.id); else n.add(item.id); return n }) }
      else if (/^[1-9]$/.test(k) && item && options[Number(k) - 1]) { e.preventDefault(); setPicked((p) => ({ ...p, [item.id]: options[Number(k) - 1].row })) }
      else if (e.key === ' ' && item && row && !decided) { e.preventDefault(); toggleSame(row) }
      else if (k === '?') setHelp((h) => !h)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!items.length) return <Empty icon={<PartyPopper size={22} />} title="Nothing to decide">Every IPRS work is linked by a code or has been confirmed by you.</Empty>

  const done = ready.length
  const allVisibleSelected = visible.length > 0 && visible.every((i) => selected.has(i.id))
  return (
    <section className="sg card flush">
      <header className="sg-top">
        <div className="grow">
          <h3>{todo.length ? `${todo.length} song${todo.length === 1 ? '' : 's'} need your decision` : 'All decided – save to apply'}</h3>
          <p className="muted small">Is the IPRS work the same song as the one in our master? Decide with one key – decisions are saved in batches.</p>
          <div className="sg-progress" aria-label={`${done} of ${items.length} decided`}><span style={{ width: `${(done / items.length) * 100}%` }} /></div>
        </div>
        <div className="sg-top-actions">
          {strong.length > 0 && <Button icon={<CheckCheck size={15} />} disabled={!!busy} onClick={() => bulk('accept', strong.map((i) => i.id))}
            title="Accept every suggestion with the same title and a code or writer in common">Accept {strong.length} strong</Button>}
          <Button variant="primary" icon={busy === 'decision' ? <span className="spinner small" /> : <Save size={15} />} disabled={!done || !!busy} onClick={() => save()}>
            {done ? `Save ${done} decision${done === 1 ? '' : 's'}` : 'Nothing to save'}</Button>
          <button type="button" className="icon-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelp(!help)}><Keyboard size={17} /></button>
        </div>
      </header>
      {help && (
        <div className="sg-help">
          <span><Kbd>A</Kbd> same song</span><span><Kbd>N</Kbd> new song</span><span><Kbd>S</Kbd> skip</span><span><Kbd>1</Kbd>–<Kbd>9</Kbd> show option</span><span><Kbd>Space</Kbd> tick / untick it</span>
          <span><Kbd>J</Kbd>/<Kbd>K</Kbd> next / previous</span><span><Kbd>X</Kbd> select</span><span><Kbd>U</Kbd> undo</span>
        </div>
      )}

      <div className="sg-body">
        <aside className="sg-queue">
          <div className="sg-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'todo'} className={view === 'todo' ? 'active' : ''} onClick={() => { setView('todo'); setCursor(null) }}>To decide<span>{todo.length}</span></button>
            <button type="button" role="tab" aria-selected={view === 'ready'} className={view === 'ready' ? 'active' : ''} onClick={() => { setView('ready'); setCursor(null) }}>Ready to save<span>{ready.length}</span></button>
          </div>
          <div className="sg-search">
            <input type="checkbox" checked={allVisibleSelected} aria-label="Select all"
              onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visible.map((i) => i.id)))} />
            <label className="search"><Search size={14} /><input type="search" placeholder="Search title or code…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          </div>
          {selected.size > 0 && (
            <div className="sg-bulk">
              <b>{selected.size} selected</b>
              {view === 'todo' ? <>
                <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={() => bulk('accept', [...selected])}>Accept</Button>
                <Button size="sm" icon={<FilePlus2 size={13} />} onClick={() => bulk('new', [...selected])}>New songs</Button>
              </> : <Button size="sm" icon={<Undo2 size={13} />} onClick={() => { selected.forEach(undo); setSelected(new Set()) }}>Undo</Button>}
              <button type="button" className="icon-btn" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></button>
            </div>
          )}
          <ul className="sg-list" role="listbox" aria-label="Songs to decide">
            {visible.map((i) => {
              const p = pending[i.id]
              const rs = p?.action === 'link' ? p.rows : sameRows(i)
              const r = rs[0]
              const c = conf.get(i.id)!
              return (
                <li key={i.id} role="option" aria-selected={i.id === item?.id} className={`${i.id === item?.id ? 'active' : ''} ${selected.has(i.id) ? 'checked' : ''}`} onClick={() => setCursor(i.id)}>
                  <input type="checkbox" checked={selected.has(i.id)} aria-label={`Select ${i.title}`} onClick={(e) => e.stopPropagation()}
                    onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n })} />
                  <div className="grow">
                    <strong>{i.title}</strong>
                    <span className="sg-sub">{p?.action === 'new' ? 'New song – not in our master' : <><ChevronRight size={11} />{songs.get(r ?? 0)?.title ?? 'no suggestion'}{r ? ` · row ${r}` : ''}{rs.length > 1 ? ` + ${rs.length - 1} more` : ''}</>}</span>
                  </div>
                  {p ? <span className={`sg-done ${p.action}`}>{p.action === 'link' ? <><Check size={11} />Same</> : <><FilePlus2 size={11} />New</>}</span>
                    : <span className={`conf ${c}`}>{CONF_LABEL[c]}</span>}
                </li>
              )
            })}
            {!visible.length && <li className="sg-empty muted small">{view === 'todo' ? (query ? 'No match for this search.' : 'Everything is decided – save to apply.') : 'Nothing waiting to be saved.'}</li>}
          </ul>
        </aside>

        <div className="sg-panel">
          {item && work ? (
            <>
              <div className="sg-panel-head">
                <span className="eyebrow">{options.length > 1 ? 'Which master songs are this IPRS work?' : 'Is this the same song?'}</span>
                <h3>{item.title}</h3>
                <p className="sg-why"><span className={`conf ${conf.get(item.id)}`}>{CONF_LABEL[conf.get(item.id)!]}</span>{plainWhy(item, options.length)}</p>
              </div>
              {options.length > 1 && (
                <>
                  <p className="sg-hint">Tick <b>every</b> row that is this song – a pathos, reprise or other version can share the IPRS code. Click a card to compare it below.</p>
                  <div className="sg-options" role="list" aria-label="Possible master songs">
                    {options.map((c, n) => {
                      const on = (decided?.action === 'link' ? decided.rows : ticked).includes(c.row)
                      return (
                        <div key={c.row} role="listitem" className={`sg-option ${c.row === row ? 'active' : ''} ${on ? 'same' : ''}`}
                          onClick={() => setPicked((p) => ({ ...p, [item.id]: c.row }))}>
                          <span className="opt-n">{n + 1}</span>
                          <span className="grow"><b>{songs.get(c.row)?.title ?? c.title}</b>
                            <small>row {c.row} · title {c.title_score}%{c.methods.length ? ` · same ${c.methods.join(', ')}` : ''}{c.shared_contributors ? ` · ${c.shared_contributors} writer${c.shared_contributors === 1 ? '' : 's'} in common` : ''}</small>
                            <label className="opt-same" onClick={(e) => e.stopPropagation()}>
                              <input type="checkbox" checked={on} disabled={!!decided} onChange={() => toggleSame(c.row)} />Same song</label></span>
                          {c.row === suggestedRow(item) && <span className="tag">best</span>}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
              {song ? <Comparison work={work} song={song} option={option} /> : <p className="muted">No master song suggested – choose "New song" or link it in the table below.</p>}
              {altRows.length > 0 && !decided && (
                <label className="sg-alt"><input type="checkbox" checked={altOn} onChange={(e) => setAltOn(e.target.checked)} />
                  <span>Also save the IPRS title <b>“{work.title}”</b> as <b>Alternate Work</b> in our master ({altRows.length === 1 ? `row ${altRows[0]}` : `rows ${altRows.join(', ')}`}) – the next report then matches it by itself.</span></label>
              )}
              <div className="sg-actions">
                {decided ? (
                  <>
                    <span className={`sg-decided ${decided.action}`}>{decided.action === 'link' ? <><Check size={15} />Same song as {decided.rows.length === 1 ? `row ${decided.rows[0]}` : `rows ${decided.rows.join(', ')}`}{decided.alt ? ' · IPRS title saved as alternate title' : ''}</> : <><FilePlus2 size={15} />New song – added to the final report</>}</span>
                    <Button icon={<Undo2 size={15} />} onClick={() => undo(item.id)}>Undo<Kbd>U</Kbd></Button>
                  </>
                ) : (
                  <>
                    <Button variant="primary" icon={<Check size={16} />} disabled={!ticked.length} onClick={accept}>
                      {ticked.length > 1 ? `Same song – ${ticked.length} rows` : 'Same song'}<Kbd>A</Kbd></Button>
                    <Button icon={<FilePlus2 size={16} />} onClick={markNew}>None of these – new song<Kbd>N</Kbd></Button>
                    <span className="grow" />
                    <Button variant="ghost" icon={<SkipForward size={15} />} onClick={skip}>Skip<Kbd>S</Kbd></Button>
                  </>
                )}
              </div>
              {item.link.master_row && item.link.method === 'Confirmed by reviewer' && (
                <button type="button" className="link-btn small" disabled={!!busy} onClick={() => decide(item.id, 'clear')}>Reset this song to automatic</button>
              )}
            </>
          ) : <Empty title="Pick a song on the left" />}
        </div>
      </div>
    </section>
  )
}
