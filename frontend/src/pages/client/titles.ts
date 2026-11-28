import type { Step1, TitleMode } from '../../types'
import { value } from './CaseParts'
import type { Family, Group, Pending } from './Families'
import { pickKey } from './reviewModel'

/** The title each recording of a song name gets in the LNV – and where it comes from. No React here. */

/** A recording's title line: the recording, the LNV title where it lands, and the title it keeps when nothing is chosen. */
export type Line = { id: number; muso: string; lnv?: string; label?: string; def: TitleMode }

export function titleModel(f: Family, d: Step1, p: Pending) {
  const lines = new Map<number, Line>()
  ;f.groups.flatMap((g) => g.entries).forEach((e) => {
    if (e.tr.id == null || lines.has(e.tr.id)) return
    const earlier = d.picks[pickKey(e.row, 'Title')] !== undefined   // a title taken from the DSP before stays the DSP's
    lines.set(e.tr.id, { id: e.tr.id, muso: value(e.tr.fields.Title), lnv: value(e.lnv.fields.Title) || undefined, label: `LNV row ${e.row}`, def: earlier ? 'muso' : 'lnv' })
  })
  ;[...f.rest, ...(f.solos ?? [])].forEach(({ r }) => { if (r.id != null && !lines.has(r.id)) lines.set(r.id, { id: r.id, muso: value(r.fields.Title), def: 'muso' }) })
  const main = f.main
  const mainLine: Line = (main.id != null && lines.get(main.id)) || { id: main.id ?? -1, muso: value(main.fields.Title), def: 'muso' }
  const choiceOf = (id: number) => (String(id) in p.titles ? p.titles[String(id)] : d.titles?.[String(id)]) ?? undefined
  const modeOf = (l: Line): TitleMode => choiceOf(l.id)?.mode ?? l.def
  const finalOf = (l: Line, mode: TitleMode = modeOf(l), text?: string): string =>
    mode === 'muso' ? l.muso : mode === 'lnv' ? l.lnv ?? l.muso : mode === 'custom' ? text ?? choiceOf(l.id)?.value ?? l.muso
      : l.id === mainLine.id ? l.muso : finalOf(mainLine)
  return { lines, mainLine, choiceOf, modeOf, finalOf }
}

/** The title a match's LNV rows get. */
export function titleOf(d: Step1, p: Pending, f: Family, g: Group): string {
  const t = titleModel(f, d, p)
  const l = g.trs.flatMap((r) => (r.id != null && t.lines.get(r.id)) || [])[0]
  return l ? t.finalOf(l) : value(g.lnv.fields.Title)
}
