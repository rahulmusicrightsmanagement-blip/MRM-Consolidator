import type { CaseRecord, MatchClass } from '../../types'
import { list } from './Block'
import { shownOf } from './reviewModel'

/** Step 2's sections (v2.0) and what a match has in common with the song – no React here: unit-tested in Node.
 *  Every match starts in To check, compared with the main version; the reviewer puts it in Original (the song itself:
 *  the first one put there is its ONE row in the LNV, the titles of the others its Alternative work name), Other
 *  version (remix, lofi …: a row of its own) or Deleted (out of the LNV). Nothing goes into a section by itself – the
 *  main version's ISRC is only a suggestion. */

export const CLASSES: MatchClass[] = ['exact', 'version', 'deleted']
export const CLASS_NAME: Record<MatchClass, string> = { exact: 'Original', version: 'Other version', deleted: 'Deleted' }
/** A section saved by v1.8 (Possible match) is an other version now: a row of its own, as before. */
export const savedClass = (x: string | null | undefined): MatchClass | null => x === 'possible' ? 'version' : x === 'exact' || x === 'version' || x === 'deleted' ? x : null
/** The decision a section is saved under: an LNV row, or a recording beside no LNV row. */
export const rowClassKey = (row: number) => `class:${row}`
export const recClassKey = (id: number) => `class:m${id}`

/** What the screen suggests for a match nobody checked yet (review.default_class): the main version's ISRC – Original;
 *  a version the LNV has – Other version; else nothing. */
export function defaultClass(lnvIsrcs: string[], mainIsrcs: string[], version: boolean): MatchClass | null {
  return lnvIsrcs.some((i) => mainIsrcs.includes(i)) ? 'exact' : version ? 'version' : null
}

const LEGAL = new Set(['the', 'm', 's', 'pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'co', 'company', 'corp', 'india', 'indian', 'music',
  'musics', 'entertainment', 'records', 'recording', 'recordings', 'digital', 'media', 'films', 'film', 'productions', 'production', 'pictures',
  'studio', 'studios', 'label', 'worldwide', 'global', 'international', 'industries', 'and', 'of'])
const ALIAS: Record<string, string> = { tseries: 'super', hmv: 'saregama', gramophone: 'saregama', yrf: 'yash', sme: 'sony' }
/** A company as words that tell it apart – 'Saregama India Ltd' and 'Saregama' are one, 'T-Series' is Super Cassettes. */
export function companyWords(name: string): Set<string> {
  const flat = name.toLowerCase().replace(/t[\s-]*series/g, 'tseries').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return new Set(flat.split(' ').filter((w) => w.length >= 2 && !LEGAL.has(w)).map((w) => ALIAS[w] ?? w))
}
/** A person's name as a key: case, dots and spaces aside ('A.R. Rahman' is 'AR Rahman'). */
export const personKey = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** What a match has in common with its song: the ISRC, a singer, the production (label) – null where a side has none. */
export type Facts = { isrc: boolean; singer: boolean | null; production: boolean | null }
export function factsOf(lnv: CaseRecord, recs: CaseRecord[]): Facts {
  const li = list(lnv.fields.ISRC)
  const isrc = li.length > 0 && recs.some((r) => list(r.fields.ISRC).some((i) => li.includes(i)))
  const ls = shownOf(lnv, 'Singer').map(personKey).filter(Boolean)
  const ms = recs.flatMap((r) => shownOf(r, 'Singer')).map(personKey).filter(Boolean)
  const singer = ls.length && ms.length ? ms.some((x) => ls.includes(x)) : null
  const lw = list(lnv.fields.Label).flatMap((x) => [...companyWords(x)])
  const mw = recs.flatMap((r) => list(r.fields.Label)).flatMap((x) => [...companyWords(x)])
  const production = lw.length && mw.length ? mw.some((w) => lw.includes(w)) : null
  return { isrc, singer, production }
}

/** The song list's filters: songs with an ISRC match, a singer match, a production match. */
export type FactFilter = 'all' | 'isrc' | 'singer' | 'production'
export const FACT_NAME: Record<Exclude<FactFilter, 'all'>, string> = { isrc: 'ISRC match', singer: 'Singer match', production: 'Production match' }
