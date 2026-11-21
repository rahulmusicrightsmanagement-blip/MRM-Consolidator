import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Link2, Pencil, Plus, Undo2, X } from 'lucide-react'
import { Dropdown, Guide } from '../../components/ui'
import type { DropOption } from '../../components/ui'
import type { CleanDecisionIn } from '../../lib/api'
import type { CaseRecord, ReviewCase, Step1, TitleMode } from '../../types'
import { list, n, norm } from './Block'
import { Checks, Links, LnvRowDetails, MapDialog, Part, VersionDetails, differs, hasLink, useKeys, useStored, value, writersOf } from './CaseParts'
import type { Target } from './CaseParts'
import { NAME_FIELDS, PICKABLE, PICK_SHOWN, draftOf, itemsOf, matchOf, pickItem, pickKey } from './reviewModel'

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
}

const PLAIN = new Set(['Original', 'Re-release'])
const yearOf = (r: CaseRecord) => value(r.fields.Year) || '9999'
const FIELDS = ['Title', 'Film / album', 'Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC', 'Year']

/** Out of the LNV match: the reviewer gave it a new row, or it is not the client's – listed under "Not in the LNV". */
export const outOfMatch = (c: ReviewCase) => c.answer.choice === 'not_ours' || (c.answer.choice === 'add' && c.answer.by === 'you')
export const inFamilies = (c: ReviewCase) => c.kind !== 'names' && c.kind !== 'twice' && !outOfMatch(c) && ['exact', 'possible'].includes(matchOf(c))

function entriesOf(c: ReviewCase): Entry[] {
  const out: Entry[] = []
  // the rows the reviewer linked; else every row the app found a match in (or proposes)
  const mine = c.answer.choice === 'same' && c.answer.by === 'you' ? c.answer.rows ?? [] : null
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
export function familiesOf(cases: ReviewCase[]): Family[] {
  const by = new Map<string, ReviewCase[]>()
  cases.filter(inFamilies).forEach((c) => { const k = c.family || c.id; by.set(k, [...(by.get(k) ?? []), c]) })
  // a name that only versions carry joins the shorter name it starts with: 'Maula Mere Maula Electronic Lab - Jhankar
  // Beats' is a Jhankar version of 'Maula Mere Maula' (a longer name with a plain recording stays a song of its own)
  const keys = [...by.keys()].filter((k) => !k.includes(':')).sort((a, b) => a.length - b.length)
  for (const k of [...keys].reverse()) {
    const base = [...keys].reverse().find((x) => x.length >= 8 && x.length < k.length && k.startsWith(x) && by.has(x))   // the closest name
    if (base && by.get(k)!.every(tagged)) { by.set(base, [...by.get(base)!, ...by.get(k)!]); by.delete(k) }
  }
  return [...by].map(([k, cs]) => {
    const all = cs.flatMap((c) => c.muso.filter((r) => r.in))
    const main = [...all].sort((a, b) => plainness(a) - plainness(b) || yearOf(a).localeCompare(yearOf(b)))[0] ?? cs[0].muso[0]
    const entries = cs.flatMap(entriesOf)
    const used = new Set(entries.flatMap((e) => [e.rec.id, e.tr.id]))
    return {
      id: `f:${k}`, title: value(main?.fields.Title) || cs[0].title, cases: cs, main,
      recs: [main, ...all.filter((r) => r !== main)],
      // both in LNV row order, the lowest row first
      exact: groupsOf(entries.filter((e) => e.match === 'exact')).sort((a, b) => a.rows[0] - b.rows[0]),
      possible: groupsOf(entries.filter((e) => e.match === 'possible')).sort((a, b) => a.rows[0] - b.rows[0]),
      rest: cs.flatMap((c) => c.muso.filter((r) => r.in && !used.has(r.id)).map((r) => ({ c, r }))),
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
const gTicked = (p: Pending, g: Group) => g.entries.every((e) => ticked(p, e))
const gLocked = (g: Group) => g.entries.every(locked)
export const toCheck = (p: Pending, f: Family) => [...f.exact, ...f.possible].filter((g) => !gTicked(p, g)).length
/** A song name's exact and possible matches not ticked yet. */
export const openOf = (p: Pending, f: Family) => ({ exact: f.exact.filter((g) => !gTicked(p, g)).length, possible: f.possible.filter((g) => !gTicked(p, g)).length })

/** Every LNV row the Songs list matched – exact and possible – as a song a "Not in the LNV" song can be mapped onto:
 *  linked to that row (the same song), or joined to its song as a version. */
export function songTargets(fs: Family[]): Target[] {
  const out = new Map<number, Target>()
  for (const f of fs) {
    for (const g of [...f.exact, ...f.possible]) {
      const e = g.entries.find((x) => !x.v) ?? g.entries[0]
      const to = e.c.muso[0]?.id
      if (to == null || e.c.muso[0].moved) continue
      const isrcs = [...new Set([...list(g.lnv.fields.ISRC), ...g.recs.flatMap((r) => list(r.fields.ISRC))])]
      g.rows.forEach((row) => {
        if (!out.has(row)) out.set(row, { c: e.c, row, to, title: value(g.lnv.fields.Title) || f.title, film: value(g.lnv.fields['Film / album']),
          writers: writersOf(g.lnv).join(', '), isrcs, match: g.match, family: f.title })
      })
    }
  }
  return [...out.values()].sort((a, b) => a.title.localeCompare(b.title) || a.row - b.row)
}

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

function tickGroup(p: Pending, g: Group, on: boolean, saved: Step1['picks']): Pending {
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
    out.push(...(rows.length ? itemsOf(c, { ...draftOf(c, picks), choice: 'same', rows }) : itemsOf(c, null)))
  }
  // a value on a row no song here owns (a version the LNV has): the DSP's when one of its recordings holds it, else typed
  const recsOf = (row: number) => d.cases.flatMap((c) => [...(c.lnv.some((r) => r.row === row) ? c.muso : []), ...(c.in_lnv ?? []).filter((v) => v.row === row).map((v) => v.muso)])
  Object.entries(p.picks).forEach(([k, v]) => { if (!handled.has(k)) out.push(v == null ? { key: k, choice: null } : pickItem(k, v, recsOf(Number(k.split(':')[1])))) })
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

/** A recording's title line: the recording, the LNV title where it lands, and the title it keeps when nothing is chosen. */
type Line = { id: number; muso: string; lnv?: string; label?: string; def: TitleMode }

export function FamilyView({ f, d, p, set, pos, total, prev, next, wideBtn, targets, commit, toast }: {
  f: Family; d: Step1; p: Pending; set: (fn: (p: Pending) => Pending) => void
  pos: number; total: number; prev: () => void; next: () => void; wideBtn: ReactNode
  targets: Target[]
  /** save the queue now, with these decisions after it */
  commit: (items: CleanDecisionIn[]) => Promise<boolean>
  toast: (text: string, tone?: 'good' | 'bad') => void
}) {
  const source = d.source
  const [opened, setOpened] = useState<number | null>(null)   // the recording whose details are open (index in f.recs)
  const [openedRow, setOpenedRow] = useState<number | null>(null)
  const [mapping, setMapping] = useState<{ c: ReviewCase; rec: CaseRecord; recs: CaseRecord[] } | null>(null)
  const [asking, setAsking] = useState<string | null>(null)   // the entry whose "Not a match" choices are open
  const [busy, setBusy] = useState(false)
  const [mainOpen, setMainOpen] = useStored('mrm-main-open', true)   // the main version's details, folded to one line
  const across = useAcross(f.id)   // the exact matches scrolled across: drag, ← →, the arrow buttons
  useKeys({ arrowdown: next, j: next, arrowup: prev, k: prev })

  const cards = [...f.exact, ...f.possible]
  const entries = cards.flatMap((g) => g.entries)
  const rows = [...new Set(cards.flatMap((g) => g.rows))].sort((a, b) => a - b)   // the LNV row popup's ← →, in row order
  const openRec = (r: CaseRecord) => { const i = f.recs.findIndex((x) => x.id === r.id); if (i >= 0) setOpened(i) }
  const main = f.main
  const plainMain = plainness(main) < 2
  const rowsLabel = (g: Group) => `LNV row${g.rows.length > 1 ? 's' : ''} ${g.rows.join(', ')}`

  // ---- titles: one line per recording that goes into the LNV
  const lines = new Map<number, Line>()
  entries.forEach((e) => {
    if (e.tr.id == null || lines.has(e.tr.id)) return
    const earlier = d.picks[pickKey(e.row, 'Title')] !== undefined   // a title taken from the DSP before stays the DSP's
    lines.set(e.tr.id, { id: e.tr.id, muso: value(e.tr.fields.Title), lnv: value(e.lnv.fields.Title) || undefined, label: `LNV row ${e.row}`, def: earlier ? 'muso' : 'lnv' })
  })
  f.rest.forEach(({ r }) => { if (r.id != null && !lines.has(r.id)) lines.set(r.id, { id: r.id, muso: value(r.fields.Title), def: 'muso' }) })
  const mainLine: Line = (main.id != null && lines.get(main.id)) || { id: main.id ?? -1, muso: value(main.fields.Title), def: 'muso' }
  const choiceOf = (id: number) => (String(id) in p.titles ? p.titles[String(id)] : d.titles?.[String(id)]) ?? undefined
  const modeOf = (l: Line): TitleMode => choiceOf(l.id)?.mode ?? l.def
  const finalOf = (l: Line, mode: TitleMode = modeOf(l), text?: string): string =>
    mode === 'muso' ? l.muso : mode === 'lnv' ? l.lnv ?? l.muso : mode === 'custom' ? text ?? choiceOf(l.id)?.value ?? l.muso
      : l.id === mainLine.id ? l.muso : finalOf(mainLine)
  const fromOf = (l: Line) => {
    const m = modeOf(l)
    return m === 'main' ? 'Same as main version' : m === 'muso' ? `From ${source}` : m === 'lnv' ? `From ${l.label ?? 'the LNV'}` : 'Typed by you'
  }
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
    return <TitlePick key={`${l.id}-${modeOf(l)}`} line={l} mode={modeOf(l)} final={finalOf(l)} from={fromOf(l)} isMain={ls.some((x) => x.id === mainLine.id)}
      mainTitle={finalOf(mainLine)} source={source} choose={(m, t) => chooseTitle(ls, m, t)} map={map} />
  }

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
    if (ok) toast(songs.size ? `“${g.entries[0].c.title}” is added as a new row – it is under “Not in the LNV” now` : `“${value(g.recs[0].fields.Title)}” gets a row of its own in the LNV`, 'good')
  }
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
          <button type="button" className="rv-text-btn" onClick={() => setAsking(null)}>Cancel</button>
        </div>
        <small className="muted">{g.entries.every((x) => x.v) ? `${g.recs.length > 1 ? `These ${g.recs.length} recordings leave` : 'This version leaves'} ${rowsLabel(g)}.`
          : `“${e.c.title}”${others > 0 ? ` and its ${others} other version${others > 1 ? 's' : ''}` : ''} leave${others > 0 ? '' : 's'} this song at once.`}</small>
      </div>
    ) : <button type="button" className="rv-text-btn nm-open" onClick={() => setAsking(g.key)}><X size={14} />Not {what}</button>
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
  const mark = (fl: string, v: string[], from: CaseRecord) => from !== main && v.length > 0 && differs(fl, list(main.fields[fl]), v)
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
          {todo > 0 && <span className="fam-count todo">{n(todo)} to check</span>}
          {f.cases.length > 1 && <span className="muted">{n(f.cases.length)} {source} songs under this name</span>}
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
              <div key={fl}><dt>{fl}</dt><dd className={fl === 'ISRC' ? 'mono' : ''} title={value(main.fields[fl])}>{value(main.fields[fl]) || <span className="muted">—</span>}</dd></div>
            ))}
            {hasLink([main]) && <div><dt>Link</dt><dd><Links urls={[main.link]} /></dd></div>}
          </dl>}
        </section>

        <Guide id="family" title="How to check a song" steps={[
          <>On top: the song's <b>main version</b> – the oldest {source} recording with no remix, lofi or other tag. Everything is compared with it; what differs is yellow.</>,
          <><b>Exact match</b>: scroll across. Tick <b>Yes, exact match</b> on each one that is right and pick its title in the last row.</>,
          <><b>Possible match</b>: where {source} and the LNV differ, pick the value the LNV keeps, then tick <b>Same song</b>.</>,
          <>A wrong one? <b>Not a match</b> gives it a new row in the LNV, or maps it to another song.</>,
          <>Changes save by themselves; <b>Save</b> at the top saves them at once. <b>Saved to the LNV</b> has the download.</>,
        ]} />

        <section className="fam-sec" id="fam-exact">
          <header className="fam-sec-head">
            <div className="grow">
              <h4>Exact match : {n(f.exact.length)}</h4>
              <p>The same recording and the same work as an LNV row. Scroll across – drag the table, or use the ← → keys or buttons; the main version stays in place.</p>
            </div>
            {f.exact.length > 0 && (
              <span className="fx-nav">
                <button type="button" className="sm-nav" disabled={across.start} onClick={() => across.go(-1)} title="Scroll left (←)" aria-label="Scroll the exact matches left"><ChevronLeft size={18} /></button>
                <button type="button" className="sm-nav" disabled={across.end} onClick={() => across.go(1)} title="Scroll right (→)" aria-label="Scroll the exact matches right"><ChevronRight size={18} /></button>
              </span>
            )}
            {exactOpen.length > 1 && <button type="button" className="btn sm" onClick={() => tickAll(exactOpen)}><CheckCheck size={14} />Tick all {n(exactOpen.length)}</button>}
          </header>
          {!f.exact.length ? <p className="cv-none">No exact match for this song name.</p> : (
            <div className={`fx-wrap ${across.end && across.start ? '' : 'can'}`} ref={across.ref} onScroll={across.measure} onPointerDown={across.down}>
              <table className="fx">
                <thead>
                  <tr>
                    <th className="fx-f" />
                    <th className="fx-main"><span className="cv-badge muso">Main version</span><small className="muted">{source}</small></th>
                    {f.exact.map((g) => (
                      <th key={g.key} className={`fx-col ${gTicked(p, g) ? 'on' : ''}`}>
                        <span className="gr-rows">{g.rows.map((row) => (
                          <button key={row} type="button" className="cv-badge lnv cv-rowbtn" onClick={() => setOpenedRow(row)} title="See this LNV row">LNV row {row}<ChevronRight size={14} /></button>))}</span>
                        {g.rows.length > 1 && <small className="gr-same">The same data in each of these rows</small>}
                        {recsLine(g, 'fx-rec')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {FIELDS.map((fl) => (
                    <tr key={fl}>
                      <th className="fx-f">{fl}</th>
                      <td className={`fx-main ${fl === 'ISRC' ? 'mono' : ''} ${fl === 'Title' ? 'fx-t' : ''}`}>{value(main.fields[fl]) || <span className="muted">—</span>}</td>
                      {f.exact.map((g) => {
                        const lv = list(g.lnv.fields[fl]), mvs = variants(fl, g.recs)
                        const other = mvs.filter((v) => differs(fl, v, lv))
                        // every field but the title (it has its own row): the LNV's, the DSP's, or typed
                        if (PICK_SHOWN.includes(fl)) {
                          const taken = pickOf(pickKey(g.rows[0], fl))
                          const now = taken !== undefined ? list(taken) : lv.length ? lv : mvs[0] ?? []
                          return (
                            <td key={g.key} className={`${mark(fl, now, g.recs[0]) ? 'fx-dm' : ''} ${fl === 'ISRC' ? 'mono' : ''}`}>
                              <FieldChoice key={`${fl}-${JSON.stringify(taken ?? null)}`} fl={fl} lv={lv} mvs={mvs} taken={taken} source={source} pick={(v) => choosePick(g, fl, v)} />
                            </td>
                          )
                        }
                        return (
                          <td key={g.key} className={`${mark(fl, lv.length ? lv : mvs[0] ?? [], g.recs[0]) ? 'fx-dm' : ''} ${fl === 'ISRC' ? 'mono' : ''} ${fl === 'Title' ? 'fx-t' : ''}`}>
                            {lv.length ? lv.join(', ') : mvs.length ? <span className="fx-fill">{mvs.map((v) => v.join(', ')).join(' / ')}<small>blank in the LNV – {source}'s fills it</small></span> : <span className="muted">—</span>}
                            {lv.length > 0 && other.length > 0 && <small className="fx-other">{source}: {other.map((v) => v.join(', ')).join(' / ')}</small>}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  {/* the song's links (a Spotify track …) – from the LNV's website or Spotify ID, and from the DSP */}
                  {hasLink([main, ...f.exact.flatMap((g) => [g.lnv, ...g.recs])]) && (
                    <tr className="fx-link">
                      <th className="fx-f">Link</th>
                      <td className="fx-main"><Links urls={[main.link]} /></td>
                      {f.exact.map((g) => <td key={g.key}><Links urls={[g.lnv.link]} from="LNV" /><Links urls={g.recs.map((r) => r.link)} from={source} />
                        {!hasLink([g.lnv, ...g.recs]) && <span className="muted">—</span>}</td>)}
                    </tr>
                  )}
                  <tr className="fx-title">
                    <th className="fx-f">Title in the LNV</th>
                    <td className="fx-main"><b>{finalOf(mainLine)}</b></td>
                    {f.exact.map((g) => <td key={g.key}>{titlePick(g.trs.map((r) => r.id), () => mapCard(g))}</td>)}
                  </tr>
                  {/* the answer, one row each: the ticks side by side, then "not a match" */}
                  <tr className="fx-yes">
                    <th className="fx-f">Exact match?</th>
                    <td className="fx-main" />
                    {f.exact.map((g) => <td key={g.key} className={gTicked(p, g) ? 'on' : ''}>{tickBox(g, 'Yes, exact match')}{hintOf(g) && <small className="fx-hint">{hintOf(g)}</small>}</td>)}
                  </tr>
                  <tr className="fx-act">
                    <th className="fx-f" />
                    <td className="fx-main" />
                    {f.exact.map((g) => <td key={g.key}>{notMatch(g, 'an exact match')}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="fam-sec" id="fam-possible">
          <header className="fam-sec-head">
            <div className="grow">
              <h4>Possible match : {n(f.possible.length)}</h4>
              <p>Only part of it matches – the recording or the work. Each one is compared with the main version above: pick the value the LNV keeps where {source} and the LNV differ. One card per LNV row: every {source} recording matched to it is on it.</p>
              <p className="fam-legend"><span><i className="fam-sw dm" />differs from the main version</span><span><i className="fam-sw two" /><b>pick one</b> – {source} and the LNV differ: the one picked goes into the LNV</span></p>
            </div>
          </header>
          {!f.possible.length ? <p className="cv-none">No possible match for this song name.</p> : f.possible.map((g) => {
            const on = gTicked(p, g)
            const e = g.entries[0]
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
                  {e.v ? (
                    <div className="cv-checks">
                      <b className="cv-level warn">A version the LNV has</b>
                      {([['isrc', 'ISRC'], ['album', 'album'], ['year', 'year']] as const).map(([k, label]) => (
                        <span key={k} className={e.v![k] ? 'good' : 'bad'}>{e.v![k] ? <Check size={13} /> : <X size={13} />}{e.v![k] ? 'Same' : 'Other'} {label}</span>))}
                    </div>
                  ) : <Checks r={e.lnv} />}
                </div>
                <table className="pc-t">
                  <thead><tr><th /><th className="muso">{source}{g.recs.length > 1 ? ` – ${g.recs.length} recordings` : ''}</th><th className="lnv">{rowsLabel(g)}</th></tr></thead>
                  <tbody>
                    {shown.map((fl) => {
                      const lv = list(g.lnv.fields[fl]), mvs = variants(fl, g.recs)
                      // the DSP values that differ from the LNV's: one choice each, the LNV's the other
                      const opts = PICK_SHOWN.includes(fl) && lv.length ? mvs.filter((v) => differs(fl, v, lv)) : []
                      const two = opts.length > 0
                      const taken = pickOf(pickKey(g.rows[0], fl))
                      const at = taken === undefined ? -1 : opts.findIndex((v) => same(list(taken), v))
                      const typed = PICK_SHOWN.includes(fl) && taken !== undefined && at < 0 && !mvs.some((v) => same(list(taken), v)) ? list(taken) : null
                      const keep: Keep = typed ? 'custom' : taken !== undefined ? 'muso' : lv.length ? 'lnv' : mvs.length ? 'muso' : 'blank'
                      const opt = (v: string[], on: boolean, pick: string[] | null, key: string) => (
                        <label key={key} className={`pc-opt ${on ? 'on' : ''}`}>
                          <input type="radio" name={`${g.key}-${fl}`} checked={on} onChange={() => choosePick(g, fl, pick)} />
                          <span>{v.join(', ')}</span>{on && <small>goes into the LNV</small>}
                        </label>
                      )
                      const tone = (v: string[], from: CaseRecord) => `${mark(fl, v, from) ? 'fx-dm' : ''} ${fl === 'ISRC' ? 'mono' : ''} ${fl === 'Title' ? 'fx-t' : ''}`
                      return (
                        <tr key={fl} className={`${two ? 'two' : ''} ${typed ? 'typed' : ''}`}>
                          <th>{fl}{PICK_SHOWN.includes(fl) && <KeepChip keep={keep} source={source} />}{two && <small>pick one</small>}</th>
                          <td className={tone(mvs[0] ?? [], g.recs[0])}>
                            {two ? <div className="pc-opts">{opts.map((v, i) => opt(v, i === at, v, String(i)))}
                              {opts.length < mvs.length && <small className="muted">{n(mvs.length - opts.length)} more with the LNV's value</small>}</div>
                              : mvs.length ? mvs.map((v, i) => <div key={i}>{v.join(', ')}</div>) : <span className="muted">—</span>}
                          </td>
                          <td className={tone(lv, g.lnv)}>
                            {two && opt(lv, taken === undefined, null, 'lnv')}
                            {/* every field edited in place: the pencil (or a click on the value) types the value the LNV keeps */}
                            {PICK_SHOWN.includes(fl) ? <EditPick key={`${g.key}-${fl}-${JSON.stringify(typed)}`} fl={fl} radio={two} typed={typed}
                              shown={lv.length ? lv : mvs[0] ?? []} note={!lv.length && mvs.length ? `blank in the LNV – ${source}'s fills it` : null}
                              start={taken !== undefined ? list(taken) : lv.length ? lv : mvs[0] ?? []} save={(v) => choosePick(g, fl, v)} />
                              : !two && (lv.length ? lv.join(', ') : mvs.length ? <span className="fx-fill">blank – {source}'s fills it</span> : <span className="muted">—</span>)}
                          </td>
                        </tr>
                      )
                    })}
                    {hasLink([g.lnv, ...g.recs]) && <tr className="pc-link"><th>Link</th><td><Links urls={g.recs.map((r) => r.link)} /></td><td><Links urls={[g.lnv.link]} /></td></tr>}
                    <tr className="pc-title-row"><th>Title in the LNV</th><td colSpan={2}>{titlePick(g.trs.map((r) => r.id), () => mapCard(g))}</td></tr>
                    {/* the answer at the bottom, as in the exact matches: the tick, then "not a match" */}
                    <tr className="pc-yes"><th>Same song?</th><td colSpan={2} className={on ? 'on' : ''}>{tickBox(g, 'Yes, same song')}{hintOf(g) && <small className="fx-hint">{hintOf(g)}</small>}</td></tr>
                    <tr className="pc-act"><th /><td colSpan={2}>{notMatch(g, 'a possible match')}</td></tr>
                  </tbody>
                </table>
              </article>
            )
          })}
        </section>

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
                  {titlePick([r.id], () => setMapping({ c, rec: r, recs: c.muso.filter((x) => x.in) }))}
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
    </div>
  )
}

/** The exact matches scrolled across: hold the mouse on the table and drag, the ← → keys (while not typing and no
 *  popup is open, with the table on screen), or the arrow buttons – one column at a time. */
function useAcross(reset: string) {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ start: true, end: true })
  const measure = () => {
    const w = ref.current
    if (w) setEdge({ start: w.scrollLeft <= 1, end: w.scrollLeft + w.clientWidth >= w.scrollWidth - 1 })
  }
  const go = (dir: number) => {
    const w = ref.current
    if (!w) return
    const col = w.querySelector<HTMLElement>('.fx-col')?.offsetWidth ?? 280
    w.scrollBy({ left: dir * col, behavior: 'smooth' })
  }
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = 0
    measure()
    const w = ref.current
    const ro = w ? new ResizeObserver(measure) : null
    if (w && ro) { ro.observe(w); const t = w.querySelector('table'); if (t) ro.observe(t) }
    return () => ro?.disconnect()
  }, [reset])
  const goRef = useRef(go)
  goRef.current = go
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.drawer, .modal')) return
      const t = e.target as HTMLElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return
      const w = ref.current
      if (!w || w.scrollWidth <= w.clientWidth) return
      const r = w.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) return   // the table is not on screen
      e.preventDefault()
      goRef.current(e.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // hold and drag: a press on a button, a tick, a choice or a text field stays a click
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const w = ref.current
    if (!w || e.button !== 0 || e.pointerType === 'touch' || w.scrollWidth <= w.clientWidth) return
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

/** The title one recording gets in the LNV: same as the main version, the DSP's, the LNV's, typed – or map it. */
function TitlePick({ line, mode, final, from, isMain, mainTitle, source, choose, map }: {
  line: Line; mode: TitleMode; final: string; from: string; isMain: boolean; mainTitle: string; source: string
  choose: (mode: TitleMode, text?: string) => void; map: () => void
}) {
  const [typing, setTyping] = useState<string | null>(null)
  const options: DropOption<TitleMode | 'map'>[] = [
    ...(!isMain ? [{ value: 'main' as const, label: 'Same as main version', hint: mainTitle }] : []),
    { value: 'muso', label: <KeepOption keep="muso" tag={source} text={`Keep ${source}'s title${line.def === 'muso' ? ' (as is)' : ''}`} />, hint: line.muso },
    ...(line.lnv ? [{ value: 'lnv' as const, label: <KeepOption keep="lnv" tag="LNV" text={`Keep the LNV's title${line.def === 'lnv' ? ' (as is)' : ''}`} />, hint: line.lnv }] : []),
    { value: 'custom', label: <KeepOption keep="custom" tag="Custom" text="Customise – type it" />, hint: mode === 'custom' ? final : 'Type the title for the LNV', sep: true },
    { value: 'map', label: 'Map to another song…', hint: 'It is a version of another song in the LNV' },
  ]
  return (
    <div className="tp">
      <Dropdown className="tp-dd" value={mode} options={options} label="Title in the LNV" menuWidth={300}
        onChange={(m) => { if (m === 'map') map(); else if (m === 'custom') setTyping(final); else choose(m) }} />
      {typing != null
        ? <EditBox initial={typing} label="Title for the LNV" placeholder="Type the title for the LNV"
          done={(t) => { setTyping(null); if (t && t !== final) choose('custom', t) }} />
        : <EditLine label="title" edit={() => setTyping(final)}><b>{final}</b><span className={`cv-from ${mode}`}>{from}</span></EditLine>}
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

/** Which value a field keeps in the LNV: the LNV's own, the DSP's (picked, or filling a blank), typed, or blank. */
type Keep = 'lnv' | 'muso' | 'custom' | 'blank'
const keepText = (k: Keep, source: string) => k === 'lnv' ? 'LNV' : k === 'muso' ? source : k === 'custom' ? 'Customised' : 'Blank'

/** A small chip: "Keeps LNV" · "Keeps Muso" · "Keeps Customised". */
function KeepChip({ keep, source }: { keep: Keep; source: string }) {
  return <span className={`keep-chip ${keep}`} title={`The LNV keeps ${keep === 'custom' ? 'the value typed by you' : keep === 'blank' ? 'nothing – blank' : `${keepText(keep, source)}'s value`}`}>
    <i aria-hidden />Keeps {keepText(keep, source)}</span>
}

/** An option of the "keep" dropdown: its source as a coloured tag, then what it does. */
const KeepOption = ({ keep, tag, text }: { keep: Keep; tag: string; text: string }) =>
  <span className="keep-opt"><i className={`keep-tag ${keep}`}>{tag}</i>{text}</span>

/** A field's value with its pencil (see EditLine). */
const EditValue = ({ fl, value: v, note, edit }: { fl: string; value: string[]; note?: string | null; edit: () => void }) => (
  <EditLine label={fl.toLowerCase()} edit={edit}>{v.length ? v.join(', ') : <span className="muted">—</span>}{note && <small className="fx-fill-note">{note}</small>}</EditLine>
)

/** One field of an exact match as it goes into the LNV: the value – edited in place with its pencil – and under it a
 *  dropdown saying what the LNV keeps: the LNV's own value, the DSP's, or a customised (typed) one. With the LNV
 *  blank, the DSP's value fills it unless another is chosen. */
function FieldChoice({ fl, lv, mvs, taken, source, pick }: {
  fl: string; lv: string[]; mvs: string[][]; taken?: string | string[]; source: string; pick: (v: string[] | null) => void
}) {
  const [typing, setTyping] = useState<string | null>(null)
  const opts = lv.length ? mvs.filter((v) => differs(fl, v, lv)) : mvs
  const at = taken === undefined ? -1 : opts.findIndex((v) => same(list(taken), v))
  const mode = taken === undefined ? (lv.length ? 'lnv' : mvs.length ? 'm0' : 'blank') : at >= 0 ? `m${at}` : 'custom'
  const now = taken !== undefined ? list(taken) : lv.length ? lv : mvs[0] ?? []
  const fills = !lv.length && mode === 'm0'
  const keep: Keep = mode === 'lnv' ? 'lnv' : mode === 'custom' ? 'custom' : mode === 'blank' ? 'blank' : 'muso'
  const options: DropOption[] = [
    ...(lv.length ? [{ value: 'lnv', label: <KeepOption keep="lnv" tag="LNV" text="Keep the LNV's value" />, hint: lv.join(', ') }]
      : !mvs.length ? [{ value: 'blank', label: <KeepOption keep="blank" tag="—" text="Leave it blank" /> }] : []),
    ...opts.map((v, i) => ({ value: `m${i}`, label: <KeepOption keep="muso" tag={source} text={!lv.length && i === 0 ? `Keep ${source}'s – fills the blank` : `Keep ${source}'s value`} />, hint: v.join(', ') })),
    { value: 'custom', label: <KeepOption keep="custom" tag="Custom" text="Customise – type it" />, hint: mode === 'custom' ? now.join(', ') : `Type the ${fl.toLowerCase()} yourself`, sep: true },
  ]
  const choose = (m: string) => {
    if (m === 'custom') setTyping(now.join(', '))
    else if (m === 'lnv' || m === 'blank' || (!lv.length && m === 'm0')) pick(null)
    else pick(opts[Number(m.slice(1))])
  }
  return (
    <div className={`fc ${mode === 'custom' ? 'typed' : ''}`}>
      <Dropdown className="fc-dd" tone={keep === 'blank' ? '' : keep} value={mode} options={options} label={`What the LNV keeps for ${fl}`} menuWidth={290}
        shown={<><i className="dd-dot" />Keep: {keepText(keep, source)}</>} onChange={choose} />
      {typing != null ? <TypeIn fl={fl} initial={typing} now={now} done={(v) => { setTyping(null); if (v) pick(v) }} />
        : <EditValue fl={fl} value={now} note={fills ? `blank in the LNV – ${source}'s fills it` : null} edit={() => setTyping(now.join(', '))} />}
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
