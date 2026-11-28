import { isrcsOf, pipe } from './editModel'
import type { CleanDecisionIn } from '../../lib/api'
import type { ReviewCase, Step1, TypedData, TypedPerson } from '../../types'
import { list } from './Block'
import { value, writersOf } from './CaseParts'
import { NO_PENDING, gTicked, pendingItems, tickGroup } from './Families'
import type { Family, Group, Pending } from './Families'

/** "Add a song": the songs of the sheets a song can take – another song name's exact and possible matches, the songs
 *  not in the LNV – what adding one saves, and the check of a song typed by hand. No React here: unit-tested in Node. */

export type Pick = {
  key: string; kind: 'exact' | 'possible' | 'new'; c: ReviewCase; g?: Group; title: string; from: string
  film: string; writers: string; isrcs: string[]; rows: number[]; checked: boolean
}

export function picksFor(f: Family, families: Family[], loose: ReviewCase[], p: Pending): Pick[] {
  const out: Pick[] = []
  for (const x of families) {
    if (x.id === f.id) continue
    for (const g of x.groups) {
      const e = g.entries.find((y) => !y.v) ?? g.entries[0]
      if (!e.c.answer.song) continue
      out.push({ key: `${x.id}|${g.key}`, kind: g.match, c: e.c, g, title: value(g.lnv.fields.Title) || value(g.recs[0].fields.Title), from: x.title,
        film: value(g.lnv.fields['Film / album']), writers: writersOf(g.lnv).join(', '),
        isrcs: [...new Set([...list(g.lnv.fields.ISRC), ...g.recs.flatMap((r) => list(r.fields.ISRC))])], rows: g.rows, checked: gTicked(p, g) })
    }
  }
  for (const c of loose) {
    const r = c.muso[0]
    if (!r || r.id == null || !c.answer.song) continue
    out.push({ key: `n|${c.id}`, kind: 'new', c, title: c.title, from: c.title, film: value(r.fields['Film / album']), writers: writersOf(r).join(', '),
      isrcs: list(r.fields.ISRC), rows: [], checked: false })
  }
  return out.sort((a, b) => a.title.localeCompare(b.title) || (a.rows[0] ?? 0) - (b.rows[0] ?? 0))
}

/** The song of a song name others are added to: its own (not one added to it), in its own place in the LNV. */
export const homeOf = (f: Family): ReviewCase | null => f.cases.find((c) => !c.joined && c.answer.song && c.muso[0]?.id != null && !c.muso[0].moved) ?? null

/** What adding a pick to a song saves: a match joins its song name with its LNV row, checked; a song not in the LNV
 *  becomes versions of it. */
export function addItems(pick: Pick, f: Family, d: Step1): CleanDecisionIn[] {
  const home = homeOf(f)
  if (!home) return []
  if (pick.kind === 'new' || !pick.g) {
    const row = home.answer.rows?.[0] ?? f.exact[0]?.rows[0] ?? f.groups[0]?.rows[0]
    return pick.c.muso.filter((r) => r.in && r.id != null && r.id !== home.muso[0].id)
      .map((r) => ({ key: `map:${r.id}`, choice: 'join' as const, data: { to: home.muso[0].id!, row, title: f.title, from: pick.c.title } }))
  }
  const songs = [...new Map(pick.g.entries.filter((e) => e.c.answer.song && !f.cases.some((c) => c.id === e.c.id)).map((e) => [e.c.answer.song!, e.c])).values()]
  return [...songs.map((c) => ({ key: `family:${c.answer.song}`, choice: 'join' as const, data: { to: home.answer.song, title: f.title, from: c.title } })),
    ...pendingItems(tickGroup(NO_PENDING, pick.g, true, d.picks), d)]
}

/* ---------- a song typed by hand ---------- */

export const GROUPS: { id: keyof TypedData['people']; label: string; must: boolean }[] = [
  { id: 'composers', label: 'Composer', must: true }, { id: 'authors', label: 'Lyricist', must: true },
  { id: 'singers', label: 'Singer', must: false }, { id: 'publishers', label: 'Publisher', must: false }]
export const blankPerson = (): TypedPerson => ({ name: '', ipi: '', joshua: '', perf: '', mech: '' })
export const blankSong = (to: string, toTitle: string): TypedData => ({ title: '', album: '', isrc: '', links: [''], to, to_title: toTitle,
  people: { composers: [blankPerson()], authors: [blankPerson()], singers: [blankPerson()], publishers: [blankPerson()] }, more: {} })

/** The ISRC of a typed song – or several, with a pipe between them. */
export const isrcOf = (t: string) => pipe(isrcsOf(t).isrcs)
const digits = (t: string) => t.replace(/[\s.]/g, '')

/** What is missing or wrong, per field – the same rules as the server's (engine/typed.py). */
export function problems(t: TypedData): Record<string, string> {
  const out: Record<string, string> = {}
  if (!t.title.trim()) out.title = 'Title is required'
  if (!t.album.trim()) out.album = 'Album is required'
  if (!t.isrc.trim()) out.isrc = 'ISRC is required'
  else if (!isrcOf(t.isrc) || isrcsOf(t.isrc).wrong.length) out.isrc = 'ISRC must be 12 characters, e.g. INH100510220'
  const links = t.links.map((x) => x.trim()).filter(Boolean)
  const badLink = links.find((x) => !/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(x))
  if (badLink) out.links = `Not a link: ${badLink.slice(0, 60)}`
  else if (!links.length) out.links = 'At least one song link is required'
  for (const g of GROUPS) {
    for (const p of t.people[g.id]) {
      const name = p.name.trim(), ipi = digits(p.ipi)
      if (!name && !ipi) continue
      if (!name) out[g.id] = `${g.label}: a CAE / IPI number has no name`
      else if (ipi && !/^\d{8,11}$/.test(ipi)) out[g.id] = `${g.label} ${name}: the CAE / IPI number must be 8 to 11 digits`
      else if (!ipi && g.must) out[g.id] = `${g.label} ${name}: the CAE / IPI number is required`
      for (const s of [p.perf, p.mech]) if (String(s ?? '').trim() && !(Number(s) >= 0 && Number(s) <= 100)) out[g.id] = `${g.label} ${name}: a share must be a number from 0 to 100`
    }
  }
  if (![...t.people.composers, ...t.people.authors].some((p) => p.name.trim() || p.ipi.trim())) out.composers ??= 'At least one composer or lyricist with a CAE / IPI number is required'
  return out
}
