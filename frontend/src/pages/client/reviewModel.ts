import type { CleanDecisionIn } from '../../lib/api'
import type { ReviewCase } from '../../types'

/** Step 2's answers as the reviewer gives them (a draft per song) and the decisions each one saves. */

export type Choice = 'same' | 'add' | 'not_ours' | 'different' | null
/** picks: "pick:<row>:<field>" -> the Muso value chosen over the LNV's, where the two differ */
export type Draft = { in: number[]; rows: number[]; choice: Choice; reject: string[]; picks: Record<string, string | string[]> }

/** Fields where the reviewer may take Muso's value over the LNV's (publisher cells carry shares and IPIs: not here). */
export const PICKABLE = ['Title', 'Film / album', 'Year', 'ISRC', 'Lyricist', 'Composer', 'Singer']
export const pickKey = (row: number, f: string) => `pick:${row}:${f}`
/** Fields offered in "which value goes into the LNV" – the title has a part of its own (the titles part). */
export const PICK_SHOWN = PICKABLE.filter((f) => f !== 'Title')

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
  return { in: c.muso.filter((r) => r.in).map((r) => r.id!), rows: a.choice === 'same' ? a.rows ?? [] : [], choice: (a.choice as Choice) ?? null, reject, picks }
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
    out.push(v !== undefined ? { key, choice: 'muso', data: { value: v } } : { key, choice: null })
  }))
  if (!d) { out.push({ key: `link:${song}`, choice: null }, { key: `missing:${song}`, choice: null }); picks([]) }
  else if (d.choice === 'same') {
    out.push({ key: `link:${song}`, choice: 'same', data: { rows: d.rows } }, { key: `missing:${song}`, choice: null })
    c.updates.filter((u) => d.rows.includes(u.row)).forEach((u) => out.push({ key: u.key, choice: d.reject.includes(u.key) ? 'reject' : 'accept' }))
    picks(d.rows)
  } else if (d.choice === 'add' || d.choice === 'not_ours') { out.push({ key: `link:${song}`, choice: 'none' }, { key: `missing:${song}`, choice: d.choice }); picks([]) }
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
  // is only a version the LNV already has
  return levels.includes('possible') || levels.includes('isrc_only') || c.in_lnv?.some((v) => v.isrc && v.answer !== 'none') ? 'possible' : 'new'
}

/** A song's stable name across reloads: an answer can move it from one kind of case to another. */
export const keyOf = (c: ReviewCase) => c.answer.song ?? c.id
