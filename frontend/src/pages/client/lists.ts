import type { ListSheet } from '../../lib/api'
import type { CaseRecord, ReviewCase, Step1, TypedSong } from '../../types'
import { list } from './Block'
import { value } from './CaseParts'
import { STATUS, gChecked, groupsIn, progressOf, variants } from './Families'
import { CLASS_NAME } from './matchModel'
import type { Family, Group, Pending, Solo } from './Families'
import { autoAlternative, labelOf, typedText } from './editModel'
import { fieldChoices } from './fieldModel'
import { PICK_SHOWN, pickKey } from './reviewModel'
import { remarkKey } from './remarkModel'
import { titleModel, titleOf } from './titles'
import { whenText } from './when'

/** The review screen's lists as Excel – the very rows its counts count. No React here: unit-tested in Node. */

export type ListId = 'status' | 'exact' | 'possible' | 'version' | 'todo' | 'done' | 'out' | 'new' | 'answer' | 'newrow' | 'deleted' | 'lnv_only' | 'all'
export type Lists = { families: Family[]; loose: ReviewCase[]; newRows: ReviewCase[]; deleted: ReviewCase[]; isDone: (c: ReviewCase) => boolean; d: Step1; p: Pending }

export const LIST_NAMES: Record<ListId, string> = {
  status: 'Song status', exact: 'Exact matches', possible: 'Possible matches', version: 'Other versions', todo: 'Left to check', done: 'Checked matches', out: 'Not a match', new: 'Not in the LNV',
  answer: 'Not in the LNV – needs an answer', newrow: 'New row', deleted: 'Deleted songs', lnv_only: 'Only in the LNV', all: 'Every list',
}

const groupsOf = (x: Lists) => x.families.flatMap((f) => groupsIn(f).map((g) => ({ f, g })))
function pick(x: Lists, id: ListId): { f: Family; g: Group }[] {
  return groupsOf(x).filter(({ g }) => id === 'exact' || id === 'possible' || id === 'version' ? g.cls === id : id === 'todo' ? !gChecked(x.p, g) : gChecked(x.p, g))
}
const typedOf = (x: Lists) => x.d.typed ?? []
/** The song's versions beside no LNV row – checked in their section like a match (v1.8). */
function solosIn(x: Lists, id: ListId): { f: Family; s: Solo }[] {
  return x.families.flatMap((f) => (f.solos ?? []).map((s) => ({ f, s })))
    .filter(({ s }) => id === 'exact' || id === 'possible' || id === 'version' ? s.cls === id : id === 'todo' ? !s.chosen : s.chosen)
}

/** How many rows a list has – the counts beside the choices. */
export function listCount(x: Lists, id: ListId): number {
  switch (id) {
    case 'status': return x.families.length
    case 'out': return x.families.reduce((t, f) => t + f.out.length, 0)
    case 'exact': case 'possible': case 'version': case 'todo': return pick(x, id).length + solosIn(x, id).length
    case 'done': return pick(x, 'done').length + solosIn(x, 'done').length + x.families.reduce((t, f) => t + f.typed.length, 0)
    case 'new': return x.loose.length
    case 'answer': return x.loose.filter((c) => !x.isDone(c)).length
    case 'newrow': return x.newRows.length + typedOf(x).length
    case 'deleted': return x.deleted.length
    case 'lnv_only': return x.d.lnv_only.length
    case 'all': return 0
  }
}

const MATCH_HEAD = (src: string) => ['Song name', 'Song status', 'Match', 'Status', 'LNV row', 'Main version', `${src} title`, 'LNV title', 'Title in the LNV',
  ...PICK_SHOWN.flatMap((f) => [`${labelOf(f)} – ${src}`, `${labelOf(f)} – LNV`, `${labelOf(f)} – LNV keeps`]), 'Remark']
export const CHECKED = 'Checked', LEFT = 'Left to check', NOT = 'Not a match'
/** What the LNV keeps in a field: the choice waiting or saved, else the default. */
function keptValue(d: Step1, p: Pending, fl: string, f: Family, g: Group): string {
  const k = pickKey(g.rows[0], fl)
  return typedText(fl, fieldChoices(fl, g, k in p.picks ? p.picks[k] ?? undefined : d.picks[k], d.source,
    fl === 'Alternate title' ? autoAlternative(titleOf(d, p, f, g), g.lnv, g.trs) : undefined).now)
}
const joined = (fl: string, vs: string[][]) => vs.map((v) => typedText(fl, v)).join(' / ')
const songStatus = (x: Lists, f: Family) => STATUS[progressOf(x.p, f).status]
function matchRow(x: Lists, f: Family, g: Group): (string | number)[] {
  return [f.title, songStatus(x, f), CLASS_NAME[g.cls], gChecked(x.p, g) ? CHECKED : LEFT, g.rows.length === 1 ? g.rows[0] : g.rows.join(', '),
    value(f.main.fields.Title), joined('Title', variants('Title', g.recs)), value(g.lnv.fields.Title), titleOf(x.d, x.p, f, g),
    ...PICK_SHOWN.flatMap((fl) => [fl === 'Alternate title' ? '' : joined(fl, variants(fl, g.recs)), typedText(fl, list(g.lnv.fields[fl])), keptValue(x.d, x.p, fl, f, g)]),
    remarksOf(x.d, g.recs)]
}
/** A version beside no LNV row: it gets a row of its own (or, in Exact match, goes into the exact row). */
function soloRow(x: Lists, f: Family, s: Solo): (string | number)[] {
  const r = s.r, t = titleModel(f, x.d, x.p), l = r.id != null ? t.lines.get(r.id) : undefined
  return [f.title, songStatus(x, f), CLASS_NAME[s.cls], s.chosen ? CHECKED : LEFT, s.cls === 'exact' ? 'into the exact row' : 'new row',
    value(f.main.fields.Title), value(r.fields.Title), '', l ? t.finalOf(l) : value(r.fields.Title),
    ...PICK_SHOWN.flatMap((fl) => [fl === 'Alternate title' ? '' : typedText(fl, list(r.fields[fl])), '', fl === 'Alternate title' ? '' : typedText(fl, list(r.fields[fl]))]),
    remarksOf(x.d, [r])]
}
/** A match turned down, as its song shows it. */
function outRow(x: Lists, f: Family, o: Family['out'][number]): (string | number)[] {
  return [f.title, songStatus(x, f), o.match === 'exact' ? 'Exact match' : 'Possible match', NOT, o.rows.length === 1 ? o.rows[0] : o.rows.join(', '), value(o.recs[0]?.fields.Title), value(o.lnv.fields.Title),
    value(o.lnv.fields['Film / album']), typedText('ISRC', list(o.lnv.fields.ISRC)), o.text]
}
/** One line per song name: how far it is, and when it was last changed. */
function statusRow(x: Lists, f: Family): (string | number)[] {
  const s = progressOf(x.p, f), at = x.d.updates?.songs[f.id]
  return [f.title, STATUS[s.status], s.total, s.done - f.out.length, f.out.length, s.left, f.exact.length, f.possible.length, f.version.length + f.solos.length, at ? whenText(at, true) : '']
}
const SONG_HEAD = (src: string) => ['Song', 'Versions', 'Film / album', 'Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC', 'Release year', 'Release date', `Link – ${src}`, 'Answer', 'Remark', 'Was LNV row', 'Why']
const ANSWER: Record<string, string> = { same: 'Same song', add: 'New row', not_ours: 'Not the client’s', deleted: 'Deleted' }
const remarksOf = (d: Step1, recs: CaseRecord[]) => [...new Set(recs.flatMap((r) => d.remarks?.[remarkKey(r)]?.name ?? []))].join('; ')
function songRow(d: Step1, c: ReviewCase, done: boolean): (string | number)[] {
  const m = c.muso[0]
  const all = (f: string) => [...new Set(c.muso.flatMap((r) => list(r.fields[f])))].join(f === 'ISRC' ? ' | ' : ', ')
  return [c.title, c.muso.length, value(m?.fields['Film / album']), all('Lyricist'), all('Composer'), all('Publisher'), all('Singer'), all('ISRC'), value(m?.fields.Year), value(m?.fields['Release date']), m?.link ?? '',
    c.answer.choice ? `${ANSWER[c.answer.choice] ?? c.answer.choice}${done ? '' : ' (the app’s answer, not confirmed)'}` : 'Needs an answer', remarksOf(d, c.muso), (c.was ?? []).map((r) => r.row).join(', '), c.why]
}
const typedRow = (t: TypedSong): (string | number)[] => {
  const r = t.record.fields
  return [t.data.title, 1, t.data.album, value(r.Lyricist), value(r.Composer), value(r.Publisher), value(r.Singer), t.data.isrc, value(r.Year), value(r['Release date']), t.data.links.join(' '), 'New row (typed)', '', '', `Added to “${t.to_title}”`]
}

export function sheetOf(x: Lists, id: Exclude<ListId, 'all'>): ListSheet {
  const src = x.d.source, name = LIST_NAMES[id]
  if (id === 'status') return { name, header: ['Song name', 'Status', 'Matches', 'Checked', 'Not a match', 'Left to check', 'Exact matches', 'Possible matches', 'Other versions', 'Last updated'],
    rows: [...x.families].sort((a, b) => a.title.localeCompare(b.title)).map((f) => statusRow(x, f)) }
  if (id === 'out') return { name, header: ['Song name', 'Song status', 'Match', 'Status', 'LNV row', `${src} title`, 'LNV title', 'Film / album – LNV', 'ISRC – LNV', 'What was decided'],
    rows: x.families.flatMap((f) => f.out.map((o) => outRow(x, f, o))) }
  if (id === 'exact' || id === 'possible' || id === 'version' || id === 'todo' || id === 'done') {
    const rows = [...pick(x, id).map(({ f, g }) => matchRow(x, f, g)), ...solosIn(x, id).map(({ f, s }) => soloRow(x, f, s))]
    if (id === 'done') for (const f of x.families) for (const t of f.typed) {
      const r = t.record.fields
      rows.push([f.title, songStatus(x, f), 'Typed – new row', CHECKED, '', value(f.main.fields.Title), '', '', t.data.title,
        ...PICK_SHOWN.flatMap((fl) => ['', '', fl === 'ISRC' ? t.data.isrc : fl === 'Link' ? t.data.links.join(' ') : value(r[fl])]), ''])
    }
    return { name, header: MATCH_HEAD(src), rows }
  }
  if (id === 'lnv_only') return { name, header: ['LNV row', 'Song', 'Film / album', 'Year', 'Writers'], rows: x.d.lnv_only.map((r) => [r.row, r.title, r.film, r.year, r.writers.join(', ')]) }
  const cs = id === 'new' ? x.loose : id === 'answer' ? x.loose.filter((c) => !x.isDone(c)) : id === 'newrow' ? x.newRows : x.deleted
  const rows = [...cs].sort((a, b) => a.title.localeCompare(b.title)).map((c) => songRow(x.d, c, x.isDone(c)))
  return { name, header: SONG_HEAD(src), rows: id === 'newrow' ? [...rows, ...typedOf(x).map(typedRow)] : rows }
}
export const EACH: Exclude<ListId, 'all'>[] = ['status', 'exact', 'possible', 'version', 'todo', 'done', 'out', 'new', 'answer', 'newrow', 'deleted', 'lnv_only']
export const sheetsOf = (x: Lists, id: ListId): ListSheet[] => id === 'all' ? EACH.map((k) => sheetOf(x, k)) : [sheetOf(x, id)]
