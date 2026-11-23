import type { CleanDecisionIn } from '../../lib/api'
import type { CaseRecord, ReviewCase } from '../../types'
import { list, norm } from './Block'

/** Step 2's answers as the reviewer gives them (a draft per song) and the decisions each one saves. */

export type Choice = 'same' | 'add' | 'not_ours' | 'deleted' | 'different' | null
/** picks: "pick:<row>:<field>" -> the Muso value chosen over the LNV's, where the two differ */
export type Draft = { in: number[]; rows: number[]; choice: Choice; reject: string[]; picks: Record<string, string | string[]>
  /** the song's other LNV rows on screen, not answered yet: linking one leaves them to check */
  also?: number[] }

/** Fields where the reviewer may take Muso's value over the LNV's, or type one of their own. A publisher picked or
 *  typed replaces the LNV's publisher names (a slot keeps its IPI only while it holds the same company). */
export const PICKABLE = ['Title', 'Film / album', 'Year', 'ISRC', 'Lyricist', 'Composer', 'Singer', 'Publisher']
export const pickKey = (row: number, f: string) => `pick:${row}:${f}`
/** Fields offered in "which value goes into the LNV" – the title has a part of its own (the titles part). */
export const PICK_SHOWN = PICKABLE.filter((f) => f !== 'Title')
/** Fields that hold a list of names: a typed value is split at its commas. */
export const NAME_FIELDS = new Set(['Lyricist', 'Composer', 'Singer', 'Publisher'])

export const valueKey = (v: string | string[] | undefined) => list(v).map(norm).sort().join('|')
const key = valueKey
/** Is this chosen value one the DSP holds for the field (picked), or one the reviewer typed (custom)? */
export const isFrom = (recs: CaseRecord[], f: string, v: string | string[]) => recs.some((r) => list(r.fields[f]).length > 0 && key(r.fields[f]) === key(v))
/** A record's names as the IPI / CAE list has them (the member's PA name for "RK"), where they differ from the file's. */
export const ipiOf = (r: CaseRecord | null | undefined, f: string) => r?.ipi?.[f] ?? null
/** What a screen shows and compares for a field: the list's names where it has them, else what the file wrote. */
export const shownOf = (r: CaseRecord, f: string) => ipiOf(r, f)?.names ?? list(r.fields[f])
/** The decision for a value chosen in a field: the LNV's own spelled out (it then keeps its names over the IPI / CAE
 *  list's), the list's names (with their IPIs), the DSP's (muso) – or typed by the reviewer (custom). */
export const pickItem = (k: string, v: string | string[], recs: CaseRecord[], lnv?: CaseRecord | null): CleanDecisionIn => {
  const f = k.split(':').slice(2).join(':')
  // the very names, as written: 'RAM KRISHNA' kept from the LNV is not 'Ram Krishna' from the IPI / CAE list
  const exact = (a: string | string[] | undefined) => JSON.stringify(list(a)) === JSON.stringify(list(v))
  if (lnv && list(lnv.fields[f]).length && exact(lnv.fields[f])) return { key: k, choice: 'lnv', data: { value: v } }
  const ipi = [lnv, ...recs].map((r) => ipiOf(r, f)).find((x) => x && exact(x.names))
  if (ipi) return { key: k, choice: 'ipi', data: { value: v, ipis: ipi.ids } }
  return { key: k, choice: isFrom(recs, f, v) ? 'muso' : 'custom', data: { value: v } }
}

export function draftOf(c: ReviewCase, saved: Record<string, string | string[]> = {}): Draft {
  const a = c.answer
  const reject = c.updates.filter((u) => !u.accept).map((u) => u.key)
  const picks = Object.fromEntries(Object.entries(saved).filter(([k]) => c.lnv.some((r) => k.startsWith(`pick:${r.row}:`))))
  if (c.kind === 'names') return { in: [], rows: [], choice: (a.choice as Choice) ?? null, reject, picks }
  if (c.kind === 'twice') {   // only an answer the app is sure of (or the reviewer's) is chosen
    if (!a.choice) return { in: [], rows: [], choice: null, reject, picks }
    return a.choice === 'different' || a.choice === 'neither' ? { in: [], rows: [], choice: 'different', reject, picks }
      : { in: [], rows: a.keep ? [a.keep] : [], choice: 'same', reject, picks }
  }
  return { in: c.muso.filter((r) => r.in).map((r) => r.id!), rows: a.choice === 'same' ? a.rows ?? [] : [], choice: (a.choice as Choice) ?? null, reject, picks,
    ...(a.also?.length ? { also: a.also } : {}) }
}

/** The decisions one confirm saves (choice null on undo). */
export function itemsOf(c: ReviewCase, d: Draft | null): CleanDecisionIn[] {
  if (c.kind === 'names') return [d ? { key: c.answer.key!, choice: d.choice as 'same' | 'different', data: { ...c.names! } } : { key: c.answer.key!, choice: null }]
  if (c.kind === 'twice') {
    if (!d) return [{ key: c.answer.key!, choice: null }]
    if (d.choice === 'different') return [{ key: c.answer.key!, choice: c.isrc ? 'neither' : 'different' }]
    return [{ key: c.answer.key!, choice: c.isrc ? 'owner' : 'duplicate', data: c.isrc ? { row: d.rows[0] } : { keep: d.rows[0] } }]
  }
  const out: CleanDecisionIn[] = []
  // each merge item of the song: its recordings still ticked stay one song, the unticked ones go apart
  for (const m of c.merge?.items ?? []) {
    const kept = m.ids.filter((id) => d?.in.includes(id))
    if (!d) out.push({ key: m.key, choice: null })
    else if (kept.length <= 1) out.push({ key: m.key, choice: 'rejected' })
    else out.push({ key: m.key, choice: 'accepted', data: { excluded: m.ids.filter((id) => !d.in.includes(id)) } })
  }
  const song = c.answer.song!
  // the values taken from Muso: kept for the rows the song is linked to, cleared everywhere else
  const picks = (rows: number[]) => c.lnv.forEach((r) => PICKABLE.forEach((f) => {
    const key = pickKey(r.row!, f)
    const v = rows.includes(r.row!) ? d?.picks[key] : undefined
    out.push(v !== undefined ? pickItem(key, v, [...c.muso, ...(c.in_lnv ?? []).map((x) => x.muso)], r) : { key, choice: null })
  }))
  // the LNV rows the reviewer turned down before (a new row, a deleted song): they stay turned down
  const was = (c.was ?? []).map((r) => r.row!).filter((r) => r != null)
  if (!d) { out.push({ key: `link:${song}`, choice: null }, { key: `missing:${song}`, choice: null }); picks([]) }
  else if (d.choice === 'same') {
    const also = (d.also ?? []).filter((r) => !d.rows.includes(r))
    out.push({ key: `link:${song}`, choice: 'same', data: { rows: d.rows, ...(also.length ? { also } : {}) } }, { key: `missing:${song}`, choice: null })
    c.updates.filter((u) => d.rows.includes(u.row)).forEach((u) => out.push({ key: u.key, choice: d.reject.includes(u.key) ? 'reject' : 'accept' }))
    picks(d.rows)
  } else if (d.choice === 'add' || d.choice === 'not_ours') {
    out.push({ key: `link:${song}`, choice: 'none', ...(was.length ? { data: { rows: was } } : {}) }, { key: `missing:${song}`, choice: d.choice }); picks([])
  } else if (d.choice === 'deleted') {
    // deleted: every LNV row it was matched to is turned down too – nothing of it goes into the LNV, the app does not ask again
    const rows = [...new Set([...c.lnv.map((r) => r.row!).filter((r) => r != null), ...was])]
    out.push({ key: `link:${song}`, choice: 'none', data: { rows } }, { key: `missing:${song}`, choice: 'deleted' }); picks([])
  }
  return out
}

export const ready = (c: ReviewCase, d: Draft) => d.choice !== null && (c.kind === 'names' || d.choice !== 'same' || d.rows.length > 0)

/** How a song stands against the LNV, one recording against one LNV row. Exact: the same credits – title, version,
 *  album, writers, publisher – and the same ISRC (or the LNV has none yet). Possible: the same ISRC or the same
 *  credits, not both. New: neither; the closest LNV rows are other songs. */
export type Match = 'exact' | 'possible' | 'new' | 'other'
export const MATCHES = [['exact', 'Exact'], ['possible', 'Possible'], ['new', 'Not in the LNV']] as const
export function matchOf(c: ReviewCase): Match {
  if (c.kind === 'names' || c.kind === 'twice') return 'other'
  const levels = c.lnv.map((r) => r.check?.level)
  if (levels.includes('exact')) return 'exact'
  // one stage holds – or only the ISRC is shared (the LNV has that recording: it is never added twice) – or the song
  // is only a version the LNV already has – or the reviewer linked it to an LNV row themselves (mapped from "Not in
  // the LNV"): it is in the LNV
  return levels.includes('possible') || levels.includes('isrc_only') || c.in_lnv?.some((v) => v.isrc && v.answer !== 'none')
    || (c.answer.choice === 'same' && c.answer.by === 'you' && !!c.answer.rows?.length) ? 'possible' : 'new'
}

/** Sent out of the LNV match by the reviewer: a new row (from Songs or Not in the LNV) – listed under New row. */
export const isNewRow = (c: ReviewCase) => c.kind !== 'names' && c.kind !== 'twice' && c.answer.choice === 'add' && c.answer.by === 'you'
/** Deleted by the reviewer: nothing of it goes into the LNV – listed under Deleted songs. */
export const isDeleted = (c: ReviewCase) => c.kind !== 'names' && c.kind !== 'twice' && c.answer.choice === 'deleted'

/** A song's stable name across reloads: an answer can move it from one kind of case to another. */
export const keyOf = (c: ReviewCase) => c.answer.song ?? c.id
