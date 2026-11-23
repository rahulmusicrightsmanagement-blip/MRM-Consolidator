import { Link } from 'react-router-dom'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, Download, Link2, ListMusic, Plus, Search, Trash2, Undo2, X } from 'lucide-react'
import { ConfirmDialog, Dropdown, Guide, LockToggle } from '../../components/ui'
import { useFlag, usePeek } from '../../lib/peek'
import type { CleanDecisionIn } from '../../lib/api'
import { useClient } from '../../lib/client'
import { useToast } from '../../lib/toast'
import { api } from '../../lib/api'
import type { CaseKind, CaseRecord, ReviewCase, Stage1Done, Step1, TitleMode, TypedSong } from '../../types'
import { list, n, norm } from './Block'
import { Act, Block, Compare, Kbd, Legend, LnvCard, LnvRowDetails, MainCard, MapDialog, Part, SHOW, TitleSection, VersionDetails, VersionList,
  differs, targetsOf, useKeys, useStored, value } from './CaseParts'
import type { Col, Spot, Target, TitleLine } from './CaseParts'
import { logContext, songRef, withLog } from './changeLog'
import { FamilyView, NO_PENDING, SaveBar, TypedCard, checkedIn, familiesOf, inFamilies, openOf, pendingCount, pendingItems, stripSaved, toCheck } from './Families'
import type { Family, Pending } from './Families'
import { PICK_SHOWN, draftOf, isDeleted, isNewRow, itemsOf, keyOf, matchOf, pickKey, ready } from './reviewModel'
import type { Choice, Draft } from './reviewModel'
import { CompleteBar, Stage1Download } from './LnvStages'
import { EACH, LIST_NAMES, listCount, sheetsOf } from './lists'
import type { ListId, Lists } from './lists'
import { MapTo, RemarkPick } from './MapTo'
import { remarkItems, remarkOf } from './remarkModel'
import { UndoView } from './UndoView'
import { AddSong } from './AddSong'
import { saveBlob } from '../../lib/files'

export { useStored }

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


/** What a case does to the LNV, in two words – for the list. */
function verdict(c: ReviewCase, d: Draft) {
  if (c.kind === 'names') return d.choice === 'same' ? 'Same person' : d.choice === 'different' ? 'Two people' : 'Needs you'
  if (c.kind === 'twice') return d.choice === 'different' ? 'Different songs' : d.rows.length ? `Keep row ${d.rows[0]}` : 'Needs you'
  if (d.choice === 'same') return `Row ${d.rows.join(', ')}`
  return d.choice === 'add' ? 'Add to LNV' : d.choice === 'not_ours' ? 'Skip' : d.choice === 'deleted' ? 'Deleted' : 'Needs you'
}

/** What a saved answer puts into the LNV sheet, in one line – for the Saved tab. */
function effect(c: ReviewCase, d: Draft, source: string) {
  if (c.kind === 'names') return d.choice === 'same' ? `“${c.names?.a}” and “${c.names?.b}” are one person – for every client` : 'Two people – nothing changes'
  if (c.kind === 'twice') return d.choice === 'different' ? 'Two different songs – nothing changes'
    : c.isrc ? `The ISRC stays on row ${d.rows[0]} only` : `Row ${d.rows[0]} kept; the other row marked as a repeat (never deleted)`
  const placed = (r: CaseRecord) => r.part === 'version' && !r.lnv_row && (!c.merge || d.in.includes(r.id!))
  const rows = c.muso.filter(placed).length
  const more = rows ? ` · ${rows} new row${rows > 1 ? 's' : ''} for its other recordings, naming the original` : ''
  if (d.choice === 'same') {
    const fills = c.updates.filter((u) => d.rows.includes(u.row) && !d.reject.includes(u.key)).length
    const picks = Object.keys(d.picks).length
    return `Linked to LNV row ${d.rows.join(' + ')}${fills ? ` · ${fills} blank${fills > 1 ? 's' : ''} filled from ${source}` : ''}${picks ? ` · ${picks} value${picks > 1 ? 's' : ''} changed (${source}'s or typed)` : ''}${more}`
  }
  if (d.choice === 'add') return (c.origin ? `New LNV row naming row ${c.origin.row} “${value(c.origin.fields.Title)}” as its original` : 'New LNV row') + more
  if (d.choice === 'deleted') return 'Deleted – nothing of it goes into the LNV' + (c.was?.length ? ` (it was matched to LNV row ${c.was.map((r) => r.row).join(', ')})` : '')
  return d.choice === 'not_ours' ? "Not added – not the client's song" : ''
}

/** The lists of step 2: the LNV match by song name (Songs), the songs no LNV row matches (Not in the LNV), the songs
 *  the reviewer sent to a new row (New row) and the songs they deleted (Deleted songs) – the last two map back. */
type Section = 'songs' | 'new' | 'newrow' | 'deleted'
const SECTION: Record<Section, string> = { songs: 'Songs', new: 'Not in the LNV', newrow: 'New row', deleted: 'Deleted songs' }
type Sort = 'az' | 'za' | 'most' | 'exact' | 'possible' | 'todo'
const SORTS: [Sort, string][] = [['az', 'A → Z'], ['za', 'Z → A'], ['most', 'Most matches first'], ['exact', 'Most exact matches first'],
  ['possible', 'Most possible matches first'], ['todo', 'Most left to check first']]
/** One line of the list: a song name with every song it holds (f), one song or question (c), or the LNV-only songs. */
type Item = { id: string; f?: Family; c?: ReviewCase; t?: TypedSong; lnvOnly?: boolean }

export default function SongReview({ d, save: rawSave, act, stage1, complete }: {
  d: Step1; save: (items: CleanDecisionIn[]) => Promise<boolean>
  /** a save of another kind (a typed song, an undo), then the step loaded again */
  act: (work: () => Promise<unknown>) => Promise<boolean>
  /** step 2 marked completed (its LNV is the stage 2 LNV) – and marking it so, or opening it again */
  stage1: Stage1Done | null; complete: (done: boolean) => Promise<boolean>
}) {
  const { clientId } = useClient()
  const toast = useToast()
  const [q, setQ] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const [help, setHelp] = useState(false)
  const [asking, setAsking] = useState(false)   // "Accept all" waits for a yes
  // two lists: the songs of the LNV match (by song name) and the songs not in the LNV
  const [section, setSection] = useState<Section>('songs')
  const [show, setShow] = useState<'all' | 'todo' | 'done'>('all')
  const [sort, setSortState] = useState<Sort>(() => { try { return (localStorage.getItem('mrm-sort') as Sort) || 'az' } catch { return 'az' } })
  const setSort = (s: Sort) => { setSortState(s); try { localStorage.setItem('mrm-sort', s) } catch { /* private mode */ } }
  // the song the reviewer was on is still open when they come back
  const placeKey = `mrm-place-${clientId}`
  const [selectedId, setSelectedId] = useState<string | null>(() => { try { return localStorage.getItem(placeKey) } catch { return null } })
  const pickSection = (s: Section) => { setView('review'); setSection(s); setSelectedId(null) }

  const families = useMemo(() => familiesOf(d.cases, d.typed), [d])
  const familyOf = useMemo(() => new Map(families.flatMap((f) => f.cases.map((c) => [c.id, f] as const))), [families])
  // every save says what it did, in plain words, for the Undo section
  const ctx = useMemo(() => logContext(d, familyOf), [d, familyOf])
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const rawRef = useRef(rawSave)
  rawRef.current = rawSave
  const save = useCallback((items: CleanDecisionIn[]) => rawRef.current(withLog(items, ctxRef.current)), [])
  // ---- the queue: ticks, values and titles save themselves a moment after the last change, or at once with Save
  const [pending, setPending] = useState<Pending>(NO_PENDING)
  const [flushing, setFlushing] = useState(false)
  const live = useRef({ pending, d, save })
  live.current = { pending, d, save }
  /** Save the queue now, with these decisions after it (a later decision on the same key wins). */
  const commit = async (extra: CleanDecisionIn[] = []) => {
    const { pending: snap, d: now, save: send } = live.current
    const items = [...pendingItems(snap, now), ...extra]
    if (!items.length) return true
    setFlushing(true)
    const ok = await send(items)
    setFlushing(false)
    if (ok) setPending((x) => stripSaved(x, snap))
    return ok
  }
  const count = pendingCount(pending)
  useEffect(() => {
    if (!count || flushing) return
    const t = window.setTimeout(() => { void commit() }, 2500)
    return () => window.clearTimeout(t)
  }, [pending, flushing])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (pendingCount(live.current.pending)) e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      // leaving the step saves what waits
      const { pending: snap, d: now, save: send } = live.current
      if (pendingCount(snap)) void send(pendingItems(snap, now))
    }
  }, [])

  const typed = useMemo(() => d.typed ?? [], [d])
  const loose = useMemo(() => d.cases.filter((c) => c.kind !== 'names' && c.kind !== 'twice' && !inFamilies(c) && !isNewRow(c) && !isDeleted(c)), [d])
  const newRows = useMemo(() => d.cases.filter(isNewRow), [d])
  const deleted = useMemo(() => d.cases.filter(isDeleted), [d])
  const others = useMemo(() => d.cases.filter((c) => c.kind === 'names' || c.kind === 'twice'), [d])
  // the songs the app matched exactly: what a recording can be mapped onto
  const targets = useMemo(() => targetsOf(d.cases, (c) => matchOf(c) === 'exact'), [d])

  // answered here, before the next load shows it – by song (keyOf), since an answer can move a song to another case
  const [done, setDone] = useState<Record<string, boolean>>({})
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  // a load drops only what it confirms: a save still on its way keeps its answer on screen
  useEffect(() => {
    const server = new Map(d.cases.map((c) => [keyOf(c), c.done]))
    setDone((x) => Object.fromEntries(Object.entries(x).filter(([k, v]) => server.get(k) !== v)))
  }, [d])
  const isDone = (c: ReviewCase) => done[keyOf(c)] ?? c.done
  // the Saved tab: every answer the reviewer gave, newest first – this session's at once, before the reload
  const [view, setView] = useState<'review' | 'saved' | 'undo'>('review')
  const showSaved = () => { void commit(); setView('saved') }
  // the Undo section, at the song it was opened from
  const [undoSong, setUndoSong] = useState<string | null>(null)
  const showUndo = (song: string | null) => { void commit(); setUndoSong(song); setView('undo') }
  const [editing, setEditing] = useState<TypedSong | null>(null)   // a typed song being corrected from New row
  const [savedAt, setSavedAt] = useState<Record<string, { draft: Draft; at: number }>>({})
  const saved = useMemo(() => d.cases
    .filter((c) => keyOf(c) in savedAt || isDone(c))
    .map((c) => ({ c, draft: savedAt[keyOf(c)]?.draft ?? draftOf(c, d.picks), at: savedAt[keyOf(c)]?.at ?? 0,
      you: keyOf(c) in savedAt || c.answer.by === 'you' || c.merge?.by === 'you' }))
    .sort((a, b) => b.at - a.at || a.c.title.localeCompare(b.c.title)),
  [d, savedAt, done])   // eslint-disable-line react-hooks/exhaustive-deps
  // the whole step, whatever the lists show: what still needs an answer, and what only needs a confirm
  const progress = useMemo(() => {
    const t = { needs: 0, sure: 0 }
    d.cases.forEach((c) => { if (!c.auto && !isDone(c)) t[ready(c, draftOf(c)) ? 'sure' : 'needs'] += 1 })
    return t
  }, [d, done])   // eslint-disable-line react-hooks/exhaustive-deps

  const left = (f: Family) => toCheck(pending, f)
  const shown: Item[] = useMemo(() => {
    const s = norm(q)
    const hit = (c: ReviewCase) => norm(c.title).includes(s) || [...c.muso, ...c.lnv].some((r) => norm(`${r.ref} ${Object.values(r.fields).flat().join(' ')}`).includes(s))
    // a search stays inside the open list; the song on screen stays listed until another is picked
    const keep = (id: string, open: boolean) => id === selectedId || show === 'all' || (show === 'todo') === open
    const byTitle = (a: string, b: string) => sort === 'za' ? b.localeCompare(a) : a.localeCompare(b)
    if (section === 'songs') {
      const score = (f: Family) => sort === 'most' ? f.exact.length + f.possible.length : sort === 'exact' ? f.exact.length
        : sort === 'possible' ? f.possible.length : sort === 'todo' ? left(f) : 0
      const fs = families.filter((f) => (!s || norm(f.title).includes(s) || f.cases.some(hit)) && keep(f.id, left(f) > 0))
        .sort((a, b) => score(b) - score(a) || byTitle(a.title, b.title))
      const os = others.filter((c) => (!s || hit(c)) && keep(c.id, !isDone(c))).sort((a, b) => byTitle(a.title, b.title))
      return [...fs.map((f): Item => ({ id: f.id, f })), ...os.map((c): Item => ({ id: c.id, c }))]
    }
    if (section === 'newrow' || section === 'deleted') {   // answered, every one: nothing is left to check there
      const cs = (section === 'newrow' ? newRows : deleted).filter((c) => !s || hit(c)).sort((a, b) => byTitle(a.title, b.title)).map((c): Item => ({ id: c.id, c }))
      const ts = section === 'newrow' ? typed.filter((t) => !s || norm(Object.values(t.record.fields).flat().join(' ')).includes(s)) : []
      return [...cs, ...ts.sort((a, b) => byTitle(a.data.title, b.data.title)).map((t): Item => ({ id: t.key, t }))]
    }
    const cs = loose.filter((c) => (!s || hit(c)) && keep(c.id, !isDone(c))).sort((a, b) => byTitle(a.title, b.title))
    return [...cs.map((c): Item => ({ id: c.id, c })), ...(!s && show === 'all' && d.lnv_only.length ? [{ id: 'lnv_only', lnvOnly: true }] : [])]
  }, [d, q, section, show, sort, selectedId, done, pending, families, loose, others, newRows, deleted, typed])   // eslint-disable-line react-hooks/exhaustive-deps

  const sel = shown.find((x) => x.id === selectedId) ?? shown[0] ?? null
  const at = sel ? shown.indexOf(sel) : -1
  const go = (delta: number) => { const x = shown[at + delta]; if (x) setSelectedId(x.id) }
  const open = (x: Item) => !x.lnvOnly && !x.t && (x.f ? left(x.f) > 0 : !isDone(x.c!))
  const next = (from: ReviewCase) => {
    const after = shown.slice(at + 1).concat(shown.slice(0, at))
    const x = after.find((y) => y.c?.id !== from.id && open(y))
    if (x) setSelectedId(x.id)
  }
  useEffect(() => { if (sel) refs.current[sel.id]?.scrollIntoView({ block: 'nearest' }) }, [sel])
  useEffect(() => { if (sel) try { localStorage.setItem(placeKey, sel.id) } catch { /* private mode */ } }, [sel, placeKey])

  const [last, setLast] = useState<{ c: ReviewCase; text: string } | null>(null)   // the answer Undo takes back
  const remember = (c: ReviewCase, draft: Draft | null) => setSavedAt((x) => {
    const { [keyOf(c)]: _, ...rest } = x   // eslint-disable-line @typescript-eslint/no-unused-vars
    return draft ? { ...rest, [keyOf(c)]: { draft, at: Date.now() } } : rest
  })
  const answer = async (c: ReviewCase, draft: Draft | null, move = true) => {
    setLast(draft ? { c, text: verdict(c, draft) } : null)
    setDone((x) => ({ ...x, [keyOf(c)]: !!draft }))
    remember(c, draft)
    if (draft && move) next(c)
    if (!(await save(itemsOf(c, draft)))) {
      setDone((x) => ({ ...x, [keyOf(c)]: c.done }))
      remember(c, null)
    }
  }
  /** Confirm the app's answer on every song shown that has one. */
  const cases = shown.flatMap((x) => x.c ? [x.c] : [])
  const confirmable = cases.filter((c) => !isDone(c) && ready(c, draftOf(c))).length
  const confirmShown = () => {
    const todo = cases.filter((c) => !isDone(c) && ready(c, draftOf(c)))
    if (!todo.length) return
    setDone((x) => ({ ...x, ...Object.fromEntries(todo.map((c) => [keyOf(c), true])) }))
    const now = Date.now()
    setSavedAt((x) => ({ ...x, ...Object.fromEntries(todo.map((c) => [keyOf(c), { draft: draftOf(c), at: now }])) }))
    save(todo.flatMap((c) => itemsOf(c, draftOf(c))))
  }
  const undoLast = () => { if (last) { setSelectedId(last.c.id); answer(last.c, null) } }
  /** Open a song from the Saved tab: its song name in Songs, or the song under Not in the LNV. */
  const openCase = (c: ReviewCase) => {
    const f = familyOf.get(c.id)
    setView('review'); setQ(''); setShow('all')
    setSection(f || c.kind === 'names' || c.kind === 'twice' ? 'songs' : isDeleted(c) ? 'deleted' : isNewRow(c) ? 'newrow' : 'new')
    setSelectedId(f ? f.id : c.id)
  }
  // the song list: closes by itself to a slim strip (it opens while the pointer is on it) – or locked open beside the song
  const [listLock, setListLock] = useFlag('mrm-list-lock', false)
  const listPeek = usePeek(60, 360)
  const lockList = () => { setListLock(!listLock); listPeek.set(false) }
  // how the numbers add up: one paragraph, folded away so the song has the room
  const [sumOpen, setSumOpen] = useStored('mrm-sum-open', false)
  const pick = (id: string) => { setSelectedId(id); if (!listLock) listPeek.set(false) }
  useKeys({ w: lockList, '/': () => { if (!listLock) listPeek.set(true); searchRef.current?.focus() }, '?': () => setHelp((h) => !h) })
  const lockBtn = <LockToggle className="sm-nav wide-btn" locked={listLock} what="song list" toggle={lockList} label={<span>{listLock ? 'List locked' : 'Lock list'}</span>} />
  const sorts = section === 'songs' ? SORTS : SORTS.slice(0, 2)
  // the step's numbers: exact and possible matches (one per LNV row, and how many are not ticked yet), songs to answer
  const tot = families.reduce((a, f) => {
    const o = openOf(pending, f)
    return { ...a, exact: a.exact + f.exact.length, possible: a.possible + f.possible.length, exactLeft: a.exactLeft + o.exact, possibleLeft: a.possibleLeft + o.possible, checked: a.checked + checkedIn(pending, f) }
  }, { exact: 0, possible: 0, exactLeft: 0, possibleLeft: 0, checked: 0, newLeft: loose.filter((c) => !isDone(c)).length })
  const sizeOf: Record<Section, number> = { songs: families.length, new: loose.length, newrow: newRows.length + typed.length, deleted: deleted.length }
  const matchCounts = (
    <span className="ls-sub"><i className="exact">Exact match {n(tot.exact)}{tot.exactLeft ? ` (${n(tot.exactLeft)} to check)` : ''}</i>
      <i className="possible">Possible match {n(tot.possible)}{tot.possibleLeft ? ` (${n(tot.possibleLeft)} to check)` : ''}</i>
      <i className="checked">Checked {n(tot.checked)}</i></span>
  )
  // the lists as Excel: the rows the counts count, with the answers waiting saved first
  const lists: Lists = { families, loose, newRows, deleted, isDone, d, p: pending }
  const [preparing, setPreparing] = useState<ListId | null>(null)
  const listFile = async (id: ListId) => {
    setPreparing(id)
    try {
      if (!(await commit())) throw new Error('The latest changes could not be saved – try again.')
      const file = await api.listFile(clientId, LIST_NAMES[id], sheetsOf(lists, id))
      saveBlob(file.blob, file.name)
      toast(`${file.name} downloaded`, 'good')
    } catch (e) { toast((e as Error).message, 'bad') } finally { setPreparing(null) }
  }
  // "Which songs": how many each choice lists in the open list
  const showCount = (k: 'all' | 'todo' | 'done') => {
    const open = section === 'songs' ? families.filter((f) => left(f) > 0).length + others.filter((c) => !isDone(c)).length : loose.filter((c) => !isDone(c)).length
    const all = section === 'songs' ? families.length + others.length : loose.length
    return k === 'all' ? all : k === 'todo' ? open : all - open
  }
  const sortShown = sorts.some(([id]) => id === sort) ? sort : 'az'

  return (
    <section className="cs-body rv">
      {/* the end of the step: mark it completed – its LNV goes on to LNV vs IPRS – and the download */}
      <CompleteBar clientId={clientId} stage1={stage1} needs={progress.needs} flush={() => commit()} complete={complete} />
      {/* the two views of the step: the songs to review, and everything saved – what goes into the LNV */}
      <div className="rv-views">
        <button type="button" className={view === 'review' ? 'on' : ''} onClick={() => setView('review')}>Review songs<span>{n(d.cases.filter((c) => !c.auto && !isDone(c)).length)} open</span></button>
        <button type="button" className={`rv-view-saved ${view === 'saved' ? 'on' : ''}`} onClick={showSaved} title="Every saved answer and what it puts into the LNV">
          <Check size={14} />Saved to the LNV<span key={saved.length} className="rv-bump">{n(saved.length)}</span></button>
        <button type="button" className={`rv-view-undo ${view === 'undo' ? 'on' : ''}`} onClick={() => showUndo(null)} title="Every change, song by song – undo any of them"><Undo2 size={14} />Undo</button>
        <SaveBar count={count} busy={flushing} flush={() => { void commit() }} />
        <Steps steps={[
          { label: progress.needs ? `Answer ${n(progress.needs)} song${progress.needs > 1 ? 's' : ''}` : 'Every doubt answered', left: progress.needs,
            title: 'Songs the app could not decide: compare and pick an answer', go: () => { pickSection('songs'); setShow('todo') } },
          { label: progress.sure ? `Confirm ${n(progress.sure)} app answer${progress.sure > 1 ? 's' : ''}` : "App's answers confirmed", left: progress.sure,
            title: 'The app has an answer: check it and tick it', go: () => { pickSection('songs'); setShow('todo') } },
          { label: stage1 ? 'Completed' : 'Mark as completed', left: stage1 ? 0 : progress.needs + progress.sure, title: 'See every saved answer, download the stage 1 LNV and mark the step completed', go: showSaved },
        ]} />
      </div>

      {/* the four lists in one dropdown, the only place that gives their counts: exact and possible matches (one per LNV
          row), Not in the LNV, New row, Deleted songs – on screen whether the song list is open or not */}
      {view === 'review' && (
        <div className="rv-lists">
          <Dropdown className="rv-list-dd" label="Which list" value={section} onChange={pickSection} menuWidth={400}
            shown={<span className="ls-shown"><b>{SECTION[section]}</b><span className="ls-n">{n(sizeOf[section])}</span>{section === 'songs' && matchCounts}</span>}
            options={[
              { value: 'songs', label: <ListOpt name="Songs" count={sizeOf.songs} />, hint: matchCounts },
              { value: 'new', label: <ListOpt name="Not in the LNV" count={sizeOf.new} />, hint: tot.newLeft ? `${n(tot.newLeft)} need an answer` : 'All answered' },
              { value: 'newrow', label: <ListOpt name="New row" count={sizeOf.newrow} />, hint: 'Sent to a new row – each maps back to its match', sep: true },
              { value: 'deleted', label: <ListOpt name="Deleted songs" count={sizeOf.deleted} />, hint: 'Nothing of them goes into the LNV – each maps back' },
            ]} />
          <Dropdown<ListId> className="rv-dl" label="Download a list as Excel" value={'' as ListId} onChange={(id) => void listFile(id)} menuWidth={340}
            shown={preparing ? <><span className="spinner small-dark" />Preparing…</> : <><Download size={15} />Download Excel</>}
            options={[...EACH.map((id) => ({ value: id as ListId, label: <ListOpt name={LIST_NAMES[id]} count={listCount(lists, id)} />, disabled: !listCount(lists, id) || !!preparing })),
              { value: 'all', label: LIST_NAMES.all, hint: 'One file, each list on a sheet of its own', sep: true, disabled: !!preparing }]} />
          <span className="rv-total-note muted">One match is one LNV row.
            <button type="button" className="rv-text-btn rv-sum-btn" onClick={() => setSumOpen(!sumOpen)} aria-expanded={sumOpen}>{sumOpen ? 'Hide how it adds up' : 'How it adds up'}</button></span>
        </div>
      )}

      {view === 'review' && d.wins.length > 0 && <Wins wins={d.wins} source={d.source} save={save} />}

      {/* how the numbers add up, in one line */}
      {view === 'review' && sumOpen && (() => {
        const matched = families.reduce((t, f) => t + f.cases.length, 0)
        return (
          <p className="rv-sum">
            <b>How it adds up:</b> {d.source} has <b>{n(matched + loose.length + newRows.length + deleted.length)} songs</b> – <b>{n(matched)}</b> match an LNV row and sit under <b>{n(families.length)} song
            names</b> in Songs, <b>{n(loose.length)}</b> match none (Not in the LNV){newRows.length > 0 && <>, <b>{n(newRows.length)}</b> sent to a new row</>}{deleted.length > 0 && <>, <b>{n(deleted.length)}</b> deleted</>}{typed.length > 0 && <> (and <b>{n(typed.length)}</b> typed by you)</>}; <b>{n(d.counts.needs)}</b> still need your answer, “to check” counts the matches
            not ticked yet, and Other questions ({n(others.length)}) are name spellings and LNV rows entered twice.
          </p>
        )
      })()}

      {view === 'undo' ? <UndoView key={undoSong ?? ''} song={undoSong} flush={() => commit()} act={act} version={d} /> : view === 'saved' ? <SavedView saved={saved} d={d} open={openCase} undo={(c) => answer(c, null, false)} flush={() => commit()} /> :
      <div className={`sm-review ${listLock ? 'locked' : 'auto'} ${!listLock && listPeek.open ? 'peek' : ''}`}>
        <div className="sm-dock" {...(listLock ? {} : listPeek.handlers)}>
        {!listLock && (
          <button type="button" className="sm-rail" onClick={listPeek.toggle} aria-expanded={listPeek.open}
            title="The song list – point at it to open it; lock it to keep it open (W)">
            <ListMusic size={17} /><span className="sm-rail-text">{SECTION[section]}</span><b>{n(shown.length)}</b>
          </button>
        )}
        <div className="sm-list">
          <div className="sm-list-head">
            <div className="sm-list-top">
              <label className="cs-search sm-search"><Search size={15} /><input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
                placeholder={section === 'songs' ? 'Search in Songs: song, writer, ISRC, LNV row…' : `Search in ${SECTION[section]}…`} /></label>
              <LockToggle className="icon-btn" locked={listLock} what="song list" toggle={lockList} />
            </div>
            {help && <div className="rv-keys"><span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span><span><Kbd>Enter</Kbd> accept</span><span><Kbd>S</Kbd> same</span><span><Kbd>N</Kbd> add</span><span><Kbd>X</Kbd> not the client's</span><span><Kbd>M</Kbd> map to a song</span><span><Kbd>U</Kbd> undo</span><span><Kbd>/</Kbd> search</span><span><Kbd>W</Kbd> lock the list</span></div>}
            <div className="rv-list-tools">
              {(section === 'songs' || section === 'new') && <Dropdown className="rv-dd" label="Which songs" value={show} onChange={(v) => { setShow(v); setSelectedId(null) }} options={[
                { value: 'all', label: <ListOpt name="Show all" count={showCount('all')} />, hint: section === 'songs' ? 'Every song name' : 'Every song not in the LNV' },
                { value: 'todo', label: <ListOpt name={section === 'songs' ? 'Left to check' : 'Needs an answer'} count={showCount('todo')} />, hint: section === 'songs' ? 'A match not ticked yet' : 'No answer saved yet' },
                { value: 'done', label: <ListOpt name={section === 'songs' ? 'All checked' : 'Done'} count={showCount('done')} />, hint: section === 'songs' ? 'Every match ticked' : 'Answered' },
              ]} />}
              <Dropdown className="rv-dd" label="Order" value={sortShown} onChange={setSort} options={sorts.map(([id, label]) => ({ value: id, label }))} />
              {section === 'new' && confirmable > 0 && (
                <button type="button" className="btn sm" onClick={() => setAsking(true)} title="Accept the app's answer on every song shown that has one">
                  <CheckCheck size={14} />Accept all {n(confirmable)}</button>
              )}
            </div>
          </div>
          <div className="sm-list-items">
            {!shown.length ? <p className="sm-list-none">{q ? <>Nothing matches in {SECTION[section]}.<br />
              <button type="button" className="btn sm" onClick={() => pickSection(section === 'songs' ? 'new' : 'songs')}>Search {section === 'songs' ? 'Not in the LNV' : 'Songs'}</button></>
              : section === 'newrow' ? <>No song sent to a new row yet.<br /><small>“Not a match → New row in the LNV” in Songs, or “Add to the LNV”, puts a song here.</small></>
                : section === 'deleted' ? <>No song deleted.<br /><small>“Delete” on a song in Songs or Not in the LNV puts it here.</small></>
                  : show === 'todo' ? 'Nothing left to check here.' : 'Nothing here.'}</p>
              : shown.map((x, i) => {
                const on = sel?.id === x.id
                if (x.lnvOnly) return (
                  <button key={x.id} type="button" ref={(el) => { refs.current[x.id] = el }} className={`sm-item ${on ? 'on' : ''}`} onClick={() => pick(x.id)}>
                    <span className="sm-item-text"><b>Only in the LNV</b><small>{n(d.lnv_only.length)} LNV songs {d.source} does not have</small></span>
                  </button>
                )
                if (x.f) {
                  const f = x.f, l = left(f)
                  return (
                    <button key={x.id} type="button" ref={(el) => { refs.current[x.id] = el }} className={`sm-item ${on ? 'on' : ''}`} onClick={() => pick(x.id)}>
                      <span className="sm-item-text">
                        <b>{f.title}</b>
                        <small><span className="li-n exact">Exact {n(f.exact.length)}</span><span className="li-n possible">Possible {n(f.possible.length)}</span>
                          {l > 0 && <span className="rv-verdict">{n(l)} to check</span>}</small>
                      </span>
                      {!l && <Check size={15} strokeWidth={2.5} className="rv-done" />}
                    </button>
                  )
                }
                if (x.t) return (
                  <button key={x.id} type="button" ref={(el) => { refs.current[x.id] = el }} className={`sm-item ${on ? 'on' : ''}`} onClick={() => pick(x.id)}>
                    <span className="sm-item-text"><b>{x.t.data.title}</b><small>Typed by you · in “{x.t.to_title}”</small></span><Check size={15} strokeWidth={2.5} className="rv-done" />
                  </button>
                )
                const c = x.c!
                const v = verdict(c, draftOf(c))
                return (
                  <Fragment key={x.id}>
                    {section === 'songs' && !shown[i - 1]?.c && <p className="sm-list-sep">Other questions</p>}
                    <button type="button" ref={(el) => { refs.current[x.id] = el }} className={`sm-item ${on ? 'on' : ''}`} onClick={() => pick(x.id)}>
                      <span className="sm-item-text">
                        <b>{c.title}</b>
                        {section === 'newrow' || section === 'deleted'
                          ? <small>{c.was?.length ? <>Was LNV row {c.was.map((r) => r.row).join(', ')}</> : 'Not in the LNV'}{c.muso.length > 1 ? ` · ${c.muso.length} versions` : ''}</small>
                          : <small>{c.answer.recheck && !isDone(c) && <span className="rv-recheck">Check again · </span>}{c.kind === 'versions' ? '' : `${KIND[c.kind].label}${c.muso.length > 1 ? ' · ' : ''}`}{c.muso.length > 1 ? `${c.muso.length} versions` : ''}{v !== 'Needs you' && <> · <span className="rv-verdict">{v}</span></>}</small>}
                      </span>
                      {section === 'deleted' ? <Trash2 size={15} className="rv-gone" /> : isDone(c) && <Check size={15} strokeWidth={2.5} className="rv-done" />}
                    </button>
                  </Fragment>
                )
              })}
          </div>
        </div>
        </div>
        {sel?.lnvOnly ? <LnvOnly d={d} />
          : sel?.t ? <div className="sm-detail rv-case"><div className="sm-detail-top"><div className="sm-detail-nav"><h3>{sel.t.data.title}</h3><span className="grow" />{lockBtn}</div>
            <p className="rv-why">A song you typed: a new LNV row under “{sel.t.to_title}”.</p></div>
            <div className="rv-scroll"><TypedCard t={sel.t} busy={flushing} edit={() => setEditing(sel.t!)} remove={() => { const t = sel.t!; void commit([{ key: t.key, choice: null }]).then((ok) => { if (ok) toast(`“${t.data.title}” is removed – Undo brings it back`, 'good') }) }}>
              {families.some((f) => f.typed.includes(sel.t!)) && <button type="button" className="btn sm" onClick={() => { const f = families.find((y) => y.typed.includes(sel.t!))!; pickSection('songs'); setShow('all'); setSelectedId(f.id) }}>Open “{sel.t.to_title}”</button>}</TypedCard></div></div>
          : sel?.f ? <FamilyView key={sel.f.id} f={sel.f} d={d} p={pending} set={setPending} pos={at + 1} total={shown.length} prev={() => go(-1)} next={() => go(1)}
            wideBtn={lockBtn} targets={targets} commit={commit} toast={toast} families={families} loose={loose} act={act} showUndo={showUndo} />
          : sel?.c ? <CaseView key={`${sel.c.id}-${sel.c.done}-${JSON.stringify(sel.c.answer)}-${sel.c.merge?.status}-${sel.c.muso.length}`} c={sel.c} source={d.source} done={isDone(sel.c)} picks={d.picks} savedCount={saved.length} showSaved={showSaved}
            titles={d.titles ?? {}} d={d} p={pending} families={families} targets={targets} mapped={(all, t) => { toast(`${all ? 'Every version' : 'The version'} now belongs to “${t.title}”${t.row != null ? ` (LNV row ${t.row})` : ''}`, 'good'); if (all && sel.c) next(sel.c) }}
            linked={(t) => toast(`“${sel.c!.title}” is now the same song as LNV row ${t.row} “${t.title}” – it is under Songs`, 'good')}
            toast={toast} showUndo={() => showUndo(songRef(sel.c!, familyOf.get(sel.c!.id)).key)}
            pos={at + 1} total={shown.length} prev={() => go(-1)} next={() => go(1)} possible={matchOf(sel.c) === 'possible'} answer={(draft) => answer(sel.c!, draft)} last={last} undoLast={undoLast} save={save}
            wideBtn={lockBtn} />
            : <div className="sm-detail sm-detail-none muted">Nothing to show.</div>}
      </div>}
      {editing && families[0] && <AddSong f={families.find((f) => f.typed.some((t) => t.key === editing.key)) ?? families[0]} families={families} loose={loose} d={d} p={pending} edit={editing} commit={commit} act={act}
        close={() => setEditing(null)} done={(t) => toast(t, 'good')} />}
      <ConfirmDialog open={asking} tone="primary" title={`Accept the app's answer on ${n(confirmable)} songs?`} confirmLabel="Accept all" onCancel={() => setAsking(false)}
        onConfirm={() => { confirmShown(); setAsking(false) }}>
        <p>They all move to Done. You can still open any one of them there and change it.</p>
      </ConfirmDialog>
    </section>
  )
}

/** A list's name in a dropdown, its count beside it. */
const ListOpt = ({ name, count }: { name: string; count: number }) => <span className="ls-opt"><span>{name}</span><b>{n(count)}</b></span>

/** The step's three moves in order – answer the doubts, confirm the app's answers, download – the current one marked. */
function Steps({ steps }: { steps: { label: string; left: number; title: string; go: () => void }[] }) {
  const now = steps.findIndex((s) => s.left > 0)
  return (
    <ol className="rv-steps" aria-label="What to do next">
      {steps.map((s, i) => {
        const state = i === steps.length - 1 ? (now === -1 ? 'now' : '') : s.left ? (i === now ? 'now' : '') : 'ok'
        return (
          <li key={i} className={state}>
            <button type="button" onClick={s.go} title={s.title}>
              <i>{state === 'ok' ? <Check size={11} strokeWidth={3} /> : i + 1}</i>{s.label}
            </button>
          </li>
        )
      })}
    </ol>
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


/** Where one DSP recording lands in the LNV with the answer on screen: linked to the song's row, a version row the
 *  LNV already has, a new row, kept apart as its own song, or not added (or waiting for the answer). */
type Land = Spot & { i: number; r: CaseRecord }
const LAND_LABEL = { link: ['linked', 'linked'], new: ['new row', 'new rows'], have: ['already in the LNV', 'already in the LNV'],
  wait: ['waiting for you', 'waiting for you'], off: ['not added here', 'not added here'] } as const
const LAND_ORDER = Object.keys(LAND_LABEL) as Land['tone'][]

function landsOf(c: ReviewCase, d: Draft, rows: number[], near: boolean, isIn: (r: CaseRecord) => boolean, fills: number, picks: number, source: string): Land[] {
  const ours = d.choice === 'same' && rows.length ? `LNV row ${rows.join(' + ')}` : d.choice === 'add' ? 'the new row' : ''
  const changes = [fills && `${fills} blank${fills > 1 ? 's' : ''} filled from ${source}`, picks && `${picks} value${picks > 1 ? 's' : ''} changed to ${source}'s`].filter(Boolean).join(' · ')
  // what each answer would do, for a song still waiting for one
  const options = rows.length ? `Same song: joins LNV row ${rows.join(' + ')} · New song: a new row`
    : c.lnv.length && !near ? 'Same song: joins the LNV row you tick · New song: a new row' : "Add: a new row · Not the client's: nothing added"
  let first = true   // the song's first recording makes its new row; the others are the same song released again
  return c.muso.map((r, i): Land => {
    if (!isIn(r)) return { i, r, tone: 'off', to: 'Its own song', note: 'kept separate – it is answered on its own' }
    if (d.choice === 'not_ours') return { i, r, tone: 'off', to: 'Not added', note: "not the client's song" }
    if (d.choice === 'deleted') return { i, r, tone: 'off', to: 'Deleted', note: 'nothing of it goes into the LNV' }
    if (r.part === 'version') {
      if (r.lnv_row) return { i, r, tone: 'have', row: r.lnv_row, to: `LNV row ${r.lnv_row}`, note: 'this version is already there – nothing added' }
      return ours ? { i, r, tone: 'new', to: 'New row', note: `a ${r.version ?? 'version'} row naming ${ours} as its original` }
        : { i, r, tone: 'wait', to: 'New row', note: 'once you answer: a row of its own naming the original' }
    }
    if (d.choice === 'same' && rows.length) return { i, r, tone: 'link', row: rows[0], to: `LNV row ${rows.join(' + ')}`, note: changes || 'the row stays as it is' }
    if (d.choice === 'add') {
      if (!first) return { i, r, tone: 'new', again: true, to: 'Same new row', note: 'the same song released again – no row of its own' }
      first = false
      return { i, r, tone: 'new', to: 'New row', note: c.origin ? `names LNV row ${c.origin.row} as its original` : 'a new song in the LNV' }
    }
    return { i, r, tone: 'wait', to: 'Waits for your answer', note: options }
  })
}

/** The merge, before it is saved: each DSP recording of the song, an arrow, and the LNV row it lands on. */
function MergePlan({ lands, source, openVersion, openRow }: { lands: Land[]; source: string; openVersion: (i: number) => void; openRow: (row: number) => void }) {
  const [all, setAll] = useState(false)
  const tally = LAND_ORDER.map((t) => [t, lands.filter((x) => x.tone === t && !x.again).length] as const).filter(([, x]) => x)
  // grouped by where they land: the song's row first, then new rows, the rows the LNV has, what waits, what stays out
  const sorted = [...lands].sort((a, b) => LAND_ORDER.indexOf(a.tone) - LAND_ORDER.indexOf(b.tone) || (a.row ?? 0) - (b.row ?? 0) || a.i - b.i)
  const shown = all ? sorted : sorted.slice(0, 8)
  return (
    <Block n={4} title="Where each recording goes in the LNV" note={tally.map(([t, x]) => `${x} ${LAND_LABEL[t][x > 1 ? 1 : 0]}`).join(' · ')}>
      <table className="rv-plan">
        <thead><tr><th>{source} recording</th><th /><th>In the LNV</th></tr></thead>
        <tbody>{shown.map((x) => (
          <tr key={x.r.id ?? x.i} className={x.tone}>
            <td><button type="button" className="rv-ver-open" onClick={() => openVersion(x.i)}>{value(x.r.fields.Title)}</button>
              <small className="muted"> {[x.i === 0 ? 'Main' : x.r.version, value(x.r.fields.Year).slice(0, 4)].filter(Boolean).join(' · ')}</small></td>
            <td className="rv-plan-arrow"><ArrowRight size={14} /></td>
            <td><span className={`rv-land ${x.tone}`}>{x.row ? <button type="button" onClick={() => openRow(x.row!)} title="See this LNV row">{x.to}</button> : x.to}</span>
              <small className="muted">{x.note}</small></td>
          </tr>
        ))}</tbody>
      </table>
      {lands.length > 8 && !all && <button type="button" className="cs-more" onClick={() => setAll(true)}>Show all {lands.length}</button>}
    </Block>
  )
}

function CaseView({ c, source, done, pos, total, prev, next, possible, answer, last, undoLast, wideBtn, save, picks, savedCount, showSaved, titles, d, p, families, targets, mapped, linked, toast, showUndo }: {
  c: ReviewCase; source: string; done: boolean; pos: number; total: number; prev: () => void; next: () => void
  possible: boolean; answer: (d: Draft | null) => void; last: { c: ReviewCase; text: string } | null; undoLast: () => void; wideBtn: ReactNode
  save: (items: CleanDecisionIn[]) => Promise<boolean>; picks: Record<string, string | string[]>; savedCount: number; showSaved: () => void
  titles: Step1['titles']; targets: Target[]; mapped: (all: boolean, t: { title: string; row?: number }) => void
  /** the step and its song names: what "Map to existing ISRC / song" offers, and the remarks */
  d: Step1; p: Pending; families: Family[]; linked: (t: { row: number; title: string }) => void
  toast: (text: string, tone?: 'good' | 'bad') => void
  showUndo: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(c, picks))
  const [mapSong, setMapSong] = useState(false)   // "Map to existing ISRC / song": the popup is open
  const [opened, setOpened] = useState<number | null>(null)   // the version whose details are open
  const [openedRow, setOpenedRow] = useState<number | null>(null)   // the LNV row whose details are open
  const [mapping, setMapping] = useState<CaseRecord | null>(null)   // the recording being mapped onto an exact match
  const twice = c.kind === 'twice'
  const merging = !!c.merge
  const names = c.names
  const main = c.muso[0]
  // LNV rows the same-song rule turned down: not the same song, so they stay folded away and are linked only by the reviewer
  const near = c.lnv.length > 0 && c.lnv.every((r) => r.check && !r.check.level)
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
  const mapToSong = () => { if (!names && !twice) setMapSong(true) }
  const [deleting, setDeleting] = useState(false)   // "Delete song" waits for a yes
  const del = () => { if (!names && !twice) setDeleting(true) }
  const gone = isDeleted(c), sentNew = isNewRow(c)
  const remarkNow = remarkOf(d, c.muso.filter((r) => r.in))
  const remarkHelp = remarkNow && remarkNow !== 'mixed' ? d.remark_list?.find((r) => r.id === remarkNow.id)?.help : ''
  /** Back where the app had it: its exact or possible match (or Not in the LNV, for a song no LNV row matched). */
  const restore = () => {
    answer(null)
    toast(c.was?.length ? `“${c.title}” is back to its match – LNV row ${c.was.map((r) => r.row).join(', ')} (under Songs)` : `“${c.title}” is back under Not in the LNV`, 'good')
  }
  const mapBack = (row: number) => {
    answer({ ...draft, choice: 'same', rows: [row] })
    toast(`“${c.title}” is mapped back to LNV row ${row} – it is under Songs`, 'good')
  }
  useKeys({ enter: confirm, a: confirm, s: names ? isSame : same, n: add, x: skip, m: mapToSong, d: different, r: apart, delete: del,
    u: () => { if (done) answer(null); else undoLast() }, arrowdown: next, j: next, arrowup: prev, k: prev })

  const toggleIn = (id: number) => setDraft({ ...draft, in: draft.in.includes(id) ? draft.in.filter((x) => x !== id) : [...draft.in, id] })
  const pick = (row: number) => {
    if (twice) { setDraft({ ...draft, rows: [row], choice: 'same' }); return }
    const rows = draft.rows.includes(row) ? draft.rows.filter((x) => x !== row) : [...draft.rows, row]
    setDraft({ ...draft, rows, choice: rows.length ? 'same' : null })
  }
  const adding = draft.choice === 'add' || draft.choice === 'not_ours' || draft.choice === 'deleted'
  const updates = adding ? [] : c.updates.filter((u) => sameRows.includes(u.row))
  const toggleUpdate = (key: string) => setDraft({ ...draft, reject: draft.reject.includes(key) ? draft.reject.filter((k) => k !== key) : [...draft.reject, key] })
  const kept = updates.filter((u) => !draft.reject.includes(u.key)).length
  const inCount = merging ? draft.in.length : c.muso.length
  // where each version lands in the LNV: the original on the song's row, every other version on a row of its own
  const isIn = (r: CaseRecord) => !merging || !!r.moved || draft.in.includes(r.id!)
  const placing = draft.choice === 'same' || draft.choice === 'add'
  const newVersions = placing ? c.muso.filter((r) => isIn(r) && r.part === 'version' && !r.lnv_row).length : 0
  const versionsLine = newVersions ? ` ${newVersions} version${newVersions > 1 ? 's get rows' : ' gets a row'} of ${newVersions > 1 ? 'their' : 'its'} own, naming the original.` : ''

  const outcome = names
    ? draft.choice === 'same' ? `From now on “${names.a}” and “${names.b}” are one person – for every client.`
      : draft.choice === 'different' ? 'They stay two people; the app stops asking.' : 'Are these two spellings one person?'
    : twice
    ? draft.choice === 'different' ? 'Nothing changes – they are two songs.'
      : draft.rows.length ? (c.isrc ? `The ISRC stays on LNV row ${draft.rows[0]} only.` : `LNV row ${draft.rows[0]} is kept; the other row is marked as a repeat, never deleted.`)
        : c.isrc ? 'Tick the LNV row the ISRC belongs to.' : 'Tick the LNV row to keep, or say they are different songs.'
    : draft.choice === 'same' ? `LNV row ${draft.rows.join(' + ')} ${kept ? `gets ${kept} blank detail${kept > 1 ? 's' : ''} filled from ${source}` : 'stays as it is'}.${versionsLine}`
      : draft.choice === 'add' ? (c.origin ? `A new row is added, naming LNV row ${c.origin.row} “${value(c.origin.fields.Title)}” (${value(c.origin.fields['Film / album'])}) as its original.` : 'A new row is added to the LNV.') + versionsLine
        : draft.choice === 'not_ours' ? "Nothing goes into the LNV – not the client's song."
          : draft.choice === 'deleted' ? 'Deleted – nothing of this song goes into the LNV. Put it back to its match, map it to a song, or add it as a new row.'
          : c.origin ? `A new recording of LNV row ${c.origin.row}: add it as a row of its own naming that original, or skip it.`
          : near ? `No LNV row is the same recording or the same work. Tick one only if ${source}'s data is wrong.`
            : c.lnv.length > 1 ? 'Tick the LNV row this song is, or add it as a new song.'
              : c.lnv.length ? `Is this ${source} song LNV row ${c.lnv[0].row}?` : 'Add it to the LNV, or skip it.'

  const lnvCols: Col[] = c.lnv.map((r) => ({
    r, badge: `LNV row ${r.row}`, tone: 'lnv', open: () => setOpenedRow(r.row!),
    pick: single ? undefined : { on: draft.rows.includes(r.row!), radio: twice, change: () => pick(r.row!),
      label: twice ? (c.isrc ? 'Has the ISRC' : 'Keep this row') : near ? 'Link anyway' : 'This is the song' },
  }))
  // the Muso side is the recording the LNV row was compared with (its ISRC, album, credits), not every version pooled
  const via = c.lnv.find((r) => draft.rows.includes(r.row!))?.check?.via ?? c.lnv[0]?.check?.via
  const shownAt = Math.max(0, c.muso.findIndex((r) => via != null && r.sheet_rows?.includes(via)))
  const musoCol: Col[] = twice || !main ? [] : [{ r: c.muso[shownAt], badge: c.muso.length > 1 ? `${source} – ${shownAt ? c.muso[shownAt].version ?? 'version' : 'main version'}` : source, tone: 'muso', open: () => setOpened(shownAt) }]
  // a turned-down row joins the comparison only once the reviewer ticks it
  // a new recording of an LNV work: that row beside it, as the original its new row will name
  const originCol: Col[] = c.origin ? [{ r: c.origin, badge: `Original work · LNV row ${c.origin.row}`, tone: 'lnv', open: () => setOpenedRow(c.origin!.row!) }] : []
  const cols: Col[] = [...musoCol, ...originCol, ...(near ? lnvCols.filter((x) => x.pick?.on) : lnvCols)]
  const closest = near ? lnvCols.filter((x) => !x.pick?.on && x.r.row !== c.origin?.row) : []
  const onSame = draft.choice === 'same' && ready(c, draft)
  // Muso and the chosen LNV rows hold two values: the reviewer says which one goes into the LNV (the LNV's by default)
  const musoRec = musoCol[0]?.r
  const choices = adding || !musoRec || twice ? [] : c.lnv.filter((r) => sameRows.includes(r.row!)).flatMap((r) => PICK_SHOWN
    .filter((f) => differs(f, list(musoRec.fields[f]), list(r.fields[f])))
    .map((f) => ({ key: pickKey(r.row!, f), row: r.row!, f, lnv: list(r.fields[f]), muso: list(musoRec.fields[f]) })))
  const choose = (key: string, v: string[] | null) => {
    const { [key]: _, ...rest } = draft.picks   // eslint-disable-line @typescript-eslint/no-unused-vars
    setDraft({ ...draft, picks: v ? { ...rest, [key]: v.length === 1 ? v[0] : v } : rest })
  }

  // ② the LNV rows, one card each: every candidate; a row the rule turned down only once ticked (or on the Possible tab)
  const lnvShown = near ? (possible ? lnvCols.filter((x) => x.pick?.on || x.r.row !== c.origin?.row) : lnvCols.filter((x) => x.pick?.on)) : lnvCols
  const lnvCount = lnvShown.length + (near && !possible ? closest.length : 0)
  const lnvCard = (x: Col) => <LnvCard key={x.r.row} r={x.r} main={main} badge={x.badge} open={x.open!} tick={x.pick} />
  // where each recording lands with the answer on screen – for ③, ④ and ⑤
  const lands = landsOf(c, draft, sameRows, near, isIn, kept, Object.keys(draft.picks).length, source)
  // every LNV row on this screen, in screen order: the LNV row popup's ← → go through them
  const caseRows = [...new Set([c.origin?.row, ...c.lnv.map((r) => r.row), ...lands.map((x) => x.row), ...(c.in_lnv ?? []).map((v) => v.row)]
    .filter((x): x is number => x != null))]
  // ⑤ the title of each recording that goes into the LNV: the LNV's own where it lands on an LNV row, else the DSP's
  const rowRec = (row?: number | null) => row == null ? undefined
    : c.lnv.find((x) => x.row === row) ?? c.in_lnv?.find((v) => v.row === row)?.lnv ?? (c.origin?.row === row ? c.origin : undefined)
  const lnvTitle = (row: number | null | undefined, label: string) => {
    const t = value(rowRec(row)?.fields.Title)
    return t && row != null ? { title: t, row, label } : undefined
  }
  const titleLines: TitleLine[] = lands.filter((x) => x.tone !== 'off').map((x) => {
    const home = sameRows[0] ?? c.origin?.row
    const lnv = x.tone === 'link' || x.tone === 'have' ? lnvTitle(x.row, `LNV row ${x.row}`)
      : x.i === 0 ? lnvTitle(home, `LNV row ${home}`) : lnvTitle(home, `LNV row ${home} (the original)`)
    // a title taken from the DSP earlier ("which value goes into the LNV") stays the DSP's
    const earlier = x.tone === 'link' && x.row != null && draft.picks[pickKey(x.row, 'Title')] !== undefined
    const def: TitleMode = (x.tone === 'link' || x.tone === 'have') && lnv && !earlier ? 'lnv' : 'muso'
    return { r: x.r, i: x.i, spot: x, lnv, def, saved: titles[String(x.r.id)] }
  })

  return (
    <div className="sm-detail rv-case">
      <div className="sm-detail-top">
        <div className="sm-detail-nav">
          <h3>{c.title}</h3>
          {done && <span className="rv-done-name"><Check size={13} />Done</span>}
          <span className="grow" />
          <button type="button" className="btn sm" onClick={showUndo} title="The changes made to this song – undo any of them"><Undo2 size={14} />Undo</button>
          <span className="muted rv-pos">{n(pos)} of {n(total)}</span>
          <button type="button" className="sm-nav" disabled={pos <= 1} onClick={prev} title="Previous (↑)"><ArrowLeft size={15} /></button>
          <button type="button" className="sm-nav" disabled={pos >= total} onClick={next} title="Next (↓)"><ArrowRight size={15} /></button>
          {wideBtn}
        </div>
        {(c.kind !== 'versions' || c.answer.recheck) && <p className={`rv-why ${c.answer.recheck ? 'warn' : c.tone ?? ''}`}>{c.why}</p>}
      </div>

      <div className="rv-scroll">
        {names ? (
          <div className="rv-names">
            <b>{names.a}</b><span className="rv-names-eq">=?</span><b>{names.b}</b>
            {names.songs.length > 0 && <p className="rv-none">For example: {names.songs.join(' · ')}</p>}
          </div>
        ) : twice ? <Compare cols={cols} /> : <>
          <Guide id="step2" title="How to review a song" steps={[
            <>Pick a song on the left – <b>Show: Needs an answer</b> lists what is still open.</>,
            <>Read it top down: <b>①</b> main version, <b>②</b> LNV rows that may be it, <b>③</b> other {source} versions.</>,
            <>Answer at the bottom – the green button is the app's answer (Enter).</>,
            <>In <b>⑤ Titles</b> pick each recording's LNV title, or map it to an exact match.</>,
            <><b>Saved to the LNV</b> lists every answer and has the download.</>,
          ]} />
          {(gone || sentNew) && (
            <div className={`rv-out ${gone ? 'del' : 'new'}`} role="status">
              <span className="rv-out-icon">{gone ? <Trash2 size={18} /> : <Plus size={18} />}</span>
              <div className="grow">
                <b>{gone ? 'Deleted song' : 'Sent to a new row'}</b>
                <p>{gone ? 'Nothing of it goes into the LNV.' : `It goes into the LNV as a new row${c.muso.length > 1 ? ', its other versions with rows of their own' : ''}.`}
                  {c.was?.length ? <> It was the {c.was.length > 1 ? 'match of LNV rows' : 'match of LNV row'} {c.was.map((r) => r.row).join(', ')} – put it back, or map it to another exact or possible match.</> : null}</p>
              </div>
              <div className="rv-out-btns">
                <button type="button" className="btn sm primary" onClick={restore}><Undo2 size={14} />{c.was?.length ? 'Back to its match' : gone ? 'Restore' : 'Back to Not in the LNV'}</button>
                <button type="button" className="btn sm" onClick={mapToSong}><Link2 size={14} />Map to existing ISRC / song…</button>
                {gone ? <button type="button" className="btn sm" onClick={add}><Plus size={14} />Add as a new row</button>
                  : <button type="button" className="btn sm danger" onClick={del}><Trash2 size={14} />Delete song</button>}
              </div>
            </div>
          )}
          {!!c.was?.length && (gone || sentNew) && (
            <Block n={<Undo2 size={13} />} title={`Its match before (${c.was.length})`} note="The LNV rows the app had matched it to – map it back to one: the same song as that row.">
              <div className="cv-cards">{c.was.map((r) => (
                <div key={r.row} className="rv-was">
                  <LnvCard r={r} main={main} badge={`LNV row ${r.row}`} open={() => setOpenedRow(r.row!)} />
                  <button type="button" className="btn sm primary rv-was-btn" onClick={() => mapBack(r.row!)}><Link2 size={14} />Map back – same song as LNV row {r.row}</button>
                </div>
              ))}</div>
            </Block>
          )}
          {/* why it is mapped: the remark, and the way to the song it belongs to */}
          <section className="rm-box" aria-label="Remark">
            <div className="rm-head"><h4>Remark</h4><p>Why this song is mapped to an exact or possible match. It goes into the LNV’s Remark column, word for word.</p></div>
            <div className="rm-line">
              <RemarkPick d={d} now={remarkOf(d, c.muso.filter(isIn))} pick={(r) => { void save(remarkItems(c.muso.filter(isIn), r)) }} />
              <button type="button" className="btn" onClick={mapToSong}><Link2 size={15} />Map to an exact / possible match…</button>
              <Link className="rm-set" to="/settings">Edit the list in Settings</Link>
            </div>
            {remarkHelp && <small className="rm-help">{remarkHelp}</small>}
          </section>
          <Legend source={source} />
          <Block n={1} title="Main version" note={!main.version || main.version === 'Original'
            ? `${source}'s original – the oldest recording with no remix, lofi or other tag. Everything below is compared with it.`
            : `${source} has no plain recording of this song, so its first version (${main.version}) stands as the main one. Everything below is compared with it.`}>
            <MainCard r={main} source={source} count={c.muso.length} open={() => setOpened(0)} />
          </Block>

          <Block n={2} title={`LNV rows that may be this song${lnvCount ? ` (${lnvCount})` : ''}`}
            note={near ? `No LNV row is the same recording or the same work – these are only the closest. Tick one only if ${source}'s data is wrong.`
              : c.lnv.length > 1 ? 'One after another, each compared with the main version. Tick the row that is this song.'
                : c.lnv.length ? 'Compared with the main version: what differs is marked.' : undefined}>
            {c.origin && <LnvCard r={c.origin} main={main} badge={`Original work · LNV row ${c.origin.row}`} open={() => setOpenedRow(c.origin!.row!)}
              note={<p className="cv-note">{c.origin.sure ? 'The same writers' : 'A shared writer'} – {source} has a new recording of this LNV song. Added, it gets a row of its own naming this row as its original.</p>} />}
            {lnvShown.map(lnvCard)}
            {closest.length > 0 && !possible && (
              <Part id="closest" initial={false} title={`Closest LNV row${closest.length > 1 ? 's' : ''} – not the same song (${closest.length})`}
                note={`no same ISRC or credits; open only if you think ${source}'s data is wrong`}>
                <div className="cv-cards">{closest.map(lnvCard)}</div>
              </Part>
            )}
            {!c.lnv.length && !c.origin && <p className="cv-none">No LNV row shares this song's ISRC or credits – it is not in the LNV.</p>}
          </Block>

          {c.muso.length > 1 && (
            <Block n={3} title={`Other ${source} versions of this song (${c.muso.length - 1})`}
              note={merging ? `Possible matches to the main version – a similar title and the same writers. Untick one that is a different song${inCount < c.muso.length ? ` (${inCount} of ${c.muso.length} counted as this song)` : ''}.`
                : 'Each one is a recording of this song: it gets an LNV row of its own naming the original, unless the LNV has it already.'}>
              <VersionList c={c} spots={lands} merging={merging} isIn={isIn} toggle={toggleIn} open={setOpened} openRow={setOpenedRow} save={save} />
            </Block>
          )}

          <MergePlan lands={lands} source={source} openVersion={setOpened} openRow={setOpenedRow} />
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

        {choices.length > 0 && (
          <section className="rv-fills rv-picks">
            <h4>{source} and the LNV differ – which value goes into the LNV? <small className="muted">(the title is chosen in part 5)</small></h4>
            <table className="rv-versions">
              <thead><tr><th />{sameRows.length > 1 && <th>Row</th>}<th>Keep the LNV's</th><th>Use {source}'s</th></tr></thead>
              <tbody>{choices.map((x) => {
                const muso = x.key in draft.picks
                return (
                  <tr key={x.key}>
                    <td className="muted nowrap">{x.f}</td>
                    {sameRows.length > 1 && <td className="muted">{x.row}</td>}
                    <td><label className={`rv-pick-opt ${muso ? '' : 'on'}`}><input type="radio" name={x.key} checked={!muso} onChange={() => choose(x.key, null)} />{x.lnv.join(', ')}</label></td>
                    <td><label className={`rv-pick-opt ${muso ? 'on' : ''}`}><input type="radio" name={x.key} checked={muso} onChange={() => choose(x.key, x.muso)} />{x.muso.join(', ')}</label></td>
                  </tr>
                )
              })}</tbody>
            </table>
            {Object.keys(draft.picks).length > 0 && <small className="muted">The {source} values replace the LNV's when you save – marked yellow in the final LNV.</small>}
          </section>
        )}

        {draft.choice === 'add' && c.new_row && (
          <Part id="new-row" title="See the new LNV row" initial={false}>
            <Compare cols={[{ r: { fields: c.new_row } as CaseRecord, badge: 'New LNV row', tone: 'add' }]} fields={SHOW.concat(['Length', 'Label'])} base={null} />
          </Part>
        )}

        {!!c.in_lnv?.length && (
          <Part id="in-lnv" title={`${c.in_lnv.length} version${c.in_lnv.length > 1 ? 's' : ''} already in the LNV`} note="Check each: is it the same recording?">
            {c.in_lnv.map((v) => (
              <div key={v.key} className={`rv-inlnv ${v.answer === 'none' ? 'off' : ''}`}>
                <div className="rv-inlnv-head">
                  <b>{v.type}</b>
                  <span className="rvc-marks">{([['isrc', 'ISRC'], ['album', 'album'], ['year', 'year']] as const).map(([k, label]) => (
                    <span key={k} className={v[k] ? 'good' : 'bad'}>{v[k] ? <Check size={12} /> : <X size={12} />}{v[k] ? 'Same' : 'Other'} {label}</span>))}</span>
                  <span className="grow" />
                  {v.answer === 'none' ? <>
                    <span className="muted">Not this version – it gets a new row</span>
                    <button type="button" className="rv-text-btn" onClick={() => save([{ key: v.key, choice: null }])}><Undo2 size={14} />Undo</button>
                  </> : <>
                    {v.answer === 'same' ? <span className="rv-done-name"><Check size={13} />Right</span>
                      : <button type="button" className="rv-text-btn" onClick={() => save([{ key: v.key, choice: 'same', data: { rows: [v.row] } }])}><Check size={14} />Right</button>}
                    <button type="button" className="rv-text-btn" onClick={() => save([{ key: v.key, choice: 'none', data: { rows: [v.row] } }])}><X size={14} />Not this version</button>
                  </>}
                </div>
                <Compare cols={[{ r: v.muso, badge: `${source} – ${v.type}`, tone: 'muso' }, { r: v.lnv, badge: `LNV row ${v.row}`, tone: 'lnv', open: () => setOpenedRow(v.row) }]} />
              </div>
            ))}
          </Part>
        )}


          <Block n={5} title="Titles in the LNV" note={`For each recording: the title it gets in the LNV and where that title comes from. Pick one, type your own, or map the recording to a song the app matched exactly.`}>
            <TitleSection lines={titleLines} titles={titles} source={source} save={save} map={setMapping}
              closed={draft.choice === 'not_ours' ? "Not the client's song – no title goes into the LNV." : draft.choice === 'deleted' ? 'Deleted – no title goes into the LNV.' : undefined} />
          </Block>
        </>}
      </div>

      {mapping && <MapDialog c={c} rec={mapping} recs={c.muso.filter(isIn)} targets={targets} source={source} save={save}
        close={() => setMapping(null)} done={mapped} />}
      {mapSong && main && <MapTo c={c} recs={c.muso.filter(isIn)} families={families} d={d} p={p} save={save} close={() => setMapSong(false)} done={mapped}
        same={(row, title) => { linked({ row, title }); answer({ ...draft, choice: 'same', rows: [row] }) }} />}

      {opened !== null && c.muso[opened] && <VersionDetails r={c.muso[opened]} main={main} at={opened} total={c.muso.length} source={source} go={setOpened} close={() => setOpened(null)} />}

      {openedRow !== null && <LnvRowDetails row={openedRow} rows={[...caseRows, ...(c.was ?? []).map((r) => r.row!)]} go={setOpenedRow} close={() => setOpenedRow(null)} />}
      <ConfirmDialog open={deleting} title={`Delete “${c.title}”?`} confirmLabel="Delete" onCancel={() => setDeleting(false)}
        onConfirm={() => { setDeleting(false); act('deleted'); toast(`“${c.title}” deleted – under “Deleted songs” now, from where it maps back`, 'good') }}>
        <p>Nothing of this song – {c.muso.length} {source} recording{c.muso.length === 1 ? '' : 's'} – goes into the LNV: no link, no new row. It is listed under <b>Deleted songs</b>, from where you can put it back to its exact or possible match.</p>
      </ConfirmDialog>

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
              <Act k="M" onClick={mapToSong}>Map to existing ISRC / song…</Act>
              <Act on={draft.choice === 'deleted'} k="Del" onClick={del}>Delete song</Act>
              {merging && <button type="button" className="rv-text-btn" onClick={apart}>Keep separate<Kbd>R</Kbd></button>}
            </>
          )}
          {done && <button type="button" className="rv-text-btn" onClick={() => answer(null)}><Undo2 size={14} />{gone ? 'Restore' : 'Undo'}<Kbd>U</Kbd></button>}
          {!done && last && last.c.id !== c.id && <button type="button" className="rv-text-btn rv-last" onClick={undoLast} title="Take this answer back"><Undo2 size={14} /><span>Saved {last.c.title}: {last.text}</span><b>Undo</b><Kbd>U</Kbd></button>}
          {savedCount > 0 && <button type="button" className="rv-text-btn" onClick={showSaved} title="Every answer you saved and what it puts into the LNV"><Check size={14} />Saved {n(savedCount)}</button>}
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

/** Everything saved, newest first, and what each answer puts into the LNV sheet – grouped by what it does. Saved
 *  means answered: by the reviewer, or the app's own answer that goes into the LNV as it is. Each line opens its song,
 *  and the reviewer's own answers can be taken back here. */
function SavedView({ saved, d, open, undo, flush }: {
  saved: { c: ReviewCase; draft: Draft; at: number; you: boolean }[]; d: Step1; open: (c: ReviewCase) => void; undo: (c: ReviewCase) => void
  /** save what still waits in the queue – before the download, so the file has every answer */
  flush: () => Promise<boolean>
}) {
  const { clientId } = useClient()
  const [limit, setLimit] = useState(200)
  const [who, setWho] = useState<'all' | 'you' | 'app'>('all')
  const [what, setWhat] = useState<string>('all')
  const [q, setQ] = useState('')
  const GROUPS = [
    ['linked', 'Linked to an LNV row', (x: Draft, c: ReviewCase) => x.choice === 'same' && c.kind !== 'twice'],
    ['added', 'Added as new LNV rows', (x: Draft) => x.choice === 'add'],
    ['skipped', "Not the client's – nothing added", (x: Draft) => x.choice === 'not_ours'],
    ['deleted', 'Deleted songs – nothing goes into the LNV', (x: Draft) => x.choice === 'deleted'],
    ['other', 'Names and LNV duplicates', (_: Draft, c: ReviewCase) => c.kind === 'names' || c.kind === 'twice'],
  ] as const
  const s = norm(q)
  const mine = saved.filter((x) => (who === 'all' || (who === 'you') === x.you) && (!s || norm(x.c.title).includes(s)))
  const groups = GROUPS.map(([id, title, test]) => [id, title, mine.filter((x) => test(x.draft, x.c))] as const)
  const k = d.counts
  const yours = saved.filter((x) => x.you).length
  let shown = 0
  return (
    <div className="rv-saved">
      <div className="rv-saved-top">
        <div className="rv-saved-sum">
          <span><b>{n(k.in_lnv)}</b>songs linked to their LNV row</span>
          <span><b>{n(k.adding)}</b>new songs added</span>
          <span><b>{n(k.versions_new)}</b>new rows for other recordings</span>
          <span><b>{n(k.fills)}</b>blanks filled from {d.source}</span>
          <span><b>{n(k.picks ?? 0)}</b>values changed – {d.source}'s or typed</span>
          <span className="grow" />
          <Stage1Download clientId={clientId} before={flush} primary label="Download the LNV with these changes" />
        </div>
        <div className="rv-saved-tools">
          <div className="rv-tabs">
            {([['all', 'All saved', saved.length], ['you', 'Saved by you', yours], ['app', "The app's answers", saved.length - yours]] as const).map(([id, label, x]) => (
              <button key={id} type="button" className={who === id ? 'on' : ''} onClick={() => setWho(id)}>{label}<span>{n(x)}</span></button>
            ))}
          </div>
          <Dropdown className="rv-dd boxed" label="What the answer does" value={what} onChange={setWhat} menuWidth={280}
            options={[{ value: 'all', label: 'Every answer', hint: `${n(mine.length)} saved` }, ...groups.map(([id, title, items]) => ({ value: id as string, label: title, hint: `${n(items.length)} saved` }))]} />
          <label className="cs-search sm-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a saved song…" /></label>
        </div>
      </div>
      <div className="rv-saved-body">
        {!mine.length && <p className="sm-list-none">{saved.length ? 'Nothing saved matches.' : 'Nothing saved yet. Every answer – Same song, New song, Not the client’s – shows up here at once.'}</p>}
        {groups.filter(([id, , items]) => items.length && (what === 'all' || what === id)).map(([id, title, items]) => (
          <section key={id} className="rv-saved-group">
            <h4>{title} <span className="muted">{n(items.length)}</span></h4>
            <table className="rv-versions">
              <thead><tr><th>Song</th><th>Answered by</th><th>What goes into the LNV</th><th /></tr></thead>
              <tbody>{items.map(({ c, draft, at, you }) => {
                if (shown++ >= limit) return null
                return (
                  <tr key={keyOf(c)} className={at ? 'rv-saved-new' : ''}>
                    <td><button type="button" className="rv-ver-open" onClick={() => open(c)}><b>{c.title}</b></button></td>
                    <td className="nowrap"><span className={`rv-by ${you ? 'you' : ''}`}>{you ? 'You' : 'App'}</span>{at > 0 && <small className="muted"> just now</small>}</td>
                    <td>{effect(c, draft, d.source)}</td>
                    <td className="nowrap">
                      <button type="button" className="rv-text-btn" onClick={() => open(c)}>Open</button>
                      {you && <button type="button" className="rv-text-btn" onClick={() => undo(c)}><Undo2 size={14} />Undo</button>}
                    </td>
                  </tr>
                )
              })}</tbody>
            </table>
          </section>
        ))}
        {shown > limit && <button type="button" className="cs-more" onClick={() => setLimit(limit + 400)}>Show more ({n(shown - limit)} left)</button>}
      </div>
    </div>
  )
}
