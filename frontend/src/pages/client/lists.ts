import type { ListSheet } from '../../lib/api'
import type { CaseRecord, ReviewCase, Step1, TypedSong } from '../../types'
import { list } from './Block'
import { value } from './CaseParts'
import { gTicked, variants } from './Families'
import type { Family, Group, Pending } from './Families'
import { fieldChoices } from './fieldModel'
import { PICK_SHOWN, pickKey } from './reviewModel'
import { remarkKey } from './remarkModel'
import { titleOf } from './titles'

/** The review screen's lists as Excel – the very rows its counts count. No React here: unit-tested in Node. */

export type ListId = 'exact' | 'possible' | 'todo' | 'done' | 'new' | 'answer' | 'newrow' | 'deleted' | 'lnv_only' | 'all'
export type Lists = { families: Family[]; loose: ReviewCase[]; newRows: ReviewCase[]; deleted: ReviewCase[]; isDone: (c: ReviewCase) => boolean; d: Step1; p: Pending }

export const LIST_NAMES: Record<ListId, string> = {
  exact: 'Exact matches', possible: 'Possible matches', todo: 'Left to check', done: 'Checked matches', new: 'Not in the LNV',
  answer: 'Not in the LNV – needs an answer', newrow: 'New row', deleted: 'Deleted songs', lnv_only: 'Only in the LNV', all: 'Every list',
}

const groupsOf = (x: Lists) => x.families.flatMap((f) => [...f.exact, ...f.possible].map((g) => ({ f, g })))
function pick(x: Lists, id: ListId): { f: Family; g: Group }[] {
  return groupsOf(x).filter(({ g }) => id === 'exact' ? g.match === 'exact' : id === 'possible' ? g.match === 'possible' : id === 'todo' ? !gTicked(x.p, g) : gTicked(x.p, g))
}
const typedOf = (x: Lists) => x.d.typed ?? []

/** How many rows a list has – the counts beside the choices. */
export function listCount(x: Lists, id: ListId): number {
  switch (id) {
    case 'exact': case 'possible': case 'todo': return pick(x, id).length
    case 'done': return pick(x, 'done').length + x.families.reduce((t, f) => t + f.typed.length, 0)
    case 'new': return x.loose.length
    case 'answer': return x.loose.filter((c) => !x.isDone(c)).length
    case 'newrow': return x.newRows.length + typedOf(x).length
    case 'deleted': return x.deleted.length
    case 'lnv_only': return x.d.lnv_only.length
    case 'all': return 0
  }
}

const MATCH_HEAD = (src: string) => ['Song name', 'Match', 'Checked', 'LNV row', 'Main version', `${src} title`, 'LNV title', 'Title in the LNV',
  ...PICK_SHOWN.flatMap((f) => [`${f} – ${src}`, `${f} – LNV`, `${f} – LNV keeps`]), `Link – ${src}`, 'Link – LNV', 'Remark']
/** What the LNV keeps in a field: the choice waiting or saved, else the default. */
function keptValue(d: Step1, p: Pending, fl: string, g: Group): string {
  const k = pickKey(g.rows[0], fl)
  return fieldChoices(fl, g, k in p.picks ? p.picks[k] ?? undefined : d.picks[k], d.source).now.join(', ')
}
const joined = (vs: string[][]) => vs.map((v) => v.join(', ')).join(' / ')
function matchRow(x: Lists, f: Family, g: Group): (string | number)[] {
  return [f.title, g.match === 'exact' ? 'Exact match' : 'Possible match', gTicked(x.p, g) ? 'Yes' : 'No', g.rows.length === 1 ? g.rows[0] : g.rows.join(', '),
    value(f.main.fields.Title), joined(variants('Title', g.recs)), value(g.lnv.fields.Title), titleOf(x.d, x.p, f, g),
    ...PICK_SHOWN.flatMap((fl) => [joined(variants(fl, g.recs)), value(g.lnv.fields[fl]), keptValue(x.d, x.p, fl, g)]),
    [...new Set(g.recs.map((r) => r.link).filter(Boolean))].join(' '), g.lnv.link ?? '', remarksOf(x.d, g.recs)]
}
const SONG_HEAD = (src: string) => ['Song', 'Versions', 'Film / album', 'Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC', 'Year', `Link – ${src}`, 'Answer', 'Remark', 'Was LNV row', 'Why']
const ANSWER: Record<string, string> = { same: 'Same song', add: 'New row', not_ours: 'Not the client’s', deleted: 'Deleted' }
const remarksOf = (d: Step1, recs: CaseRecord[]) => [...new Set(recs.flatMap((r) => d.remarks?.[remarkKey(r)]?.name ?? []))].join('; ')
function songRow(d: Step1, c: ReviewCase, done: boolean): (string | number)[] {
  const m = c.muso[0]
  const all = (f: string) => [...new Set(c.muso.flatMap((r) => list(r.fields[f])))].join(', ')
  return [c.title, c.muso.length, value(m?.fields['Film / album']), all('Lyricist'), all('Composer'), all('Publisher'), all('Singer'), all('ISRC'), value(m?.fields.Year), m?.link ?? '',
    c.answer.choice ? `${ANSWER[c.answer.choice] ?? c.answer.choice}${done ? '' : ' (the app’s answer, not confirmed)'}` : 'Needs an answer', remarksOf(d, c.muso), (c.was ?? []).map((r) => r.row).join(', '), c.why]
}
const typedRow = (t: TypedSong): (string | number)[] => {
  const r = t.record.fields
  return [t.data.title, 1, t.data.album, value(r.Lyricist), value(r.Composer), value(r.Publisher), value(r.Singer), t.data.isrc, value(r.Year), t.data.links.join(' '), 'New row (typed)', '', '', `Added to “${t.to_title}”`]
}

export function sheetOf(x: Lists, id: Exclude<ListId, 'all'>): ListSheet {
  const src = x.d.source, name = LIST_NAMES[id]
  if (id === 'exact' || id === 'possible' || id === 'todo' || id === 'done') {
    const rows = pick(x, id).map(({ f, g }) => matchRow(x, f, g))
    if (id === 'done') for (const f of x.families) for (const t of f.typed) {
      const r = t.record.fields
      rows.push([f.title, 'Typed – new row', 'Yes', '', value(f.main.fields.Title), '', '', t.data.title,
        ...PICK_SHOWN.flatMap((fl) => ['', '', fl === 'ISRC' ? t.data.isrc : value(r[fl])]), '', t.data.links.join(' '), ''])
    }
    return { name, header: MATCH_HEAD(src), rows }
  }
  if (id === 'lnv_only') return { name, header: ['LNV row', 'Song', 'Film / album', 'Year', 'Writers'], rows: x.d.lnv_only.map((r) => [r.row, r.title, r.film, r.year, r.writers.join(', ')]) }
  const cs = id === 'new' ? x.loose : id === 'answer' ? x.loose.filter((c) => !x.isDone(c)) : id === 'newrow' ? x.newRows : x.deleted
  const rows = [...cs].sort((a, b) => a.title.localeCompare(b.title)).map((c) => songRow(x.d, c, x.isDone(c)))
  return { name, header: SONG_HEAD(src), rows: id === 'newrow' ? [...rows, ...typedOf(x).map(typedRow)] : rows }
}
export const EACH: Exclude<ListId, 'all'>[] = ['exact', 'possible', 'todo', 'done', 'new', 'answer', 'newrow', 'deleted', 'lnv_only']
export const sheetsOf = (x: Lists, id: ListId): ListSheet[] => id === 'all' ? EACH.map((k) => sheetOf(x, k)) : [sheetOf(x, id)]
