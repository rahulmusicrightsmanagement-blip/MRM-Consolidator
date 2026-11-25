import type { CleanDecisionIn } from '../../lib/api'
import type { CaseRecord } from '../../types'
import { list } from './Block'

/** Typed values – the LNV's and the DSP's (Muso's) – checked and tidied before they are saved, and the corrections of
 *  the DSP data. No React here: unit-tested in Node. */

/** Fields of a DSP recording that can be corrected. */
export const MUSO_FIELDS = ['Title', 'Film / album', 'Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC', 'Year', 'Release date', 'Link']
const NAMES = new Set(['Lyricist', 'Composer', 'Singer', 'Publisher'])

/** What a field is called on screen. */
export const LABEL: Record<string, string> = { 'Alternate title': 'Alternative work name', Year: 'Release year' }
export const labelOf = (f: string) => LABEL[f] ?? f

export const ISRC_OK = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/
const flat = (t: string) => t.replace(/[^0-9a-z]/gi, '').toUpperCase()
/** Every ISRC of a text, each once – whatever stands between them – and the parts that are none. */
export function isrcsOf(text: string): { isrcs: string[]; wrong: string[] } {
  const isrcs: string[] = [], wrong: string[] = []
  const put = (x: string) => { if (!isrcs.includes(x)) isrcs.push(x) }
  if (ISRC_OK.test(flat(text))) return { isrcs: [flat(text)], wrong }
  for (const part of text.split(/[|,;/&\n]+/).map((x) => x.trim()).filter(Boolean)) {
    if (ISRC_OK.test(flat(part))) { put(flat(part)); continue }
    for (const w of part.split(/\s+/)) { if (ISRC_OK.test(flat(w))) put(flat(w)); else wrong.push(w) }
  }
  return { isrcs, wrong }
}
/** Several ISRCs as one cell: "ISRC1 | ISRC2", each once. */
export const pipe = (isrcs: string[]) => [...new Set(isrcs.filter(Boolean))].join(' | ')

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** A complete date as DD-MM-YYYY (day first); '' when it is none. */
export function dateOf(text: string): string {
  const t = text.trim()
  const day = (y: number, m: number, d: number) => {
    const x = new Date(Date.UTC(y, m - 1, d))
    return y >= 1000 && x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d
      ? `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}` : ''
  }
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/)
  if (m) return day(+m[1], +m[2], +m[3])
  m = t.match(/^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{4})(?!\d)/)
  if (m) return day(+m[3], +m[2], +m[1]) || day(+m[3], +m[1], +m[2])
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?[-\s]+([a-z]{3})[a-z]*\.?,?[-\s]+(\d{4})/i)
  if (m) return day(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1])
  m = t.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i)
  if (m) return day(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2])
  return ''
}
export const isLink = (t: string) => t.length <= 2000 && /^https?:\/\/[^\s/?#\\<>"'`]+\.[^\s/?#\\<>"'`]+(?:[/?#][^\s<>"`]*)?$/i.test(t)

/** A typed value as it is kept – names and ISRCs a list – or why it cannot be. */
export function typedValue(f: string, text: string): { v: string[]; error?: string } {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return { v: [] }
  if (NAMES.has(f)) return { v: [...new Set(t.split(/[,;]/).map((x) => x.trim()).filter(Boolean))] }
  if (f === 'ISRC') {
    const { isrcs, wrong } = isrcsOf(t)
    return wrong.length || !isrcs.length ? { v: isrcs, error: 'An ISRC has 12 characters, e.g. INH100510220 – put | between two' } : { v: isrcs }
  }
  if (f === 'Release date') { const x = dateOf(t); return x ? { v: [x] } : { v: [], error: 'Type the date as DD-MM-YYYY, e.g. 08-05-2013' } }
  if (f === 'Year') return /^(18|19|20)\d{2}$/.test(t) ? { v: [t] } : { v: [], error: 'A year has 4 digits, e.g. 2013' }
  if (f === 'Link') return isLink(t) ? { v: [t] } : { v: [], error: 'A link starts with http:// or https://' }
  return { v: [t] }
}
/** A value as the box to type it shows it. */
export const typedText = (f: string, v: string[]) => v.join(f === 'ISRC' ? ' | ' : ', ')

/** What the sheet itself has in a field of a DSP recording, a correction aside. */
export const rawOf = (r: CaseRecord, f: string): string[] => list(r.edited && f in r.edited ? r.edited[f] : r.fields[f])
export const isEdited = (r: CaseRecord, f: string) => !!r.edited && f in r.edited

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
/** The decision that corrects a DSP recording's field – or takes the correction back (null, or the sheet's own value). */
export function editItem(r: CaseRecord, f: string, v: string[] | null): CleanDecisionIn {
  const key = `muso:${r.id}:${f}`
  if (v == null || same(v, rawOf(r, f))) return { key, choice: null }
  return { key, choice: 'set', data: { value: NAMES.has(f) || f === 'ISRC' ? v : v[0] ?? '' } }
}

/** Two work names are written the same – case, spaces and punctuation aside, in any script. */
export function sameName(a: string, b: string) {
  const k = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') || t.trim()
  return k(a) === k(b)
}
/** The work names that are not the one kept, each once. */
export function otherNames(final: string, ...names: string[]) {
  const out: string[] = []
  for (const x of names.map((y) => y.trim())) if (x && !sameName(x, final) && !out.some((y) => sameName(x, y))) out.push(x)
  return out
}
/** The Alternative Work Name an LNV row gets by itself: the names it has, and the work name of the source that is not
 *  kept – Muso's when the LNV's title is kept, the LNV's when Muso's is. */
export function autoAlternative(final: string, lnv: CaseRecord, recs: CaseRecord[]): string {
  const old = list(lnv.fields['Alternate title']).join('; ')
  const has = old.split(/[;|]/)
  const fresh = otherNames(final, list(lnv.fields.Title)[0] ?? '', ...recs.map((r) => list(r.fields.Title)[0] ?? '')).filter((x) => !has.some((y) => sameName(x, y)))
  return [old, ...fresh].filter(Boolean).join('; ')
}
