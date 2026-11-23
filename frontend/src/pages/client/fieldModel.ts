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
 *  name, typed, or blank. */
export type Keep = 'lnv' | 'muso' | 'ipi' | 'custom' | 'blank'
export const keepText = (k: Keep, source: string) => k === 'lnv' ? 'LNV' : k === 'muso' ? source : k === 'ipi' ? 'IPI List' : k === 'custom' ? 'Customised' : 'Blank'

/** The choices one field of a card offers, and which one holds: the LNV's own value ('lnv'), each DSP value that
 *  differs ('m0' …), each name the IPI / CAE list has for it ('i0' …), typed ('custom'), blank. With no answer the
 *  LNV keeps its own names as the list has them – the member's PA name – else its own value; a blank LNV field takes
 *  the DSP's (as the list has it). pickOf: the value an answer saves – null for the one the LNV gets anyway. */
export type Choices = {
  lv: string[]; lvShown: string[]; vs: Variant[]; opts: string[][]; ipis: IpiChoice[]
  def: string; mode: string; now: string[]; keep: Keep; pickOf: (m: string) => string[] | null
}
export function fieldChoices(fl: string, g: Group, taken: string | string[] | undefined, source: string): Choices {
  const lv = list(g.lnv.fields[fl])
  const vs = variantsOf(fl, g.recs)
  const mvs = vs.map((x) => x.v)
  const opts = lv.length ? mvs.filter((v) => differs(fl, v, lv)) : mvs
  const ipis = NAME_FIELDS.has(fl) ? ipiChoices(fl, g.lnv, g.recs, source) : []
  const own = ipiOf(g.lnv, fl)
  const ipiAt = (v?: string[] | null) => v ? ipis.findIndex((x) => same(x.v, v)) : -1
  const def = lv.length ? (ipiAt(own?.names) >= 0 ? `i${ipiAt(own?.names)}` : 'lnv')
    : vs.length ? (vs[0].res !== vs[0].v && ipiAt(vs[0].res) >= 0 ? `i${ipiAt(vs[0].res)}` : 'm0') : 'blank'
  const valueOf = (m: string): string[] => m === 'lnv' ? lv : m.startsWith('m') ? opts[Number(m.slice(1))] ?? [] : m.startsWith('i') ? ipis[Number(m.slice(1))]?.v ?? [] : []
  let mode = def
  if (taken !== undefined) {
    const t = list(taken)
    const m = opts.findIndex((v) => valueKey(v) === valueKey(t))
    mode = lv.length && same(t, lv) ? 'lnv' : ipiAt(t) >= 0 ? `i${ipiAt(t)}` : m >= 0 ? `m${m}` : 'custom'
  }
  const now = taken !== undefined ? list(taken) : valueOf(def)
  const keep: Keep = mode === 'lnv' ? 'lnv' : mode === 'custom' ? 'custom' : mode === 'blank' ? 'blank' : mode.startsWith('i') ? 'ipi' : 'muso'
  return { lv, lvShown: own?.names ?? lv, vs, opts, ipis, def, mode, now, keep, pickOf: (m) => m === def || m === 'blank' ? null : valueOf(m) }
}

