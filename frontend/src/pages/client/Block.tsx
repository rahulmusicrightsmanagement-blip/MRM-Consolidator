import { Check, X } from 'lucide-react'
import { samePerson } from '../../lib/names'
import type { SongRecord } from '../../types'

/** What the case screens share: comparing one record's field with another's (same · part · diff), and the score
 *  and evidence chips shown on a candidate. */

export const n = (x?: number | null) => (x ?? 0).toLocaleString('en-IN')
export const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
/** Spelling-free key: 'Nishaana' = 'Nishana', 'Pyaar' = 'Pyar', 'AAFREEN' = 'Afreen'. */
const loose = (s: string) => norm(s.normalize('NFKD')).replace(/(.)\1+/g, '$1').replace(/ph/g, 'f').replace(/([bcdgjkpstr])h/g, '$1')
  .replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/y/g, 'i').replace(/(.)\1+/g, '$1')
const titleEq = (a: string, b: string) => {
  const x = loose(a.replace(/\s*[([].*$/, '')), y = loose(b.replace(/\s*[([].*$/, ''))
  return x === y || (x.length > 5 && y.length > 5 && (x.includes(y) || y.includes(x)))
}

/* ---------- a block: records one below another ---------- */

const PEOPLE = new Set(['Lyricist', 'Composer', 'Singer'])
export const list = (v?: string | string[]) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean)
export type Cell = 'same' | 'diff' | 'part' | 'blank' | 'ref'

function eqFor(field: string) {
  if (PEOPLE.has(field)) return (a: string, b: string) => samePerson(a, b)
  if (field === 'Title' || field === 'Film / album') return titleEq
  if (field === 'Length') return (a: string, b: string) => a.replace(/^00:/, '') === b.replace(/^00:/, '')
  if (field === 'Year') return (a: string, b: string) => a.slice(0, 4) === b.slice(0, 4)
  return (a: string, b: string) => norm(a) === norm(b)
}
/** How a record's value compares with the reference record's (the first one in the block). */
export function cellOf(field: string, ref: string[], v: string[]): Cell {
  if (!v.length || !ref.length) return 'blank'
  const eq = eqFor(field)
  const a = v.filter((x) => ref.some((y) => eq(x, y))).length
  const b = ref.filter((y) => v.some((x) => eq(x, y))).length
  return a === v.length && b === ref.length ? 'same' : a || b ? 'part' : 'diff'
}

/** Is this name in the other record's list – spelling and word order aside? */
export const inList = (field: string, others: string[], x: string) => others.some((y) => eqFor(field)(x, y))

export const Why = ({ items }: { items?: SongRecord['why'] }) => !Array.isArray(items) || !items.length ? null : (
  <span className="cs-why">{items.map((w) => <span key={w.text} className={w.good ? 'good' : 'bad'}>{w.good ? <Check size={11} /> : <X size={11} />}{w.text}</span>)}</span>
)
export const Score = ({ s }: { s?: number | null }) => s == null ? null : <span className={`cs-score s${s >= 8 ? 2 : s >= 5 ? 1 : 0}`}>{s}/10</span>
