import type { CaseRecord } from '../../types'
import { list } from './Block'
import { differs } from './CaseParts'
import type { Group } from './Families'
import { NAME_FIELDS, ipiOf, valueKey } from './reviewModel'

export { ipiOf }

/** What one field of an LNV row keeps when step 2 is saved – the LNV's own value, Muso's, the IPI / CAE list's name
 *  for it, or a typed one – and which choices the screen offers. No React here: the screens (Families) use it, and
 *  the unit tests run it in Node. */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** A field's values across recordings as variants does, each with its names as the IPI / CAE list has them (res) and
 *  their IPIs – the same value from two recordings once. */
export type Variant = { v: string[]; res: string[]; ids?: string[] }
export const variantsOf = (f: string, rs: CaseRecord[]): Variant[] => {
  const out: Variant[] = []
  for (const r of rs) {
    const v = list(r.fields[f])
    if (!v.length || out.some((x) => !differs(f, x.v, v))) continue
    const ip = ipiOf(r, f)
    out.push({ v, res: ip?.names ?? v, ids: ip?.ids })
  }
  return out
}
/** The IPI / CAE list's names for a field of a card, each set once and none that is the LNV's own value: from the
 *  LNV's names (found by their CAE numbers first), then from each DSP value. */
export type IpiChoice = { v: string[]; ids: string[]; from: string; raw: string[] }
export function ipiChoices(f: string, lnv: CaseRecord, recs: CaseRecord[], source: string): IpiChoice[] {
  const lv = list(lnv.fields[f])
  const out: IpiChoice[] = []
  const add = (v: string[] | undefined, ids: string[] | undefined, from: string, raw: string[]) => {
    if (!v?.length || same(v, lv) || out.some((x) => valueKey(x.v) === valueKey(v))) return
    out.push({ v, ids: ids ?? [], from, raw })
  }
  const own = ipiOf(lnv, f)
  add(own?.names, own?.ids, 'the LNV', lv)
  variantsOf(f, recs).forEach((x) => { if (x.res !== x.v) add(x.res, x.ids, source, x.v) })
  return out
}
/** Which value a field keeps in the LNV: the LNV's own, the DSP's (picked, or filling a blank), the IPI / CAE list's
 *  name, typed, blank – every ISRC of both (all) – or the work name that was not kept (auto: Alternative work name). */
export type Keep = 'lnv' | 'muso' | 'ipi' | 'custom' | 'blank' | 'all' | 'auto'
export const keepText = (k: Keep, source: string) => k === 'lnv' ? 'LNV' : k === 'muso' ? source : k === 'ipi' ? 'IPI List' : k === 'custom' ? 'Customised'
  : k === 'all' ? 'All ISRCs' : k === 'auto' ? 'Automatic' : 'Blank'

/** The choices one field of a card offers, and which one holds: the LNV's own value ('lnv'), each DSP value that
 *  differs ('m0' …), each name the IPI / CAE list has for it ('i0' …), every ISRC ('all'), the alternative work name
 *  by itself ('auto'), typed ('custom'), blank. With no answer the LNV keeps its own names as the list has them – the
 *  member's PA name – else its own value; a blank LNV field takes the DSP's (as the list has it). An ISRC cell gets
 *  every ISRC of the song, each once. pickOf: the value an answer saves – null for the one the LNV gets anyway,
 *  nothing ([]) to leave it blank. */
export type Choices = {
  lv: string[]; lvShown: string[]; vs: Variant[]; opts: string[][]; ipis: IpiChoice[]
  /** an exact match's other LNV rows (merged into this one): their values ('l0' …) */
  rows: { row: number; v: string[] }[]
  /** every ISRC of the row: the LNV's and the DSP's · the alternative work name by itself */
  all: string[]; auto: string[]
  def: string; mode: string; now: string[]; keep: Keep; pickOf: (m: string) => string[] | null
}
export function fieldChoices(fl: string, g: Group, taken: string | string[] | undefined, source: string, alternative?: string, others: CaseRecord[] = []): Choices {
  const lv = list(g.lnv.fields[fl])
  const vs = fl === 'Alternate title' ? [] : variantsOf(fl, g.recs)
  const mvs = vs.map((x) => x.v)
  const ipis = NAME_FIELDS.has(fl) ? ipiChoices(fl, g.lnv, [...g.recs, ...others], source) : []
  // a name the IPI / CAE list knows goes into the LNV as the member's real name (PA): the DSP's stage name (PP) is offered
  // as the list's name, never as written
  const listed = (v: string[]) => NAME_FIELDS.has(fl) && vs.some((x) => same(x.v, v) && x.res !== x.v && (ipis.some((y) => valueKey(y.v) === valueKey(x.res)) || valueKey(x.res) === valueKey(lv)))
  const opts = (lv.length ? mvs.filter((v) => differs(fl, v, lv)) : mvs).filter((v) => !listed(v))
  // the other rows of an exact match: each value of theirs not offered already
  const rows: { row: number; v: string[] }[] = []
  if (fl !== 'Alternate title') for (const r of others) {
    const v = list(r.fields[fl])
    if (v.length && r.row != null && (!lv.length || differs(fl, v, lv)) && !opts.some((x) => !differs(fl, x, v)) && !rows.some((x) => !differs(fl, x.v, v))) rows.push({ row: r.row, v })
  }
  const own = ipiOf(g.lnv, fl)
  const ipiAt = (v?: string[] | null) => v ? ipis.findIndex((x) => same(x.v, v)) : -1
  // what the LNV row gets besides its own: worked out by the server, one rule for the screen and the file
  const adds = fl === 'ISRC' ? [...new Set([g.lnv, ...(g.entries ?? []).map((e) => e.lnv)].flatMap((r) => r.isrc_add ?? []))].filter((x) => !lv.includes(x)) : []
  const told = fl === 'ISRC' ? g.lnv.isrc_add : undefined
  const all = adds.length && !g.lnv.isrc_text ? [...lv, ...adds] : []
  const auto = fl === 'Alternate title' && alternative && alternative !== lv.join('; ') ? [alternative] : []
  const fill = fl === 'Release date' ? g.lnv.date_add : fl === 'Link' ? g.lnv.link_add : undefined
  const fillAt = fill ? opts.findIndex((v) => v[0] === fill) : -1
  const def = fl === 'ISRC' && told ? (all.length ? (!lv.length && opts.length && valueKey(opts[0]) === valueKey(all) ? 'm0' : 'all') : lv.length ? 'lnv' : 'blank')
    : auto.length ? 'auto'
    : lv.length ? (ipiAt(own?.names) >= 0 ? `i${ipiAt(own?.names)}` : 'lnv')
    : fill !== undefined ? (fillAt >= 0 ? `m${fillAt}` : 'blank')
    : vs.length ? (vs[0].res !== vs[0].v && ipiAt(vs[0].res) >= 0 ? `i${ipiAt(vs[0].res)}` : 'm0') : 'blank'
  const valueOf = (m: string): string[] => m === 'lnv' ? lv : m === 'all' ? all : m === 'auto' ? auto
    : m.startsWith('m') ? opts[Number(m.slice(1))] ?? [] : m.startsWith('i') ? ipis[Number(m.slice(1))]?.v ?? [] : /^l\d+$/.test(m) ? rows[Number(m.slice(1))]?.v ?? [] : []
  let mode = def
  if (taken !== undefined) {
    const t = list(taken)
    // a year kept from the DSP before it was shown as a year only ('2013-05-08')
    const key = (v: string[]) => fl === 'Year' ? (v[0] ?? '').slice(0, 4) : fl === 'Link' ? v.join(' ') : valueKey(v)
    const m = opts.findIndex((v) => key(v) === key(t))
    const l = rows.findIndex((x) => key(x.v) === key(t))
    mode = !t.length ? (lv.length ? 'custom' : 'blank') : lv.length && same(t, lv) ? 'lnv' : all.length && key(t) === key(all) ? 'all'
      : ipiAt(t) >= 0 ? `i${ipiAt(t)}` : m >= 0 ? `m${m}` : l >= 0 ? `l${l}` : 'custom'
  }
  const now = taken !== undefined ? (mode.startsWith('m') || /^l\d+$/.test(mode) ? valueOf(mode) : list(taken)) : valueOf(def)
  const keep: Keep = mode === 'lnv' || mode === 'custom' || mode === 'blank' || mode === 'all' || mode === 'auto' ? mode : mode.startsWith('i') ? 'ipi'
    : /^l\d+$/.test(mode) ? 'lnv' : 'muso'
  return { lv, lvShown: own?.names ?? lv, vs, opts, ipis, rows, all, auto, def, mode, now, keep, pickOf: (m) => m === def ? null : m === 'blank' ? [] : valueOf(m) }
}
