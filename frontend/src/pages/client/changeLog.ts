import type { ChangeLog, CleanDecisionIn } from '../../lib/api'
import type { ReviewCase, Step1 } from '../../types'
import { list, n } from './Block'
import type { Family } from './Families'
import { remarkKey } from './remarkModel'
import { keyOf } from './reviewModel'

/** Each decision the screens save, in plain words and with the songs it concerns – for the Undo section. No React here:
 *  the unit tests run it in Node. */

export type SongRef = { key: string; title: string }
type Known = { c: ReviewCase; s: SongRef }
export type LogContext = {
  source: string; titles: Map<string, SongRef>
  song: Map<string, Known>; row: Map<number, SongRef>; rec: Map<number, Known & { title: string; from?: string }>
  ver: Map<string, Known & { title: string; row: number }>; part: Map<string, Known & { text?: string }>
  typed: Map<string, { title: string; s: SongRef }>
  remark: Map<string, Known & { title: string; id: number }>
}
export const OTHER: SongRef = { key: 'other', title: 'Names and other answers' }

/** The song a case is listed under in the Undo section: its song name in Songs, else the song itself. */
export const songRef = (c: ReviewCase, f?: Family): SongRef => f ? { key: f.id, title: f.title }
  : c.kind === 'names' ? OTHER : { key: c.family ? `f:${c.family}` : keyOf(c), title: c.title }

export function logContext(d: Step1, familyOf: Map<string, Family>): LogContext {
  const x: LogContext = { source: d.source, titles: new Map(), song: new Map(), row: new Map(), rec: new Map(), ver: new Map(), part: new Map(), typed: new Map(), remark: new Map() }
  for (const c of d.cases) {
    const s = songRef(c, familyOf.get(c.id))
    if (c.answer.song) x.song.set(c.answer.song, { c, s })
    if (c.answer.key) x.part.set(c.answer.key, { c, s })
    for (const m of c.merge?.items ?? []) x.part.set(m.key, { c, s, text: 'Versions joined or kept apart' })
    for (const u of c.updates) x.part.set(u.key, { c, s, text: `${u.field} of LNV row ${u.row}` })
    for (const r of c.muso) if (r.id != null) {
      const title = list(r.fields.Title)[0] ?? c.title
      x.rec.set(r.id, { c, s, title, from: r.moved?.from })
      x.remark.set(remarkKey(r), { c, s, title, id: r.id })
    }
    for (const v of c.in_lnv ?? []) { x.ver.set(v.key, { c, s, title: list(v.muso.fields.Title)[0] ?? c.title, row: v.row }); x.row.set(v.row, s) }
    for (const r of c.lnv) if (r.row != null && (familyOf.has(c.id) || !x.row.has(r.row))) x.row.set(r.row, s)
    if (!x.titles.has(c.title)) x.titles.set(c.title, s)
  }
  for (const t of d.typed ?? []) {
    const s = (t.to && x.song.get(t.to)?.s) || { key: t.key, title: t.to_title }
    x.typed.set(t.key, { title: t.data.title, s })
  }
  return x
}

const rowsText = (rows?: number[]) => `LNV row${(rows?.length ?? 0) > 1 ? 's' : ''} ${(rows ?? []).join(', ')}`
const short = (t: string) => (t.length > 80 ? `${t.slice(0, 79)}…` : t)

/** One decision's line in the log, given everything saved with it (batch). */
export function describe(it: CleanDecisionIn, batch: CleanDecisionIn[], x: LogContext): ChangeLog {
  const at = it.key.indexOf(':')
  const kind = it.key.slice(0, at), rest = it.key.slice(at + 1)
  const has = (key: string) => batch.find((b) => b.key === key)
  const refs = (...s: (SongRef | undefined)[]) => s.filter((y): y is SongRef => !!y).filter((y, i, a) => a.findIndex((z) => z.key === y.key) === i)
  const answer = (song: string, text: string, minor = false): ChangeLog => ({ group: `answer:${song}`, songs: refs(x.song.get(song)?.s), text, minor })
  switch (kind) {
    case 'link':
      if (it.choice === 'same') return answer(rest, `Same song as ${rowsText(it.data?.rows)}`)
      if (it.choice === 'none') return answer(rest, 'Not linked to an LNV row', true)
      return answer(rest, 'Answer taken back', !!has(`missing:${rest}`)?.choice || !!has(`off:${rest}`)?.choice)
    case 'missing': {
      const text = it.choice === 'add' ? 'Sent to a new row' : it.choice === 'deleted' ? 'Deleted' : it.choice === 'not_ours' ? 'Marked “Not the client’s”' : 'Answer taken back'
      return answer(rest, text, it.choice === null && !!(has(`link:${rest}`)?.choice || has(`off:${rest}`)?.choice))
    }
    case 'off': return answer(rest, it.choice ? `${rowsText(it.data?.rows)} ${(it.data?.rows?.length ?? 0) > 1 ? 'are' : 'is'} not this song` : 'LNV rows said not to be this song: taken back')
    case 'merge': case 'fill': {
      const k = x.part.get(it.key)
      const text = kind === 'merge' ? 'Versions joined or kept apart' : `${k?.text ?? 'A blank field'} ${it.choice === 'reject' ? 'left blank' : `filled from ${x.source}`}`
      const song = k?.c.answer.song
      return song ? answer(song, text, true) : { group: it.key, songs: refs(k?.s ?? OTHER), text, minor: true }
    }
    case 'pick': {
      const [row, ...f] = rest.split(':')
      const s = x.row.get(Number(row)), field = f.join(':')
      const who = it.choice === 'lnv' ? 'the LNV’s' : it.choice === 'ipi' ? 'the IPI List’s' : it.choice === 'muso' ? `${x.source}’s` : 'typed'
      const text = it.choice ? `${field} of LNV row ${row}: ${who} “${short(list(it.data?.value).join(', '))}”` : `${field} of LNV row ${row}: choice taken back`
      // values cleared because the song left its match go with that answer
      const owner = batch.find((b) => b.key.startsWith('link:') && b.choice !== 'same' && x.song.get(b.key.slice(5))?.c.lnv.some((r) => r.row === Number(row)))
      return !it.choice && owner ? answer(owner.key.slice(5), text, true) : { group: it.key, songs: refs(s ?? OTHER), text }
    }
    case 'title': {
      const r = x.rec.get(Number(rest))
      return { group: it.key, songs: refs(r?.s ?? OTHER), text: it.choice ? `Title of “${short(r?.title ?? '')}”: “${short(list(it.data?.value).join(', '))}”` : `Title of “${short(r?.title ?? '')}”: choice taken back` }
    }
    case 'version': {
      const v = x.ver.get(it.key)
      const t = `“${short(v?.title ?? 'A version')}”`
      const row = it.data?.rows?.[0] ?? v?.row
      return { group: it.key, songs: refs(v?.s ?? OTHER), text: it.choice === 'same' ? `${t} is LNV row ${row}` : it.choice === 'none' ? `${t} is not LNV row ${row} – a row of its own` : `${t}: check taken back` }
    }
    case 'map': {
      const r = x.rec.get(Number(rest))
      const to = it.data?.to != null ? x.rec.get(Number(it.data.to)) : undefined
      const back = r?.from ? x.titles.get(r.from) : undefined
      return it.choice ? { group: `map:${it.data?.to}`, songs: refs(r?.s, to?.s), text: `“${short(r?.title ?? '')}” moved from “${short(r?.s.title ?? '')}” to “${short(to?.s.title ?? it.data?.title ?? '')}”` }
        : { group: it.key, songs: refs(r?.s, back), text: `“${short(r?.title ?? '')}” moved back to “${short(r?.from ?? '')}”` }
    }
    case 'family': {
      const k = x.song.get(rest), to = it.data?.to != null ? x.song.get(String(it.data.to)) : undefined
      const t = `“${short(k?.c.title ?? '')}”`
      // the tick that goes with it is part of adding it
      return it.choice ? { group: `answer:${rest}`, songs: refs(k?.s, to?.s), text: `${t} added to “${short(to?.s.title ?? it.data?.title ?? '')}”` }
        : { group: it.key, songs: refs(k?.s, k?.c.joined ? x.titles.get(k.c.joined.title) : undefined), text: `${t} taken out of “${short(k?.c.joined?.title ?? '')}”` }
    }
    case 'remark': {
      const r = x.remark.get(rest)
      const text = it.choice ? `Remark of “${short(r?.title ?? rest)}”: ${list(it.data?.value).join(', ')}` : `Remark of “${short(r?.title ?? rest)}” taken off`
      // given while mapping: one change with it
      const map = r ? batch.find((b) => b.key === `map:${r.id}` && b.choice) : undefined
      const to = map?.data?.to != null ? x.rec.get(Number(map.data.to)) : undefined
      return { group: map ? `map:${map.data!.to}` : `remark:${r?.c.id ?? rest}`, songs: refs(r?.s ?? OTHER, to?.s), text }
    }
    case 'song': {
      const t = x.typed.get(it.key)
      return { group: it.key, songs: refs(t?.s ?? OTHER), text: `Typed song “${short(t?.title ?? '')}” removed` }
    }
    case 'dup': case 'isrc': {
      const k = x.part.get(it.key)
      const row = it.data?.keep ?? it.data?.row
      return { group: it.key, songs: refs(k?.s ?? OTHER), text: !it.choice ? 'Answer on LNV duplicates taken back' : it.choice === 'duplicate' ? `LNV entered twice: row ${row} kept`
        : it.choice === 'owner' ? `The ISRC is on LNV row ${row}` : it.choice === 'neither' ? 'The ISRC belongs to neither row' : 'Different songs' }
    }
    default: {
      const a = it.data?.a ?? it.data?.name ?? rest
      const text = kind === 'name' ? `“${a}” and “${it.data?.b ?? ''}”: ${it.choice === 'same' ? 'one person' : it.choice === 'different' ? 'two people' : 'answer taken back'}`
        : kind === 'writer' ? `“${a}”: ${it.choice === 'ignore' ? 'not a writer' : it.choice === 'keep' ? 'a writer' : 'answer taken back'}`
          : kind === 'pub' ? `“${a}” and “${it.data?.b ?? ''}”: ${it.choice === 'same' ? 'one company' : it.choice === 'different' ? 'two companies' : 'answer taken back'}` : it.key
      return { group: it.key, songs: [OTHER], text }
    }
  }
}

/** Every decision with its line; what a screen wrote itself stays. */
export const withLog = (items: CleanDecisionIn[], x: LogContext): CleanDecisionIn[] => items.map((it) => it.log ? it : { ...it, log: describe(it, items, x) })

/** "3 changes" · "1 change". */
export const changesText = (k: number) => `${n(k)} change${k === 1 ? '' : 's'}`
