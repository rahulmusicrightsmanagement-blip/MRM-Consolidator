import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpDown, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Link2, Pencil, Plus, Trash2, Undo2, X } from 'lucide-react'
import { ConfirmDialog, Dropdown, Guide } from '../../components/ui'
import type { DropOption } from '../../components/ui'
import type { CleanDecisionIn } from '../../lib/api'
import type { CaseRecord, RemarkChoice, ReviewCase, Step1, TitleMode, TypedSong } from '../../types'
import { list, n, norm } from './Block'
import { Checks, Links, LnvRowDetails, MapDialog, Part, VersionDetails, differs, hasLink, useKeys, useStored, value } from './CaseParts'
import type { Target } from './CaseParts'
import { NAME_FIELDS, PICKABLE, PICK_SHOWN, draftOf, itemsOf, matchOf, pickItem, pickKey, shownOf } from './reviewModel'
import { AddSong } from './AddSong'
import { fieldChoices, ipiOf, keepText } from './fieldModel'
import { RemarkPick } from './MapTo'
import { remarkItems, remarkKey, remarkOf } from './remarkModel'
import { titleModel } from './titles'
import type { Line } from './titles'
import type { Choices, Keep } from './fieldModel'

/** Step 2 by song name: every song one name holds – its original, remixes, lofis, parts – on one screen. On top
 *  the main version (the client's oldest recording with no tag); under it the exact matches side by side (scrolled
 *  across, the main version stays), then the possible matches one below another. A match is ticked when it is right,
 *  its differing values chosen ({source}'s or the LNV's), its title picked – or it is sent out: a new row, or mapped
 *  onto another song. Ticks, values and titles wait in a queue that saves itself a moment later. */

type InLnv = NonNullable<ReviewCase['in_lnv']>[number]

/** One recording beside one LNV row: the song's own row (a case), or a version the LNV already has (v). */
export type Entry = {
  key: string; c: ReviewCase; rec: CaseRecord; row: number; lnv: CaseRecord; match: 'exact' | 'possible'; v?: InLnv
  /** the recording whose title goes on the row: the song's original on its own row, the version on a version's row */
  tr: CaseRecord
}
/** One card (an exact column, a possible card): one LNV row – or LNV rows holding the very same data – with every
 *  recording matched to it. Muso often lists one recording several times (the same ISRC, other spellings or credits):
 *  they share one card, their differing values offered side by side. */
export type Group = {
  key: string; rows: number[]; entries: Entry[]; lnv: CaseRecord; match: 'exact' | 'possible'
  /** the recordings matched to it, each once */
  recs: CaseRecord[]
  /** the recordings whose titles go on its rows */
  trs: CaseRecord[]
}
export type Family = {
  id: string; title: string; cases: ReviewCase[]; main: CaseRecord
  exact: Group[]; possible: Group[]
  /** recordings beside no LNV row: each gets a row of its own once its song is answered */
  rest: { c: ReviewCase; r: CaseRecord }[]
  /** every recording of the family, the main version first (the version popup's ← →) */
  recs: CaseRecord[]
  /** songs the reviewer typed and added to it: each a new LNV row, checked as it is */
  typed: TypedSong[]
}

const PLAIN = new Set(['Original', 'Re-release'])
const yearOf = (r: CaseRecord) => value(r.fields.Year) || '9999'
const FIELDS = ['Title', 'Film / album', 'Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC', 'Year']

/** Out of the LNV match: the reviewer gave it a new row (New row), it is not the client's (Not in the LNV), or the
 *  reviewer deleted it (Deleted songs). */
export const outOfMatch = (c: ReviewCase) => c.answer.choice === 'not_ours' || c.answer.choice === 'deleted' || (c.answer.choice === 'add' && c.answer.by === 'you')
export const inFamilies = (c: ReviewCase) => c.kind !== 'names' && c.kind !== 'twice' && !outOfMatch(c) && ['exact', 'possible'].includes(matchOf(c))

function entriesOf(c: ReviewCase): Entry[] {
  const out: Entry[] = []
  // the rows the reviewer linked; else every row the app found a match in (or proposes)
  const mine = c.answer.choice === 'same' && c.answer.by === 'you' ? [...(c.answer.rows ?? []), ...(c.answer.also ?? [])] : null
  const orig = c.muso.find((r) => r.part === 'original') ?? c.muso[0]
  for (const l of c.lnv) {
    if (l.row == null) continue
    if (!(mine ? mine.includes(l.row) : !!l.check?.level || (c.answer.rows ?? []).includes(l.row))) continue
    const via = l.check?.via
    const rec = c.muso.find((r) => via != null && r.sheet_rows?.includes(via)) ?? orig
    out.push({ key: `${c.id}:${l.row}`, c, rec, tr: orig, row: l.row, lnv: l, match: l.check?.level === 'exact' ? 'exact' : 'possible' })
  }
  for (const v of c.in_lnv ?? []) {
    if (v.answer === 'none' || out.some((e) => e.row === v.row)) continue
    out.push({ key: v.key, c, rec: v.muso, tr: v.muso, row: v.row, lnv: v.lnv, v, match: v.isrc && v.album ? 'exact' : 'possible' })
  }
  return out
}

const uniq = (rs: CaseRecord[]) => rs.filter((r, i) => rs.findIndex((x) => x.id === r.id) === i)
/** A field's values across recordings, each one once – 'Deep House Mix' and '(Deep House Mix)', or the same writers in
 *  another order, are one value. */
export const variants = (f: string, rs: CaseRecord[]) => {
  const vs = rs.map((r) => list(r.fields[f])).filter((v) => v.length)
  return vs.filter((v, i) => vs.findIndex((x) => !differs(f, x, v)) === i)
}
const sig = (rs: CaseRecord[]) => FIELDS.map((f) => variants(f, rs).map((v) => f === 'Year' ? v[0].slice(0, 4) : v.map(norm).sort().join(',')).sort().join('/')).join('|')

/** The cards of one section: the entries of each LNV row together, then rows whose data and recordings are the very
 *  same joined ("LNV rows 468, 475"). */
function groupsOf(entries: Entry[]): Group[] {
  const byRow = new Map<number, Entry[]>()
  entries.forEach((e) => byRow.set(e.row, [...(byRow.get(e.row) ?? []), e]))
  const out: (Group & { sig: string })[] = []
  for (const [row, es] of byRow) {
    const recs = uniq(es.map((e) => e.rec))
    const s = `${sig([es[0].lnv])}#${sig(recs)}`
    const twin = out.find((g) => g.sig === s)
    if (twin) {
      twin.rows.push(row); twin.entries.push(...es)
      twin.recs = uniq([...twin.recs, ...recs]); twin.trs = uniq([...twin.trs, ...es.map((e) => e.tr)])
    } else out.push({ key: `${es[0].match}:${row}`, sig: s, rows: [row], entries: es, lnv: es[0].lnv, match: es[0].match, recs, trs: uniq(es.map((e) => e.tr)) })
  }
  return out.map(({ sig: _, ...g }) => ({ ...g, rows: [...g.rows].sort((a, b) => a - b) }))   // eslint-disable-line @typescript-eslint/no-unused-vars
}

/** How plain a recording is, for the main version: 0 – no tag at all, not even in its title ('Maula Mere Maula',
 *  'Maula Mere Maula (From "Anwar")'), 1 – no version tag ('Maula Mere Maula, Pt. 1', '- Stutter'), 2 – a version. */
const plainness = (r: CaseRecord) => {
  if (r.version && !PLAIN.has(r.version)) return 2
  const bare = value(r.fields.Title).replace(/\s*[([](from|original)\b[^)\]]*[)\]]/gi, '').trim()
  return /\s[-–—|:]\s|[([,/]/.test(bare) ? 1 : 0
}
const tagged = (c: ReviewCase) => c.muso.filter((r) => r.in).every((r) => !!r.version && !PLAIN.has(r.version))

/** The songs of the LNV match grouped by song name, each with its main version, exact and possible matches. */
export function familiesOf(cases: ReviewCase[], typed: TypedSong[] = []): Family[] {
  // a song the reviewer added to another never makes or unmakes a name, nor becomes its main version
  const own = (cs: ReviewCase[]) => { const x = cs.filter((c) => !c.joined); return x.length ? x : cs }
  const by = new Map<string, ReviewCase[]>()
  cases.filter(inFamilies).forEach((c) => { const k = c.family || c.id; by.set(k, [...(by.get(k) ?? []), c]) })
  // a name that only versions carry joins the shorter name it starts with: 'Maula Mere Maula Electronic Lab - Jhankar
  // Beats' is a Jhankar version of 'Maula Mere Maula' (a longer name with a plain recording stays a song of its own)
  const keys = [...by.keys()].filter((k) => !k.includes(':')).sort((a, b) => a.length - b.length)
  for (const k of [...keys].reverse()) {
    const base = [...keys].reverse().find((x) => x.length >= 8 && x.length < k.length && k.startsWith(x) && by.has(x))   // the closest name
    if (base && own(by.get(k)!).every(tagged)) { by.set(base, [...by.get(base)!, ...by.get(k)!]); by.delete(k) }
  }
  return [...by].map(([k, cs]) => {
    const all = cs.flatMap((c) => c.muso.filter((r) => r.in))
    const mains = own(cs).flatMap((c) => c.muso.filter((r) => r.in))
    const main = [...mains].sort((a, b) => plainness(a) - plainness(b) || yearOf(a).localeCompare(yearOf(b)))[0] ?? cs[0].muso[0]
    const names = new Set(cs.map((c) => c.family).filter(Boolean))
    const entries = cs.flatMap(entriesOf)
    const used = new Set(entries.flatMap((e) => [e.rec.id, e.tr.id]))
    return {
      id: `f:${k}`, title: value(main?.fields.Title) || cs[0].title, cases: cs, main,
      recs: [main, ...all.filter((r) => r !== main)],
      // both in LNV row order, the lowest row first
      exact: groupsOf(entries.filter((e) => e.match === 'exact')).sort((a, b) => a.rows[0] - b.rows[0]),
      possible: groupsOf(entries.filter((e) => e.match === 'possible')).sort((a, b) => a.rows[0] - b.rows[0]),
      rest: cs.flatMap((c) => c.muso.filter((r) => r.in && !used.has(r.id)).map((r) => ({ c, r }))),
      typed: typed.filter((t) => t.family && names.has(t.family)),
    }
  })
}

/* ---------- the queue: changes not saved yet ---------- */

/** What the reviewer changed on the song screens and the queue has not saved yet. link: a song's LNV rows (null – the
 *  answer taken back) · picks: "pick:<row>:<field>" -> the DSP value (null – the LNV's) · titles: recording id ->
 *  title (null – as is) · vers: a version the LNV has, checked ("same") or not (null). */
export type Pending = {
  link: Record<string, number[] | null>; picks: Record<string, string | string[] | null>
  titles: Record<string, { mode: TitleMode; value: string } | null>; vers: Record<string, 'same' | null>
}
export const NO_PENDING: Pending = { link: {}, picks: {}, titles: {}, vers: {} }
export const pendingCount = (p: Pending) => Object.keys(p.link).length + Object.keys(p.picks).length + Object.keys(p.titles).length + Object.keys(p.vers).length

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** A change into the queue – or out of it, when it brings back what is saved. */
function put<T>(m: Record<string, T>, k: string, v: T, saved: T): Record<string, T> {
  const rest = { ...m }
  delete rest[k]
  return same(v, saved) ? rest : { ...rest, [k]: v }
}
/** Drop from the queue what a save took, unless it changed again meanwhile. */
export function stripSaved(p: Pending, done: Pending): Pending {
  const strip = <T,>(m: Record<string, T>, d: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k, v]) => !(k in d) || !same(v, d[k])))
  return { link: strip(p.link, done.link), picks: strip(p.picks, done.picks), titles: strip(p.titles, done.titles), vers: strip(p.vers, done.vers) }
}

/** The LNV rows a song is linked to as saved: by the reviewer, or by the app when it linked the song by itself. */
const savedLinks = (c: ReviewCase) => (c.done || c.auto) && c.answer.choice === 'same' ? [...(c.answer.rows ?? [])].sort((a, b) => a - b) : []
const linksIn = (p: Pending, c: ReviewCase) => c.id in p.link ? p.link[c.id] ?? [] : savedLinks(c)
const savedVer = (v: InLnv) => v.answer === 'same' ? 'same' as const : null
export const ticked = (p: Pending, e: Entry) => e.v ? (e.v.key in p.vers ? p.vers[e.v.key] : savedVer(e.v)) === 'same' : linksIn(p, e.c).includes(e.row)
/** Linked by the app by itself: sent out with "Not a match", never unticked. */
const locked = (e: Entry) => !e.v && !!e.c.auto && savedLinks(e.c).includes(e.row)
/** A card is ticked when every recording on it is; locked when the app linked them all by itself. */
export const gTicked = (p: Pending, g: Group) => g.entries.every((e) => ticked(p, e))
const gLocked = (g: Group) => g.entries.every(locked)
export const toCheck = (p: Pending, f: Family) => [...f.exact, ...f.possible].filter((g) => !gTicked(p, g)).length
/** A song name's checked matches – with the songs the reviewer typed into it. */
export const checkedIn = (p: Pending, f: Family) => [...f.exact, ...f.possible].filter((g) => gTicked(p, g)).length + f.typed.length
/** The LNV rows of a song on screen as its own (not its versions'): linking one leaves the others to check. */
const ownRows = (c: ReviewCase) => entriesOf(c).filter((e) => !e.v).map((e) => e.row)
/** A song name's exact and possible matches not ticked yet. */
export const openOf = (p: Pending, f: Family) => ({ exact: f.exact.filter((g) => !gTicked(p, g)).length, possible: f.possible.filter((g) => !gTicked(p, g)).length })

function tick(p: Pending, e: Entry, on: boolean, saved: Step1['picks']): Pending {
  if (e.v) return { ...p, vers: put(p.vers, e.v.key, on ? 'same' : null, savedVer(e.v)) }
  const now = linksIn(p, e.c)
  const rows = (on ? [...new Set([...now, e.row])] : now.filter((r) => r !== e.row)).sort((a, b) => a - b)
  const was = savedLinks(e.c)
  let next: Pending = { ...p, link: put(p.link, e.c.id, rows.length ? rows : null, was.length ? was : null) }
  // an unticked row takes no values from the DSP
  if (!on) PICKABLE.forEach((f) => { const k = pickKey(e.row, f); next = { ...next, picks: put(next.picks, k, null, saved[k] ?? null) } })
  return next
}

export function tickGroup(p: Pending, g: Group, on: boolean, saved: Step1['picks']): Pending {
  return g.entries.filter((e) => !locked(e) && ticked(p, e) !== on).reduce((acc, e) => tick(acc, e, on, saved), p)
}

/** The decisions the queue saves. A song whose rows or values changed is answered whole (itemsOf: its merge, link, the
 *  blanks it fills, the values taken from the DSP); a version the LNV has, a value on a row no song here owns and each
 *  title on their own. */
export function pendingItems(p: Pending, d: Step1): CleanDecisionIn[] {
  const out: CleanDecisionIn[] = []
  const picks: Record<string, string | string[]> = { ...d.picks }
  Object.entries(p.picks).forEach(([k, v]) => { if (v == null) delete picks[k]; else picks[k] = v })
  const pickRows = new Set(Object.keys(p.picks).map((k) => Number(k.split(':')[1])))
  const handled = new Set<string>()
  for (const c of d.cases) {
    if (c.kind === 'names' || c.kind === 'twice') continue
    const rows = linksIn(p, c)
    if (!(c.id in p.link) && !c.lnv.some((r) => rows.includes(r.row!) && pickRows.has(r.row!))) continue
    c.lnv.forEach((r) => PICKABLE.forEach((f) => handled.add(pickKey(r.row!, f))))
    out.push(...(rows.length ? itemsOf(c, { ...draftOf(c, picks), choice: 'same', rows, also: ownRows(c) }) : itemsOf(c, null)))
  }
  // a value on a row no song here owns (a version the LNV has): the DSP's when one of its recordings holds it, else typed
  const recsOf = (row: number) => d.cases.flatMap((c) => [...(c.lnv.some((r) => r.row === row) ? c.muso : []), ...(c.in_lnv ?? []).filter((v) => v.row === row).map((v) => v.muso)])
  const lnvOf = (row: number) => d.cases.flatMap((c) => [...c.lnv, ...(c.in_lnv ?? []).map((v) => v.lnv)]).find((r) => r.row === row)
  Object.entries(p.picks).forEach(([k, v]) => { if (!handled.has(k)) out.push(v == null ? { key: k, choice: null } : pickItem(k, v, recsOf(Number(k.split(':')[1])), lnvOf(Number(k.split(':')[1])))) })
  const vers = new Map(d.cases.flatMap((c) => c.in_lnv ?? []).map((v) => [v.key, v.row]))
  Object.entries(p.vers).forEach(([k, v]) => out.push(v ? { key: k, choice: 'same', data: { rows: vers.has(k) ? [vers.get(k)!] : [] } } : { key: k, choice: null }))
  Object.entries(p.titles).forEach(([id, t]) => out.push(t ? { key: `title:${id}`, choice: t.mode, data: { value: t.value } } : { key: `title:${id}`, choice: null }))
  return out
}

/** The save state at the top of the step: what waits in the queue, and the button that saves it at once. */
export function SaveBar({ count, busy, flush }: { count: number; busy: boolean; flush: () => void }) {
  return (
    <div className={`sv ${count ? 'wait' : busy ? 'busy' : 'ok'}`} aria-live="polite">
      {busy ? <><span className="spinner small-dark" />Saving…</>
        : count ? <><span className="sv-dot" />
          <button type="button" className="btn sm primary" onClick={flush} title={`${n(count)} change${count > 1 ? 's' : ''} not saved yet – they save by themselves in a moment, or now with this button`}>Save {n(count)} change{count > 1 ? 's' : ''}</button></>
          : <><Check size={15} />All saved</>}
    </div>
  )
}

/* ---------- one family on screen ---------- */

export function FamilyView({ f, d, p, set, pos, total, prev, next, wideBtn, targets, commit, toast, families, loose, act, showUndo }: {
  f: Family; d: Step1; p: Pending; set: (fn: (p: Pending) => Pending) => void
  pos: number; total: number; prev: () => void; next: () => void; wideBtn: ReactNode
  targets: Target[]
  /** save the queue now, with these decisions after it */
  commit: (items: CleanDecisionIn[]) => Promise<boolean>
  toast: (text: string, tone?: 'good' | 'bad') => void
  /** the other song names and the songs not in the LNV: what "Add a song" offers */
  families: Family[]; loose: ReviewCase[]
  /** a save of another kind, then the step again */
  act: (work: () => Promise<unknown>) => Promise<boolean>
  showUndo: (song: string) => void
}) {
  const source = d.source
  const [opened, setOpened] = useState<number | null>(null)   // the recording whose details are open (index in f.recs)
  const [openedRow, setOpenedRow] = useState<number | null>(null)
  const [mapping, setMapping] = useState<{ c: ReviewCase; rec: CaseRecord; recs: CaseRecord[] } | null>(null)
  const [asking, setAsking] = useState<string | null>(null)   // the entry whose "Not a match" choices are open
  const [busy, setBusy] = useState(false)
  const [mainOpen, setMainOpen] = useStored('mrm-main-open', true)   // the main version's details, folded to one line
  const [deleting, setDeleting] = useState<ReviewCase[] | null>(null)   // "Delete" waits for a yes
  const [adding, setAdding] = useState<{ edit?: TypedSong } | null>(null)   // "Add a song" is open
  const [axis, setAxis] = useAxis()   // the possible matches: two tables scrolled across (X, the default) or cards one below another (Y)
  const across = useAcross(f.id)   // the exact matches scrolled across: drag, ← →, the arrow buttons
  const acrossM = useAcross(`${f.id}:m:${axis}`, '.fx-col', axis === 'x')   // the possible matches' Muso versions
  const acrossL = useAcross(`${f.id}:l:${axis}`, '.fx-col', axis === 'x')   // the possible matches' LNV rows
  useKeys({ arrowdown: next, j: next, arrowup: prev, k: prev })

  const cards = [...f.exact, ...f.possible]
  const entries = cards.flatMap((g) => g.entries)
  const rows = [...new Set(cards.flatMap((g) => g.rows))].sort((a, b) => a - b)   // the LNV row popup's ← →, in row order
  const openRec = (r: CaseRecord) => { const i = f.recs.findIndex((x) => x.id === r.id); if (i >= 0) setOpened(i) }
  const main = f.main
  const plainMain = plainness(main) < 2
  const rowsLabel = (g: Group) => `LNV row${g.rows.length > 1 ? 's' : ''} ${g.rows.join(', ')}`

  // ---- titles: one line per recording that goes into the LNV
  const { lines, mainLine, modeOf, finalOf } = titleModel(f, d, p)
  /** One title for every recording on a card: its rows get the same title. */
  const chooseTitle = (ls: Line[], mode: TitleMode, text?: string) => set((q) => {
    const saved = (id: number) => d.titles?.[String(id)] ?? null
    let titles = q.titles
    ls.forEach((l) => {
      const v = finalOf(l, mode, text)
      titles = put(titles, String(l.id), mode === l.def && mode !== 'custom' ? null : { mode, value: v }, saved(l.id))
      // a new main title goes to every recording that follows the main version
      if (l.id === mainLine.id) lines.forEach((x) => { if (x.id !== l.id && modeOf(x) === 'main') titles = put(titles, String(x.id), { mode: 'main', value: v }, saved(x.id)) })
    })
    return { ...q, titles }
  })
  const titlePick = (ids: (number | undefined)[], map: () => void) => {
    const ls = ids.flatMap((id) => (id != null && lines.get(id)) || [])
    const l = ls[0]
    if (!l) return null
    return <TitlePick key={`${l.id}-${modeOf(l)}`} line={l} mode={modeOf(l)} final={finalOf(l)} isMain={ls.some((x) => x.id === mainLine.id)}
      mainTitle={finalOf(mainLine)} source={source} choose={(m, t) => chooseTitle(ls, m, t)} map={map} />
  }

  const titleFinal = (g: Group) => { const l = g.trs.flatMap((r) => (r.id != null && lines.get(r.id)) || [])[0]; return l ? finalOf(l) : value(g.lnv.fields.Title) }

  // ---- values: where Muso and the LNV row differ, the one the LNV keeps – on every row of the card
  const pickOf = (k: string) => (k in p.picks ? p.picks[k] ?? undefined : d.picks[k])
  const choosePick = (g: Group, fl: string, v: string[] | null) => set((q) => {
    let out: Pending = q
    g.rows.forEach((row) => { const k = pickKey(row, fl); out = { ...out, picks: put(out.picks, k, v ? (v.length === 1 ? v[0] : v) : null, d.picks[k] ?? null) } })
    if (v && !gTicked(out, g)) out = tickGroup(out, g, true, d.picks)   // a value kept from it: it is the same song
    return out
  })

  // ---- not a match: a row of its own, or onto another song – saved at once, with the queue
  const mapCard = (g: Group) => setMapping({ c: g.entries[0].c, rec: g.recs[0], recs: g.entries.some((e) => !e.v) && g.entries.length === 1 ? g.entries[0].c.muso.filter((r) => r.in) : g.recs })
  const newRow = async (g: Group) => {
    setBusy(true)
    const items: CleanDecisionIn[] = []
    const songs = new Set<string>()
    g.entries.forEach((e) => {
      if (e.v) {
        items.push({ key: e.v.key, choice: 'none', data: { rows: [e.v.row] } },
          ...Object.keys(d.picks).filter((k) => k.startsWith(`pick:${e.row}:`)).map((k) => ({ key: k, choice: null })))
      } else if (!songs.has(e.c.id)) {
        songs.add(e.c.id)
        // every LNV row it was matched to is turned down: the app does not ask again
        items.push(...itemsOf(e.c, { ...draftOf(e.c), choice: 'add', rows: [] })
          .map((x) => x.key === `link:${e.c.answer.song}` ? { ...x, data: { rows: e.c.lnv.map((r) => r.row!).filter((r) => r != null) } } : x))
      }
    })
    const ok = await commit(items)
    setBusy(false)
    setAsking(null)
    if (ok) toast(songs.size ? `“${g.entries[0].c.title}” is added as a new row – it is under “New row” now` : `“${value(g.recs[0].fields.Title)}” gets a row of its own in the LNV`, 'good')
  }
  /** A song with other LNV rows on screen: one row can be turned down by itself, the song stays. */
  const onlyRow = (g: Group) => g.entries.every((e) => !e.v && e.c.answer.song && entries.some((x) => !x.v && x.c.id === e.c.id && !g.rows.includes(x.row)))
  const notRow = async (g: Group) => {
    setBusy(true)
    const cs = songsOf(g)
    const ok = await commit(cs.flatMap((c) => {
      const left = savedLinks(c).filter((r) => !g.rows.includes(r)), also = ownRows(c).filter((r) => !g.rows.includes(r))
      return [{ key: `off:${c.answer.song}`, choice: 'rows' as const, data: { rows: [...new Set([...(c.off ?? []), ...g.rows])].sort((a, b) => a - b) } },
        ...(left.length === savedLinks(c).length ? [] : left.length ? itemsOf(c, { ...draftOf(c, d.picks), choice: 'same', rows: left, also }) : itemsOf(c, null))]
    }))
    setBusy(false)
    setAsking(null)
    if (ok) toast(`${rowsLabel(g)} ${g.rows.length > 1 ? 'are' : 'is'} not “${cs[0].title}” – its other rows stay`, 'good')
  }
  const hasRemark = (recs: CaseRecord[]) => recs.some((r) => d.remarks?.[remarkKey(r)])
  const setRemark = async (recs: CaseRecord[], r: RemarkChoice | null) => { setBusy(true); await commit(remarkItems(recs, r)); setBusy(false) }
  /** Take an added song out again: back under its own name. */
  const takeOut = async (c: ReviewCase) => {
    setBusy(true)
    const ok = await commit([{ key: `family:${c.answer.song}`, choice: null }])
    setBusy(false)
    if (ok) toast(`“${c.title}” is back under its own name`, 'good')
  }
  const joinedOf = (g: Group) => songsOf(g).filter((c) => c.joined).map((c) => (
    <span key={c.id} className="as-joined"><Plus size={12} />Added from “{c.joined!.from}”<button type="button" className="rv-text-btn" disabled={busy} onClick={() => void takeOut(c)}>Take out</button></span>))
  /** Delete songs: nothing of them goes into the LNV – listed under "Deleted songs", from where they map back. */
  const del = async (cs: ReviewCase[]) => {
    setBusy(true)
    const ok = await commit(cs.flatMap((c) => itemsOf(c, { ...draftOf(c), choice: 'deleted', rows: [] })))
    setBusy(false)
    setAsking(null)
    setDeleting(null)
    if (ok) toast(`“${cs[0].title}”${cs.length > 1 ? ` and ${cs.length - 1} more song${cs.length > 2 ? 's' : ''}` : ''} deleted – under “Deleted songs” now, from where it maps back`, 'good')
  }
  const songsOf = (g: Group) => g.entries.map((e) => e.c).filter((c, i, cs) => cs.findIndex((x) => x.id === c.id) === i)
  const tickAll = (gs: Group[]) => set((q) => gs.reduce((acc, g) => tickGroup(acc, g, true, d.picks), q))

  const hintOf = (g: Group) => {
    const e = g.entries[0]
    const part = g.entries.length > 1 ? g.entries.filter((x) => ticked(p, x)).length : 0
    const of = part && part < g.entries.length ? ` · ${part} of ${g.entries.length} recordings ticked` : ''
    if (gLocked(g)) return 'Linked by the app'
    if (e.v) return (e.v.answer === 'same' ? 'Checked by you' : `A version the LNV has – the app matched it${e.v.isrc ? ' by its ISRC' : ''}`) + of
    if (savedLinks(e.c).includes(e.row)) return 'Checked by you' + of
    if (e.c.answer.choice === 'same' && (e.c.answer.rows ?? []).includes(e.row)) return 'The app says it is this row – tick to confirm' + of
    if (e.c.answer.choice === 'add') return 'The app would add it as a new row – tick if it is this LNV row' + of
    return of.replace(/^ · /, '')
  }
  const tickBox = (g: Group, label: string) => {
    const on = gTicked(p, g), lock = gLocked(g)
    return (
      <label className={`cv-tick ${on ? 'on' : ''} ${lock ? 'lock' : ''}`} title={lock ? 'The app linked it by itself. If it is wrong, use “Not a match”.' : undefined}>
        <input type="checkbox" checked={on} disabled={lock} onChange={() => set((q) => tickGroup(q, g, !on, d.picks))} />{label}
      </label>
    )
  }
  const notMatch = (g: Group, what: string) => {
    const e = g.entries[0]
    const others = e.c.muso.length - 1
    return asking === g.key ? (
      <div className="nm">
        <b>Not {what} – where does it go?</b>
        <div className="nm-btns">
          <button type="button" className="btn" disabled={busy} onClick={() => newRow(g)}><Plus size={15} />{g.entries.every((x) => x.v) ? 'A row of its own' : 'New row in the LNV'}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => mapCard(g)}><Link2 size={15} />Map to another song…</button>
          {onlyRow(g) && <button type="button" className="btn" disabled={busy} onClick={() => void notRow(g)}><X size={15} />Only {rowsLabel(g)} {g.rows.length > 1 ? 'are' : 'is'} not it</button>}
          <button type="button" className="rv-text-btn" onClick={() => setAsking(null)}>Cancel</button>
        </div>
        <small className="muted">{g.entries.every((x) => x.v) ? `${g.recs.length > 1 ? `These ${g.recs.length} recordings leave` : 'This version leaves'} ${rowsLabel(g)}.`
          : `“${e.c.title}”${others > 0 ? ` and its ${others} other version${others > 1 ? 's' : ''}` : ''} leave${others > 0 ? '' : 's'} this song at once.`}</small>
      </div>
    ) : <button type="button" className="rv-text-btn nm-open" onClick={() => setAsking(g.key)}><X size={14} />Not {what}</button>
  }
  /** A match's answers: "Not a match" (a new row, or mapped onto another song) and, on its own, Delete. */
  const actions = (g: Group, what: string) => (
    <div className="fx-acts">
      {notMatch(g, what)}
      <button type="button" className="btn sm danger del-btn" disabled={busy} onClick={() => setDeleting(songsOf(g))}
        title={`Delete “${g.entries[0].c.title}” – nothing of it goes into the LNV; it is listed under Deleted songs, from where it maps back`}><Trash2 size={14} />Delete song</button>
    </div>
  )
  /** How a match stands: a version the LNV has (same ISRC · album · year), else the two stages' marks. */
  const checksOf = (g: Group) => {
    const e = g.entries[0]
    return e.v ? (
      <div className="cv-checks">
        <b className="cv-level warn">A version the LNV has</b>
        {([['isrc', 'ISRC'], ['album', 'album'], ['year', 'year']] as const).map(([k, label]) => (
          <span key={k} className={e.v![k] ? 'good' : 'bad'}>{e.v![k] ? <Check size={13} /> : <X size={13} />}{e.v![k] ? 'Same' : 'Other'} {label}</span>))}
      </div>
    ) : <Checks r={e.lnv} />
  }
  /** The recordings on a card: the first by name, the others as numbered buttons ("same ISRC, listed 3 times"). */
  const recsLine = (g: Group, cls: string) => (
    <>
      <button type="button" className={cls} onClick={() => openRec(g.recs[0])} title={`Everything ${source} holds for it`}>
        {cls === 'fx-rec' ? `${source}: ` : ''}{value(g.recs[0].fields.Title)}{cls === 'fx-rec' && g.recs[0].version && g.recs[0].version !== 'Original' ? ` · ${g.recs[0].version}` : ''}</button>
      {g.recs.length > 1 && (
        <span className="gr-more" title={`${source} lists ${g.recs.length} recordings for this row – one card for all of them`}>
          {n(g.recs.length)} {source} recordings{g.recs.map((r, i) => <button key={r.id ?? i} type="button" onClick={() => openRec(r)} title={value(r.fields.Title)}>{i + 1}</button>)}
        </span>
      )}
    </>
  )

  // an LNV row already an exact match above: said on its possible card – it is most likely another song
  const exactAt = new Map(f.exact.flatMap((g) => g.rows.map((row) => [row, value(g.recs[0].fields.Title)] as const)))
  const mark = (fl: string, v: string[], from: CaseRecord) => from !== main && v.length > 0 && differs(fl, shownOf(main, fl), v)
  type Across = ReturnType<typeof useAcross>
  /** LNV rows side by side against the main version, scrolled across: each field what the LNV keeps (its dropdown),
   *  the link, the title, the tick and the answers (Not a match · Delete). The exact matches, and the possible ones (X). */
  const lnvTable = (gs: Group[], kind: 'exact' | 'possible', sc: Across) => {
    // a possible match's LNV row is compared with the main version whatever recording is matched to it – the main
    // version itself too
    const cmp = (g: Group) => kind === 'possible' ? g.lnv : g.recs[0]
    return (
    <div className={`fx-wrap ${sc.end && sc.start ? '' : 'can'}`} ref={sc.ref} onScroll={sc.measure} onPointerDown={sc.down}>
      <table className={`fx ${kind}`}>
        <thead>
          <tr>
            <th className="fx-f" />
            <th className="fx-main"><span className="cv-badge muso">Main version</span><small className="muted">{source}</small></th>
            {gs.map((g) => (
              <th key={g.key} className={`fx-col ${gTicked(p, g) ? 'on' : ''}`}>
                <span className="gr-rows">{g.rows.map((row) => (
                  <button key={row} type="button" className="cv-badge lnv cv-rowbtn" onClick={() => setOpenedRow(row)} title="See this LNV row">LNV row {row}<ChevronRight size={14} /></button>))}</span>
                {g.rows.length > 1 && <small className="gr-same">The same data in each of these rows</small>}
                {recsLine(g, 'fx-rec')}
                {kind === 'possible' && checksOf(g)}
                {joinedOf(g)}
                {kind === 'possible' && g.rows.filter((row) => exactAt.has(row)).map((row) => (
                  <p key={row} className="pc-warn">LNV row {row} is already the exact match of “{exactAt.get(row)}” – check it is this song.</p>))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FIELDS.map((fl) => (
            <tr key={fl}>
              <th className="fx-f">{fl}</th>
              <td className={`fx-main ${fl === 'ISRC' ? 'mono' : ''} ${fl === 'Title' ? 'fx-t' : ''}`}><Listed r={main} fl={fl} source={source} />
                {fl === 'Title' && finalOf(mainLine) !== mainLine.muso && <small className="fx-other lnv">In the LNV: {finalOf(mainLine)}</small>}</td>
              {gs.map((g) => {
                if (fl === 'Title') return (
                  <td key={g.key} className={`fx-t ${mark(fl, [titleFinal(g)], cmp(g)) ? 'fx-dm' : ''}`}>{titlePick(g.trs.map((r) => r.id), () => mapCard(g))}</td>)
                const lv = list(g.lnv.fields[fl]), mvs = variants(fl, g.recs)
                const other = mvs.filter((v) => differs(fl, v, lv))
                // every field but the title (it has its own row): the LNV's, the DSP's, the IPI List's, or typed
                if (PICK_SHOWN.includes(fl)) {
                  const taken = pickOf(pickKey(g.rows[0], fl))
                  const fc = fieldChoices(fl, g, taken, source)
                  return (
                    <td key={g.key} className={`${mark(fl, fc.now, cmp(g)) ? 'fx-dm' : ''} ${fl === 'ISRC' ? 'mono' : ''}`}>
                      <FieldChoice key={`${fl}-${JSON.stringify(taken ?? null)}`} fl={fl} fc={fc} source={source} pick={(v) => choosePick(g, fl, v)} />
                    </td>
                  )
                }
                return (
                  <td key={g.key} className={`${mark(fl, lv.length ? lv : mvs[0] ?? [], cmp(g)) ? 'fx-dm' : ''} ${fl === 'ISRC' ? 'mono' : ''} ${fl === 'Title' ? 'fx-t' : ''}`}>
                    {lv.length ? lv.join(', ') : mvs.length ? <span className="fx-fill">{mvs.map((v) => v.join(', ')).join(' / ')}<small>blank in the LNV – {source}'s fills it</small></span> : <span className="muted">—</span>}
                    {lv.length > 0 && other.length > 0 && <small className="fx-other">{source}: {other.map((v) => v.join(', ')).join(' / ')}</small>}
                  </td>
                )
              })}
            </tr>
          ))}
          {/* the song's links (a Spotify track …) – from the LNV's website or Spotify ID, and from the DSP */}
          {hasLink([main, ...gs.flatMap((g) => [g.lnv, ...g.recs])]) && (
            <tr className="fx-link">
              <th className="fx-f">Link</th>
              <td className="fx-main"><Links urls={[main.link]} /></td>
              {gs.map((g) => <td key={g.key}><Links urls={[g.lnv.link]} from="LNV" /><Links urls={g.recs.map((r) => r.link)} from={source} />
                {!hasLink([g.lnv, ...g.recs]) && <span className="muted">—</span>}</td>)}
            </tr>
          )}
          {/* why a song was mapped here: shown once one of them has a remark */}
          {gs.some((g) => hasRemark(g.recs)) && (
            <tr className="fx-remark">
              <th className="fx-f">Remark</th>
              <td className="fx-main">{(() => { const r = remarkOf(d, [main]); return r && r !== 'mixed' ? r.name : <span className="muted">—</span> })()}</td>
              {gs.map((g) => <td key={g.key}><RemarkPick d={d} now={remarkOf(d, g.recs)} busy={busy} pick={(r) => void setRemark(g.recs, r)} /></td>)}
            </tr>
          )}
          {/* the answer, one row each: the ticks side by side, then "not a match" and delete */}
          <tr className="fx-yes">
            <th className="fx-f">{kind === 'exact' ? 'Exact match?' : 'Same song?'}</th>
            <td className="fx-main" />
            {gs.map((g) => <td key={g.key} className={gTicked(p, g) ? 'on' : ''}>{tickBox(g, kind === 'exact' ? 'Yes, exact match' : 'Yes, same song')}{hintOf(g) && <small className="fx-hint">{hintOf(g)}</small>}</td>)}
          </tr>
          <tr className="fx-act">
            <th className="fx-f" />
            <td className="fx-main" />
            {gs.map((g) => <td key={g.key}>{actions(g, kind === 'exact' ? 'an exact match' : 'a possible match')}</td>)}
          </tr>
        </tbody>
      </table>
    </div>
  )
  }
  // the possible matches' recordings, each once (the main version is the column they are compared with, not one of
  // them), and the LNV rows each one is matched to
  const pRecs = uniq(f.possible.flatMap((g) => g.recs)).filter((r) => r.id !== main.id)
  const rowsOfRec = (r: CaseRecord) => [...new Set(f.possible.filter((g) => g.recs.some((x) => x.id === r.id)).flatMap((g) => g.rows))].sort((a, b) => a - b)
  /** The possible matches' {source} recordings side by side against the main version (what differs is yellow). */
  const toRows = (r: CaseRecord) => rowsOfRec(r).length > 0 && (
    <span className="gr-rows fx-to"><ArrowRight size={13} className="muted" />{rowsOfRec(r).map((row) => (
      <button key={row} type="button" className="cv-badge lnv cv-rowbtn" onClick={() => setOpenedRow(row)} title="See this LNV row">LNV row {row}</button>))}</span>
  )
  const musoTable = (sc: Across) => !pRecs.length ? <p className="cv-none">The main version itself is the only {source} recording of these possible matches.</p> : (
    <div className={`fx-wrap ${sc.end && sc.start ? '' : 'can'}`} ref={sc.ref} onScroll={sc.measure} onPointerDown={sc.down}>
      <table className="fx muso">
        <thead>
          <tr>
            <th className="fx-f" />
            <th className="fx-main"><span className="cv-badge muso">Main version</span><small className="muted">{source}</small>{toRows(main)}</th>
            {pRecs.map((r, i) => (
              <th key={r.id ?? i} className="fx-col">
                <button type="button" className="cv-badge muso cv-rowbtn" onClick={() => openRec(r)} title={`Everything ${source} holds for it`}>{source} · {r.version ?? 'Original'}<ChevronRight size={14} /></button>
                <button type="button" className="fx-rec" onClick={() => openRec(r)}>{value(r.fields.Title)}</button>
                {toRows(r)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FIELDS.map((fl) => (
            <tr key={fl}>
              <th className="fx-f">{fl}</th>
              <td className={`fx-main ${fl === 'ISRC' ? 'mono' : ''} ${fl === 'Title' ? 'fx-t' : ''}`}><Listed r={main} fl={fl} source={source} /></td>
              {pRecs.map((r, i) => (
                <td key={r.id ?? i} className={`${mark(fl, shownOf(r, fl), r) ? 'fx-dm' : ''} ${fl === 'ISRC' ? 'mono' : ''} ${fl === 'Title' ? 'fx-t' : ''}`}>
                  <Listed r={r} fl={fl} source={source} /></td>
              ))}
            </tr>
          ))}
          {hasLink([main, ...pRecs]) && (
            <tr className="fx-link">
              <th className="fx-f">Link</th>
              <td className="fx-main"><Links urls={[main.link]} /></td>
              {pRecs.map((r, i) => <td key={r.id ?? i}><Links urls={[r.link]} />{!hasLink([r]) && <span className="muted">—</span>}</td>)}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
  // what "Delete" takes out: every LNV row the songs are matched to – not only the match it was pressed on
  const delRows = deleting ? [...new Set(cards.filter((g) => g.entries.some((e) => deleting.some((c) => c.id === e.c.id))).flatMap((g) => g.rows))].sort((a, b) => a - b) : []
  const exactOpen = f.exact.filter((g) => !gTicked(p, g) && !gLocked(g))
  const possibleOpen = f.possible.filter((g) => !gTicked(p, g))
  const todo = exactOpen.length + possibleOpen.length

  return (
    <div className="sm-detail rv-case fam">
      <div className="sm-detail-top">
        <div className="sm-detail-nav">
          <h3>{f.title}</h3>
          {!todo && <span className="rv-done-name"><Check size={13} />All checked</span>}
          <span className="grow" />
          <span className="muted rv-pos">{n(pos)} of {n(total)}</span>
          <button type="button" className="sm-nav" disabled={pos <= 1} onClick={prev} title="Previous song (↑)"><ArrowLeft size={15} /></button>
          <button type="button" className="sm-nav" disabled={pos >= total} onClick={next} title="Next song (↓)"><ArrowRight size={15} /></button>
          {wideBtn}
        </div>
        <div className="fam-counts">
          <a href="#fam-exact" className="fam-count exact">Exact match : <b>{n(f.exact.length)}</b></a>
          <a href="#fam-possible" className="fam-count possible">Possible match : <b>{n(f.possible.length)}</b></a>
          <span className="fam-count checked">Checked : <b>{n(checkedIn(p, f))}</b></span>
          <span className="fam-count todo">To check : <b>{n(todo)}</b></span>
          {f.cases.length > 1 && <span className="muted">{n(f.cases.length)} {source} songs under this name</span>}
          <span className="grow" />
          <button type="button" className="btn sm" disabled={busy} onClick={() => setAdding({})} title="Add a song to this one – from the sheets, or typed"><Plus size={14} />Add a song</button>
          <button type="button" className="btn sm" onClick={() => showUndo(f.id)} title="The changes made to this song – undo any of them"><Undo2 size={14} />Undo</button>
          <button type="button" className="btn sm danger fam-del" disabled={busy} onClick={() => setDeleting(f.cases)}
            title="Delete this song – nothing of it goes into the LNV; it is listed under Deleted songs, from where it maps back"><Trash2 size={14} />Delete this song</button>
        </div>
      </div>

      <div className="rv-scroll">
        {/* the main version: on top, everything below is compared with it */}
        <section className="fam-main">
          <div className="fam-main-head">
            <span className="cv-badge muso">{source} · Main version</span>
            <button type="button" className="fam-main-title" onClick={() => openRec(main)} title="Everything the sheet holds for it">{value(main.fields.Title)}<ChevronRight size={15} /></button>
            {main.version && <span className="cv-tag main">{main.version}</span>}
            <small className="muted fam-main-why">{plainMain ? 'the oldest recording with no remix, lofi or other tag' : 'no plain recording – the oldest version stands as the main one'}</small>
            <span className="grow" />
            <button type="button" className="rv-text-btn fam-main-fold" onClick={() => setMainOpen(!mainOpen)} aria-expanded={mainOpen}>
              {mainOpen ? <><ChevronUp size={14} />Hide details</> : <><ChevronDown size={14} />Show details</>}</button>
          </div>
          {mainOpen && <dl className="fam-main-fields">
            {FIELDS.slice(1).map((fl) => (
              <div key={fl}><dt>{fl}</dt><dd className={fl === 'ISRC' ? 'mono' : ''} title={value(main.fields[fl])}><Listed r={main} fl={fl} source={source} /></dd></div>
            ))}
            {hasLink([main]) && <div><dt>Link</dt><dd><Links urls={[main.link]} /></dd></div>}
          </dl>}
        </section>

        <Guide id="family" title="How to check a song" steps={[
          <>On top: the song's <b>main version</b> – the oldest {source} recording with no remix, lofi or other tag. Everything is compared with it; what differs is yellow.</>,
          <><b>Exact match</b>: scroll across. Tick <b>Yes, exact match</b> on each one that is right and pick its title in the last row.</>,
          <><b>Possible match</b>: two tables – the {source} versions, then the LNV rows, each against the main version. Pick what the LNV keeps, then tick <b>Yes, same song</b>.</>,
          <>A wrong one? <b>Not a match</b> gives it a new row in the LNV, or maps it to another song. <b>Delete song</b> leaves it out of the LNV.</>,
          <>Changes save by themselves; <b>Save</b> at the top saves them at once. <b>Saved to the LNV</b> has the download.</>,
        ]} />

        <section className="fam-sec" id="fam-exact">
          <header className="fam-sec-head">
            <div className="grow">
              <h4>Exact match : {n(f.exact.length)}</h4>
              <p>The same recording and the same work as an LNV row. Scroll across – drag the table, or use the ← → keys or buttons; the main version stays in place.</p>
            </div>
            {f.exact.length > 0 && <Nav sc={across} what="exact matches" />}
            {exactOpen.length > 1 && <button type="button" className="btn sm" onClick={() => tickAll(exactOpen)}><CheckCheck size={14} />Tick all {n(exactOpen.length)}</button>}
          </header>
          {!f.exact.length ? <p className="cv-none">No exact match for this song name.</p> : lnvTable(f.exact, 'exact', across)}
        </section>

        <section className="fam-sec" id="fam-possible">
          <header className="fam-sec-head">
            <div className="grow">
              <h4>Possible match : {n(f.possible.length)}</h4>
              <p>Only part of it matches – the recording or the work. Each one is compared with the main version above: pick the value the LNV keeps where {source} and the LNV differ.</p>
              <p className="fam-legend"><span><i className="fam-sw dm" />differs from the main version</span>
                {axis === 'y' && <span><i className="fam-sw two" /><b>pick one</b> – {source} and the LNV differ: the one picked goes into the LNV</span>}
                {d.ipi && <span><i className="fam-sw ipi" /><b>IPI List</b> – the member’s name in the IPI / CAE list</span>}</p>
            </div>
            {/* how the possible matches scroll: two tables across (X) or cards one below another (Y) */}
            {f.possible.length > 0 && (
              <span className="axis" role="group" aria-label="How the possible matches scroll">
                <button type="button" className={axis === 'x' ? 'on' : ''} aria-pressed={axis === 'x'} onClick={() => setAxis('x')} title="Two tables side by side – scroll across (X)"><ArrowLeftRight size={14} />X scroll</button>
                <button type="button" className={axis === 'y' ? 'on' : ''} aria-pressed={axis === 'y'} onClick={() => setAxis('y')} title="One card per LNV row, one below another – scroll down (Y)"><ArrowUpDown size={14} />Y scroll</button>
              </span>
            )}
          </header>
          {!f.possible.length ? <p className="cv-none">No possible match for this song name.</p> : axis === 'x' ? (
            <>
              <div className="fam-sub" id="fam-possible-muso">
                <header className="fam-sub-head">
                  <div className="grow"><h5><span className="cv-badge muso">{source}</span> versions against the main version <b>{n(pRecs.length)}</b></h5>
                    <p>Every {source} recording of the possible matches beside the main version: what differs from it is yellow.</p></div>
                  <Nav sc={acrossM} what={`${source} versions`} />
                </header>
                {musoTable(acrossM)}
              </div>
              <div className="fam-sub" id="fam-possible-lnv">
                <header className="fam-sub-head">
                  <div className="grow"><h5><span className="cv-badge lnv">LNV</span> rows against the main version <b>{n(f.possible.length)}</b></h5>
                    <p>Each LNV row that may be this song beside the main version: pick what the LNV keeps in each field, then tick <b>Yes, same song</b>.</p></div>
                  <Nav sc={acrossL} what="LNV rows" />
                </header>
                {lnvTable(f.possible, 'possible', acrossL)}
              </div>
            </>
          ) : (
          <div className="pc-list y">
          {f.possible.map((g) => {
            const on = gTicked(p, g)
            const shown = FIELDS   // every field: each one can be picked or typed
            return (
              <article key={g.key} className={`pc ${on ? 'on' : ''}`}>
                <header className="pc-head">
                  <div className="pc-pair">
                    <button type="button" className="cv-badge muso cv-rowbtn" onClick={() => openRec(g.recs[0])} title={`Everything ${source} holds for it`}>{source} · {g.recs[0].version ?? 'Original'}<ChevronRight size={14} /></button>
                    {recsLine(g, 'pc-title')}
                    <ArrowRight size={16} className="muted" />
                    {g.rows.map((row) => <button key={row} type="button" className="cv-badge lnv cv-rowbtn" onClick={() => setOpenedRow(row)} title="See this LNV row">LNV row {row}<ChevronRight size={14} /></button>)}
                    {g.rows.length > 1 && <small className="gr-same">the same data in each row</small>}
                  </div>
                </header>
                <div className="pc-sub">
                  {g.rows.filter((row) => exactAt.has(row)).map((row) => (
                    <p key={row} className="pc-warn">LNV row {row} is already the exact match of “{exactAt.get(row)}” above – check it is this song, else use “Not a possible match”.</p>
                  ))}
                  {checksOf(g)}{joinedOf(g)}
                </div>
                <table className="pc-t">
                  <thead><tr><th /><th className="muso">{source}{g.recs.length > 1 ? ` – ${g.recs.length} recordings` : ''}</th><th className="lnv">{rowsLabel(g)}</th></tr></thead>
                  <tbody>
                    {shown.map((fl) => {
                      if (fl === 'Title') return (
                        <tr key={fl}><th>{fl}</th><td className={`fx-t ${mark(fl, [value(g.recs[0].fields.Title)], g.recs[0]) ? 'fx-dm' : ''}`}>{variants(fl, g.recs).map((v, i) => <div key={i}>{v.join(', ')}</div>)}</td>
                          <td className={`fx-t ${mark(fl, [titleFinal(g)], g.lnv) ? 'fx-dm' : ''}`}>{titlePick(g.trs.map((r) => r.id), () => mapCard(g))}</td></tr>)
                      const pickable = PICK_SHOWN.includes(fl)
                      const taken = pickOf(pickKey(g.rows[0], fl))
                      const fc = fieldChoices(fl, g, taken, source)
                      const { lv, vs, ipis } = fc
                      // the DSP values that differ from the LNV's (one choice each), the list's names, the LNV's: pick one
                      const opts = pickable ? (lv.length ? fc.opts : ipis.length ? fc.opts : []) : []
                      const two = pickable && (opts.length > 0 || ipis.length > 0)
                      // only a spelling apart: the IPI / CAE list says they are the same people
                      const spelling = two && lv.length > 0 && !vs.some((x) => differs(fl, x.res, fc.lvShown))
                      const at = fc.mode.startsWith('m') ? Number(fc.mode.slice(1)) : -1
                      const typed = fc.mode === 'custom' ? fc.now : null
                      const opt = (v: string[], sel: boolean, pick: string[] | null, key: string, note?: ReactNode) => (
                        <label key={key} className={`pc-opt ${sel ? 'on' : ''}`}>
                          <input type="radio" name={`${g.key}-${fl}`} checked={sel} onChange={() => choosePick(g, fl, pick)} />
                          <span>{v.join(', ')}</span>{note}{sel && <small>goes into the LNV</small>}
                        </label>
                      )
                      const tone = (v: string[], from: CaseRecord) => `${mark(fl, v, from) ? 'fx-dm' : ''} ${fl === 'ISRC' ? 'mono' : ''} ${fl === 'Title' ? 'fx-t' : ''}`
                      return (
                        <tr key={fl} className={`${two ? 'two' : ''} ${typed ? 'typed' : ''}`}>
                          <th>{fl}{pickable && <KeepChip keep={fc.keep} source={source} />}{two && <small>{spelling ? 'same people – pick the spelling' : 'pick one'}</small>}</th>
                          <td className={tone(vs[0]?.res ?? [], g.recs[0])}>
                            {two && opts.length ? <div className="pc-opts">{opts.map((v, i) => {
                              const x = vs.find((y) => !differs(fl, y.v, v))
                              return opt(v, i === at, fc.pickOf(`m${i}`), String(i), x && x.res !== x.v ? <small className="ipi-is">IPI List: {x.res.join(', ')}</small> : null)
                            })}
                              {opts.length < vs.length && <small className="muted">{n(vs.length - opts.length)} more with the LNV's value</small>}</div>
                              : vs.length ? vs.map((x, i) => <div key={i}>{x.res.join(', ')}{x.res !== x.v && <small className="ipi-was">{source}: {x.v.join(', ')}</small>}</div>) : <span className="muted">—</span>}
                          </td>
                          <td className={tone(lv, g.lnv)}>
                            {two && lv.length > 0 && opt(lv, fc.mode === 'lnv', fc.pickOf('lnv'), 'lnv')}
                            {two && ipis.map((x, j) => (
                              <label key={`ipi${j}`} className={`pc-opt ipi ${fc.mode === `i${j}` ? 'on' : ''}`}>
                                <input type="radio" name={`${g.key}-${fl}`} checked={fc.mode === `i${j}`} onChange={() => choosePick(g, fl, fc.pickOf(`i${j}`))} />
                                <span>{x.v.join(', ')}</span><small className="ipi-is">IPI List{ipis.length > 1 ? ` – from ${x.from}'s names` : ''}</small>
                                {fc.mode === `i${j}` && <small>goes into the LNV</small>}
                              </label>
                            ))}
                            {/* every field edited in place: the pencil (or a click on the value) types the value the LNV keeps */}
                            {pickable ? <EditPick key={`${g.key}-${fl}-${JSON.stringify(typed)}`} fl={fl} radio={two} typed={typed}
                              shown={fc.now} note={!lv.length && vs.length ? `blank in the LNV – ${source}'s fills it${fc.keep === 'ipi' ? ', as the IPI / CAE list has it' : ''}` : null}
                              start={fc.now} save={(v) => choosePick(g, fl, v)} />
                              : !two && (lv.length ? lv.join(', ') : vs.length ? <span className="fx-fill">blank – {source}'s fills it</span> : <span className="muted">—</span>)}
                          </td>
                        </tr>
                      )
                    })}
                    {hasRemark(g.recs) && <tr><th>Remark</th><td colSpan={2}><RemarkPick d={d} now={remarkOf(d, g.recs)} busy={busy} pick={(r) => void setRemark(g.recs, r)} /></td></tr>}
                    {hasLink([g.lnv, ...g.recs]) && <tr className="pc-link"><th>Link</th><td><Links urls={g.recs.map((r) => r.link)} /></td><td><Links urls={[g.lnv.link]} /></td></tr>}
                    {/* the answer at the bottom, as in the exact matches: the tick, then "not a match" */}
                    <tr className="pc-yes"><th>Same song?</th><td colSpan={2} className={on ? 'on' : ''}>{tickBox(g, 'Yes, same song')}{hintOf(g) && <small className="fx-hint">{hintOf(g)}</small>}</td></tr>
                    <tr className="pc-act"><th /><td colSpan={2}>{actions(g, 'a possible match')}</td></tr>
                  </tbody>
                </table>
              </article>
            )
          })}
          </div>
          )}
        </section>

        {f.typed.length > 0 && (
          <section className="fam-sec" id="fam-typed">
            <header className="fam-sec-head"><div className="grow"><h4>Added by you : {n(f.typed.length)}</h4><p>Songs you typed. Each goes into the LNV as a new row under this song.</p></div></header>
            <div className="ty">{f.typed.map((t) => (
              <TypedCard key={t.key} t={t} busy={busy} edit={() => setAdding({ edit: t })} remove={async () => {
                setBusy(true)
                const ok = await commit([{ key: t.key, choice: null }])
                setBusy(false)
                if (ok) toast(`“${t.data.title}” is removed – Undo brings it back`, 'good')
              }} />))}</div>
          </section>
        )}

        {f.rest.length > 0 && (
          <Part id="fam-rest" initial={false} title={`Other ${source} versions – beside no LNV row (${n(f.rest.length)})`}
            note="Each gets a row of its own naming the original, once its song is linked or added">
            <div className="fr">
              {f.rest.map(({ c, r }) => (
                <div key={r.id} className="fr-row">
                  <div className="fr-rec">
                    <button type="button" className="rv-ver-open" onClick={() => openRec(r)}>{value(r.fields.Title)}</button>
                    <span className={`cv-tag ${r === main ? 'main' : ''}`}>{r === main ? 'Main version' : r.version ?? 'Version'}</span>
                    <small className="muted">{[value(r.fields['Film / album']), value(r.fields.Year).slice(0, 4), list(r.fields.ISRC)[0]].filter(Boolean).join(' · ')}</small>
                  </div>
                  <div className="fr-set">
                    {titlePick([r.id], () => setMapping({ c, rec: r, recs: c.muso.filter((x) => x.in) }))}
                    {(r.moved || hasRemark([r])) && <div className="fr-remark"><span className="muted">{r.moved ? <>Mapped from “{r.moved.from}” · Remark</> : 'Remark'}</span><RemarkPick d={d} now={remarkOf(d, [r])} busy={busy} pick={(x) => void setRemark([r], x)} /></div>}
                  </div>
                </div>
              ))}
            </div>
          </Part>
        )}
      </div>

      {mapping && <MapDialog c={mapping.c} rec={mapping.rec} recs={mapping.recs} targets={targets} source={source} save={commit}
        close={() => setMapping(null)} done={(all, t) => { setAsking(null); toast(`${all ? 'Every version' : 'The version'} now belongs to “${t.title}” (LNV row ${t.row})`, 'good') }} />}
      {opened !== null && f.recs[opened] && <VersionDetails r={f.recs[opened]} main={main} at={opened} total={f.recs.length} source={source} go={setOpened} close={() => setOpened(null)} />}
      {openedRow !== null && <LnvRowDetails row={openedRow} rows={rows} go={setOpenedRow} close={() => setOpenedRow(null)} />}
      {adding && <AddSong f={f} families={families} loose={loose} d={d} p={p} edit={adding.edit} commit={commit} act={act} close={() => setAdding(null)} done={(t) => toast(t, 'good')} />}
      <ConfirmDialog open={!!deleting} title={deleting && deleting.length > 1 ? `Delete the ${n(deleting.length)} songs of “${f.title}”?` : `Delete “${deleting?.[0]?.title ?? ''}”?`}
        confirmLabel="Delete" onCancel={() => setDeleting(null)} onConfirm={() => del(deleting ?? [])}>
        <p>Nothing of {deleting && deleting.length > 1 ? 'these songs' : 'this song'} – {deleting?.reduce((t, c) => t + c.muso.length, 0) ?? 0} {source} recording{(deleting?.reduce((t, c) => t + c.muso.length, 0) ?? 0) === 1 ? '' : 's'} – goes into the LNV: no link, no new row.
          {' '}It is listed under <b>Deleted songs</b>, from where you can put it back to its exact or possible match, or map it to another song.</p>
        {delRows.length > 0 && <p>{delRows.length > 1 ? <>All its matches leave: <b>LNV rows {delRows.join(', ')}</b>.</> : <>Its match leaves: <b>LNV row {delRows[0]}</b>.</>} The LNV rows themselves stay in the LNV.</p>}
      </ConfirmDialog>
    </div>
  )
}

/** A song the reviewer typed: what goes into its new LNV row. */
export function TypedCard({ t, busy, edit, remove, children }: { t: TypedSong; busy: boolean; edit: () => void; remove: () => void; children?: ReactNode }) {
  const r = t.record.fields
  return (
    <article className="ty-card">
      <header><span className="cv-badge typed">Typed · new row</span><b>{t.data.title}</b><span className="grow" />{children}
        <button type="button" className="btn sm" disabled={busy} onClick={edit}><Pencil size={13} />Edit</button>
        <button type="button" className="btn sm danger" disabled={busy} onClick={remove}><Trash2 size={13} />Remove</button></header>
      <dl>{FIELDS.slice(1).map((fl) => value(r[fl]) && <div key={fl}><dt>{fl}</dt><dd className={fl === 'ISRC' ? 'mono' : ''}>{value(r[fl])}</dd></div>)}
        <div><dt>Link</dt><dd><Links urls={t.data.links} /></dd></div></dl>
    </article>
  )
}

/** How the possible matches show – two tables scrolled across (x, the default) or cards one below another (y) – kept
 *  for the next song. */
function useAxis(): ['x' | 'y', (a: 'x' | 'y') => void] {
  const [axis, set] = useState<'x' | 'y'>(() => { try { return localStorage.getItem('mrm-possible-view') === 'y' ? 'y' : 'x' } catch { return 'x' } })
  return [axis, (a) => { set(a); try { localStorage.setItem('mrm-possible-view', a) } catch { /* private mode */ } }]
}

/** A table's ← → buttons: one column at a time. */
function Nav({ sc, what }: { sc: { start: boolean; end: boolean; go: (dir: number) => void }; what: string }) {
  if (sc.start && sc.end) return null
  return (
    <span className="fx-nav">
      <button type="button" className="sm-nav" disabled={sc.start} onClick={() => sc.go(-1)} title="Scroll left (←)" aria-label={`Scroll the ${what} left`}><ChevronLeft size={18} /></button>
      <button type="button" className="sm-nav" disabled={sc.end} onClick={() => sc.go(1)} title="Scroll right (→)" aria-label={`Scroll the ${what} right`}><ChevronRight size={18} /></button>
    </span>
  )
}

/** The exact matches scrolled across: hold the mouse on the table and drag, the ← → keys (while not typing and no
 *  popup is open, with the table on screen), or the arrow buttons – one column at a time. */
function useAcross(reset: string, item = '.fx-col', enabled = true) {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ start: true, end: true })
  const measure = () => {
    const w = ref.current
    if (w) setEdge({ start: w.scrollLeft <= 1, end: w.scrollLeft + w.clientWidth >= w.scrollWidth - 1 })
  }
  const go = (dir: number) => {
    const w = ref.current
    if (!w) return
    const col = (w.querySelector<HTMLElement>(item)?.offsetWidth ?? 280) + (item === '.fx-col' ? 0 : 16)
    w.scrollBy({ left: dir * col, behavior: 'smooth' })
  }
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = 0
    measure()
    const w = ref.current
    const ro = w ? new ResizeObserver(measure) : null
    if (w && ro) { ro.observe(w); const t = w.querySelector('table'); if (t) ro.observe(t) }
    return () => ro?.disconnect()
  }, [reset])   // eslint-disable-line react-hooks/exhaustive-deps
  const goRef = useRef(go)
  goRef.current = go
  const on = useRef(enabled)
  on.current = enabled
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.drawer, .modal')) return
      const t = e.target as HTMLElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return
      const w = ref.current
      if (!on.current || !w || w.scrollWidth <= w.clientWidth) return
      const r = w.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) return   // the table is not on screen
      // two rows scrolled across on screen (exact and possible matches): the one across the middle of the screen
      const others = [...document.querySelectorAll<HTMLElement>('.fx-wrap')].filter((x) => x !== w && x.scrollWidth > x.clientWidth)
        .filter((x) => { const b = x.getBoundingClientRect(); return b.bottom > 0 && b.top < window.innerHeight })
      const mid = window.innerHeight / 2
      if (others.length && !(r.top <= mid && r.bottom >= mid)) return
      e.preventDefault()
      goRef.current(e.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // hold and drag: a press on a button, a tick, a choice or a text field stays a click
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const w = ref.current
    if (!enabled || !w || e.button !== 0 || e.pointerType === 'touch' || w.scrollWidth <= w.clientWidth) return
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea, label')) return
    const x0 = e.clientX, left0 = w.scrollLeft
    let moved = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      if (!moved && Math.abs(dx) < 4) return
      if (!moved) { moved = true; w.classList.add('dragging'); window.getSelection()?.removeAllRanges() }
      w.scrollLeft = left0 - dx
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      w.classList.remove('dragging')
      // a drag is no click on what it ends over
      if (!moved) return
      const eat = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', eat, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return { ref, go, down, measure, start: edge.start, end: edge.end }
}

/** The title one recording gets in the LNV – same as the main version, the DSP's, the LNV's, typed – chosen and typed
 *  right in the Title row, like every other field; or the recording mapped to another song. */
function TitlePick({ line, mode, final, isMain, mainTitle, source, choose, map }: {
  line: Line; mode: TitleMode; final: string; isMain: boolean; mainTitle: string; source: string
  choose: (mode: TitleMode, text?: string) => void; map: () => void
}) {
  const [typing, setTyping] = useState<string | null>(null)
  const keep: Keep = mode === 'muso' ? 'muso' : mode === 'lnv' ? 'lnv' : mode === 'custom' ? 'custom' : 'blank'
  const options: DropOption<TitleMode | 'map'>[] = [
    ...(line.lnv ? [{ value: 'lnv' as const, label: <KeepOption keep="lnv" tag="LNV" text={`Keep the LNV's title${line.def === 'lnv' ? ' (as is)' : ''}`} />, hint: line.lnv }] : []),
    { value: 'muso', label: <KeepOption keep="muso" tag={source} text={`Keep ${source}'s title${line.def === 'muso' ? ' (as is)' : ''}`} />, hint: line.muso },
    ...(!isMain ? [{ value: 'main' as const, label: <KeepOption keep="blank" tag="Main" text="Same as the main version" />, hint: mainTitle }] : []),
    { value: 'custom', label: <KeepOption keep="custom" tag="Custom" text="Customise – type it" />, hint: mode === 'custom' ? final : 'Type the title for the LNV', sep: true },
    { value: 'map', label: 'Map to another song…', hint: 'It is a version of another song in the LNV' },
  ]
  return (
    <div className={`fc tp ${mode === 'custom' ? 'typed' : ''}`}>
      <Dropdown className="fc-dd tp-dd" tone={keep === 'blank' ? '' : keep} value={mode} options={options} label="What the LNV keeps for Title" menuWidth={310}
        shown={<><i className="dd-dot" />Keep: {mode === 'main' ? 'Main version' : keepText(keep, source)}</>}
        onChange={(m) => { if (m === 'map') map(); else if (m === 'custom') setTyping(final); else choose(m) }} />
      {typing != null
        ? <EditBox initial={typing} label="Title for the LNV" placeholder="Type the title for the LNV"
          done={(t) => { setTyping(null); if (t && t !== final) choose('custom', t) }} />
        : <EditLine label="title" edit={() => setTyping(final)}><b>{final}</b></EditLine>}
      {line.muso !== final && <small className="fx-other">{source}: {line.muso}</small>}
      {line.lnv && line.lnv !== final && <small className="fx-other lnv">LNV: {line.lnv}</small>}
    </div>
  )
}

/** The box to type a value in place: ready to type (the cursor after the text), with ✓ to keep it and ✕ to drop it –
 *  or Enter / leaving the box, and Esc. done(null): nothing changed. */
function EditBox({ initial, label, placeholder, done }: { initial: string; label: string; placeholder: string; done: (text: string | null) => void }) {
  const [text, setText] = useState(initial)
  const over = useRef(false)   // a click on ✓ or ✕ is on its way: leaving the box is not "keep"
  const keep = () => done(text.trim())
  return (
    <div className="fe-edit">
      <input autoFocus className="fc-in" value={text} onChange={(e) => setText(e.target.value)} aria-label={label} placeholder={placeholder}
        onFocus={(e) => { const end = e.currentTarget.value.length; e.currentTarget.setSelectionRange(end, end) }}
        onBlur={() => { if (!over.current) keep() }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); keep() } if (e.key === 'Escape') { e.preventDefault(); done(null) } }} />
      <button type="button" className="fe-btn ok" title="Keep (Enter)" aria-label="Keep"
        onPointerDown={() => { over.current = true }} onClick={() => { over.current = false; keep() }}><Check size={15} /></button>
      <button type="button" className="fe-btn" title="Cancel (Esc)" aria-label="Cancel"
        onPointerDown={() => { over.current = true }} onClick={() => { over.current = false; done(null) }}><X size={15} /></button>
    </div>
  )
}

/** A field's value typed: names split at their commas. done(null) when nothing changed. */
function TypeIn({ fl, initial, now, done }: { fl: string; initial: string; now: string[]; done: (v: string[] | null) => void }) {
  return (
    <EditBox initial={initial} label={`${fl} for the LNV`}
      placeholder={NAME_FIELDS.has(fl) ? 'Names, comma between them' : fl === 'Year' ? 'e.g. 2015' : `Type the ${fl.toLowerCase()} for the LNV`}
      done={(t) => {
        if (t == null) return done(null)
        const v = NAME_FIELDS.has(fl) ? t.split(',').map((x) => x.trim()).filter(Boolean) : t ? [t] : []
        done(v.length && !same(v, now) ? v : null)
      }} />
  )
}

/** A value as it goes into the LNV, and its pencil – always at the same place, the top right; only the pencil opens
 *  the box to type it. */
function EditLine({ label, edit, children }: { label: string; edit: () => void; children: ReactNode }) {
  return (
    <div className="fe">
      <span className="fe-text">{children}</span>
      <button type="button" className="fe-btn pen" onClick={edit} title={`Edit the ${label} – type the value the LNV keeps`} aria-label={`Edit the ${label}`}><Pencil size={14} /></button>
    </div>
  )
}

/** A small chip: "Keeps LNV" · "Keeps Muso" · "Keeps IPI List" · "Keeps Customised". */
function KeepChip({ keep, source }: { keep: Keep; source: string }) {
  return <span className={`keep-chip ${keep}`} title={`The LNV keeps ${keep === 'custom' ? 'the value typed by you' : keep === 'blank' ? 'nothing – blank'
    : keep === 'ipi' ? 'the member’s name in the IPI / CAE list' : `${keepText(keep, source)}'s value`}`}>
    <i aria-hidden />Keeps {keepText(keep, source)}</span>
}

/** An option of the "keep" dropdown: its source as a coloured tag, then what it does. */
const KeepOption = ({ keep, tag, text }: { keep: Keep; tag: string; text: string }) =>
  <span className="keep-opt"><i className={`keep-tag ${keep}`}>{tag}</i>{text}</span>

/** A field's value with its pencil (see EditLine). */
const EditValue = ({ fl, value: v, note, edit }: { fl: string; value: string[]; note?: string | null; edit: () => void }) => (
  <EditLine label={fl.toLowerCase()} edit={edit}>{v.length ? v.join(', ') : <span className="muted">—</span>}{note && <small className="fx-fill-note">{note}</small>}</EditLine>
)

/** A name as the IPI / CAE list has it ("Ram Krishna"), with what the file wrote under it ("Muso: RK"). */
function Listed({ r, fl, source }: { r: CaseRecord; fl: string; source: string }) {
  const ip = ipiOf(r, fl)
  const raw = value(r.fields[fl])
  if (!ip) return raw ? <>{raw}</> : <span className="muted">—</span>
  return <>{ip.names.join(', ')}<small className="ipi-was" title="The IPI / CAE list has this member under the name above">{r.src === 'LNV' ? 'LNV' : source}: {raw}</small></>
}

/** One field of an exact match as it goes into the LNV: the value – edited in place with its pencil – and under it a
 *  dropdown saying what the LNV keeps: the LNV's own value, the DSP's, the IPI / CAE list's name, or a customised
 *  (typed) one. */
function FieldChoice({ fl, fc, source, pick }: { fl: string; fc: Choices; source: string; pick: (v: string[] | null) => void }) {
  const [typing, setTyping] = useState<string | null>(null)
  const { lv, opts, ipis, mode, now, keep, def } = fc
  const options: DropOption[] = [
    ...(lv.length ? [{ value: 'lnv', label: <KeepOption keep="lnv" tag="LNV" text={def === 'lnv' ? "Keep the LNV's value" : "Keep the LNV's value as written"} />, hint: lv.join(', ') }]
      : !opts.length && !ipis.length ? [{ value: 'blank', label: <KeepOption keep="blank" tag="—" text="Leave it blank" /> }] : []),
    ...opts.map((v, i) => ({ value: `m${i}`, label: <KeepOption keep="muso" tag={source}
      text={!lv.length && i === 0 ? `Keep ${source}'s – fills the blank${def !== 'm0' ? ' as written' : ''}` : `Keep ${source}'s value`} />, hint: v.join(', ') })),
    ...ipis.map((x, j) => ({ value: `i${j}`, label: <KeepOption keep="ipi" tag="IPI" text={`Keep the IPI List's name${ipis.length > 1 ? ` (for ${x.from}'s)` : ''}`} />,
      hint: `${x.v.join(', ')} – ${x.from} wrote ${x.raw.join(', ')}` })),
    { value: 'custom', label: <KeepOption keep="custom" tag="Custom" text="Customise – type it" />, hint: mode === 'custom' ? now.join(', ') : `Type the ${fl.toLowerCase()} yourself`, sep: true },
  ]
  const choose = (m: string) => { if (m === 'custom') setTyping(now.join(', ')); else pick(fc.pickOf(m)) }
  const fills = !lv.length && mode === def && mode !== 'blank'
  const ip = mode.startsWith('i') ? ipis[Number(mode.slice(1))] : null
  return (
    <div className={`fc ${mode === 'custom' ? 'typed' : ''}`}>
      <Dropdown className="fc-dd" tone={keep === 'blank' ? '' : keep} value={mode} options={options} label={`What the LNV keeps for ${fl}`} menuWidth={310}
        shown={<><i className="dd-dot" />Keep: {keepText(keep, source)}</>} onChange={choose} />
      {typing != null ? <TypeIn fl={fl} initial={typing} now={now} done={(v) => { setTyping(null); if (v) pick(v) }} />
        : <EditValue fl={fl} value={now} note={fills ? `blank in the LNV – ${source}'s fills it` : null} edit={() => setTyping(now.join(', '))} />}
      {ip && <small className="fx-other ipi">IPI List – {ip.from} wrote: {ip.raw.join(', ')}</small>}
      {mode === 'lnv' && opts.length > 0 && <small className="fx-other">{source}: {opts.map((v) => v.join(', ')).join(' / ')}</small>}
    </div>
  )
}

/** A possible match's field in the LNV's column, edited in place. In a row where the DSP and the LNV differ (radio):
 *  a third choice under the LNV's – Customise – with its pencil: a click on it opens the box to type the value right
 *  there (and again, to change a typed one). Else the value itself, a click or its pencil to type another; once typed,
 *  the value and back to the LNV's. */
function EditPick({ fl, radio, typed, shown, note, start, save }: {
  fl: string; radio: boolean; typed: string[] | null; shown: string[]; note?: string | null; start: string[]
  save: (v: string[] | null) => void
}) {
  const [typing, setTyping] = useState<string | null>(null)
  const edit = (from: string[]) => setTyping(from.join(', '))
  const box = typing != null ? <TypeIn fl={fl} initial={typing} now={typed ?? start} done={(v) => { setTyping(null); if (v) save(v) }} /> : null
  if (radio) return box ? <div className="pc-opt pc-custom editing">{box}</div> : typed ? (
    <div className={`pc-opt pc-custom on`}>
      <i className="pc-radio" aria-hidden />
      <span>{typed.join(', ')}</span>
      <button type="button" className="fe-btn pen" onClick={() => edit(typed)} title={`Edit the ${fl.toLowerCase()} – type the value the LNV keeps`} aria-label={`Edit the ${fl.toLowerCase()}`}><Pencil size={14} /></button>
      <small>customised by you – goes into the LNV</small>
    </div>
  ) : (
    <button type="button" className="pc-opt pc-custom" onClick={() => edit(start)} title={`Type the ${fl.toLowerCase()} the LNV keeps`}>
      <i className="pc-radio" aria-hidden />
      <span>Customise – type it</span>
      <span className="fe-btn pen" aria-hidden><Pencil size={14} /></span>
    </button>
  )
  if (box) return box
  return typed ? (
    <div className="pc-typed">
      <EditValue fl={fl} value={typed} edit={() => edit(typed)} />
      <span className="pc-typed-btns">
        <button type="button" className="rv-text-btn" onClick={() => save(null)}><Undo2 size={13} />Back to the LNV's</button>
      </span>
    </div>
  ) : <EditValue fl={fl} value={shown} note={note} edit={() => edit(start)} />
}
