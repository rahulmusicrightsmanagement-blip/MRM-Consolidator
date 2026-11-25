import type { CleanDecisionIn } from '../../lib/api'
import type { CaseRecord, RemarkChoice, ReviewCase, Step1 } from '../../types'
import { list } from './Block'
import { value, writersOf } from './CaseParts'
import { rawOf } from './editModel'
import { gTicked } from './Families'
import type { Family, Pending } from './Families'

/** Why a song is mapped (the Remark dropdown), and the songs of the Muso and LNV lists – exact and possible matches – it
 *  can be mapped to. No React here: unit-tested in Node. */

/** A recording's remark follows its ISRC (a new Muso export keeps it), else its sheet row. */
export const remarkKey = (r: CaseRecord) => rawOf(r, 'ISRC')[0] ?? `#${r.id}`
export type Remark = { id: number | null; name: string }

/** The remark of a song's recordings: the one they share, null – none, 'mixed' – several. */
export function remarkOf(d: Step1, recs: CaseRecord[]): Remark | null | 'mixed' {
  const all = recs.map((r) => d.remarks?.[remarkKey(r)] ?? null)
  const first = all[0] ?? null
  return all.every((x) => (x?.name ?? '') === (first?.name ?? '')) ? first : 'mixed'
}
/** The decisions that give recordings a remark (null – take it off). */
export const remarkItems = (recs: CaseRecord[], r: RemarkChoice | null): CleanDecisionIn[] =>
  [...new Set(recs.filter((x) => x.id != null).map(remarkKey))].map((k) => r ? { key: `remark:${k}`, choice: 'set', data: { remark: r.id, value: r.name } } : { key: `remark:${k}`, choice: null })

/** A song of the Muso list or the LNV list a song can be mapped to. */
export type Spot = {
  key: string; from: 'muso' | 'lnv'; match: 'exact' | 'possible'; c: ReviewCase; to: number; row?: number; rowTitle?: string
  title: string; isrcs: string[]; film: string; writers: string; family: string; checked: boolean; version?: string
}

/** Every exact and possible match, from both lists: each LNV row, and each Muso recording with its ISRC. */
export function spotsFor(c: ReviewCase, families: Family[], p: Pending): Spot[] {
  const out: Spot[] = []
  const seen = new Set<string>()
  const put = (s: Spot) => { if (!seen.has(s.key)) { seen.add(s.key); out.push(s) } }
  for (const f of families) {
    const good = (x: ReviewCase) => x.id !== c.id && x.muso[0]?.id != null && !x.muso[0].moved
    for (const g of [...f.exact, ...f.possible]) {
      const e = g.entries.find((y) => !y.v && good(y.c)) ?? g.entries.find((y) => good(y.c))
      if (!e) continue
      const base = { match: g.match, c: e.c, to: e.c.muso[0].id!, family: f.title, checked: gTicked(p, g) }
      const rowTitle = value(g.lnv.fields.Title)
      g.rows.forEach((row) => put({ ...base, key: `l${row}`, from: 'lnv', row, rowTitle, title: rowTitle, isrcs: list(g.lnv.fields.ISRC), film: value(g.lnv.fields['Film / album']), writers: writersOf(g.lnv).join(', ') }))
      g.recs.filter((r) => r.id != null).forEach((r) => put({ ...base, key: `m${r.id}`, from: 'muso', row: g.rows[0], rowTitle, title: value(r.fields.Title), isrcs: list(r.fields.ISRC), film: value(r.fields['Film / album']),
        writers: writersOf(r).join(', '), version: r.version ?? undefined }))
    }
    for (const { c: x, r } of f.rest) {
      if (!good(x) || r.id == null) continue
      const g = [...f.exact, ...f.possible].find((y) => y.entries.some((e) => e.c.id === x.id))
      put({ key: `m${r.id}`, from: 'muso', match: g?.match ?? 'possible', c: x, to: x.muso[0].id!, row: g?.rows[0], rowTitle: g ? value(g.lnv.fields.Title) : undefined, title: value(r.fields.Title), isrcs: list(r.fields.ISRC),
        film: value(r.fields['Film / album']), writers: writersOf(r).join(', '), family: f.title, checked: !!g && gTicked(p, g), version: r.version ?? undefined })
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title) || (a.row ?? 0) - (b.row ?? 0))
}

/** A song mapped to another as its version – each recording with an LNV row of its own – with its remark. */
export const mapItems = (c: ReviewCase, recs: CaseRecord[], s: Spot): CleanDecisionIn[] =>
  recs.filter((r) => r.id != null && r.id !== s.to).map((r) => ({ key: `map:${r.id}`, choice: 'join', data: { to: s.to, row: s.row, title: s.rowTitle ?? s.title, from: c.title } }))
