import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronRight, ExternalLink, Link2, Search, Undo2, X } from 'lucide-react'
import { Drawer } from '../../components/ui'
import { api } from '../../lib/api'
import type { CleanDecisionIn } from '../../lib/api'
import { useClient } from '../../lib/client'
import type { CaseRecord, ReviewCase, Step1, TitleMode } from '../../types'
import { cellOf, inList, list, n, norm } from './Block'

/** The parts of one song's screen in step 2, top to bottom: ① the main version (the DSP's original), ② the LNV rows
 *  that may be it, ③ the song's other DSP versions, … ⑤ the titles that go into the LNV, and the popup that maps a
 *  recording onto a song the app matched exactly. Every record is compared with the main version. */

export const value = (v?: string | string[]) => list(v).join(', ')
export const WRITERS = new Set(['Lyricist', 'Composer'])
const LISTY = new Set(['Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC'])
export const CARD_FIELDS = ['Title', 'Film / album', 'Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC', 'Year']

/** Two records hold two different values (a blank is no difference – it gets filled). */
export function differs(f: string, a: string[], b: string[]) {
  if (!a.length || !b.length) return false
  if (f === 'Year') return a[0].slice(0, 4) !== b[0].slice(0, 4)
  if (WRITERS.has(f) || f === 'Singer' || f === 'ISRC') return a.some((x) => !inList(f, b, x)) || b.some((x) => !inList(f, a, x))
  return norm(a.join(' ')) !== norm(b.join(' '))
}

export const writersOf = (r: CaseRecord) => [...new Set([...list(r.fields.Lyricist), ...list(r.fields.Composer)])]

/** How a version's credits differ from the main version's, both ways. */
export function creditsDiff(r: CaseRecord, main: CaseRecord) {
  const not = (f: string, a: string[], b: string[]) => a.filter((x) => !inList(f, b, x))
  const w = writersOf(r), mw = writersOf(main), p = list(r.fields.Publisher), mp = list(main.fields.Publisher)
  return ([['Writers also', not('Lyricist', w, mw)], ['Writers without', not('Lyricist', mw, w)],
    ['Publisher also', not('Publisher', p, mp)], ['Publisher without', not('Publisher', mp, p)]] as const).filter(([, names]) => names.length)
}

/** One numbered part of the song's screen: what it shows and what to do with it, in plain words. */
export function Block({ n: num, title, note, side, children }: { n: number; title: ReactNode; note?: ReactNode; side?: ReactNode; children: ReactNode }) {
  return (
    <section className="cv-block">
      <header className="cv-head">
        <span className="cv-n">{num}</span>
        <div className="grow"><h4>{title}</h4>{note && <p>{note}</p>}</div>
        {side}
      </header>
      {children}
    </section>
  )
}

/** What the colours mean, once above the cards. */
export const Legend = ({ source }: { source: string }) => (
  <div className="cv-legend">
    <span><i className="cv-sw diff" />differs from the main version</span>
    <span><i className="cv-sw odd" />name the main version does not have</span>
    <span><Check size={13} className="good" />checked and the same</span>
    <span><X size={13} className="bad" />checked and different</span>
    <span className="muted">Click a title or an LNV row number to see everything {source} or the LNV holds for it.</span>
  </div>
)

/** A link's name, by its site: Spotify, YouTube, Apple Music … else the site's own name. */
export function linkName(url: string) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '')
    const known: [RegExp, string][] = [[/spotify/, 'Spotify'], [/youtu/, 'YouTube'], [/apple/, 'Apple Music'], [/saavn/, 'JioSaavn'],
      [/gaana/, 'Gaana'], [/wynk/, 'Wynk'], [/amazon/, 'Amazon Music'], [/deezer/, 'Deezer'], [/soundcloud/, 'SoundCloud']]
    return known.find(([re]) => re.test(h))?.[1] ?? h
  } catch { return 'Link' }
}
/** Each link once, as a button that opens it in a new tab; from: who holds it ("LNV", "Muso"). */
export function Links({ urls, from }: { urls: (string | undefined | null)[]; from?: string }) {
  const shown = [...new Set(urls.map((u) => (u ?? '').trim()).filter((u) => /^https?:\/\//i.test(u)))]
  if (!shown.length) return null
  return (
    <span className="lk">
      {from && <small className="lk-from">{from}</small>}
      {shown.map((u) => <a key={u} className="lk-a" href={u} target="_blank" rel="noreferrer" title={u} onClick={(e) => e.stopPropagation()}>{linkName(u)}<ExternalLink size={12} /></a>)}
    </span>
  )
}
export const hasLink = (rs: (CaseRecord | undefined | null)[]) => rs.some((r) => /^https?:\/\//i.test(r?.link ?? ''))

/** A record's fields; where they differ from the main version's they are marked, the main's value written under. */
export function Fields({ r, main, fields = CARD_FIELDS }: { r: CaseRecord; main?: CaseRecord | null; fields?: string[] }) {
  const other = !!main && main !== r
  const shown = fields.filter((f) => f === 'Title' || list(r.fields[f]).length || (other && list(main!.fields[f]).length))
  return (
    <dl className="cv-fields">
      {shown.map((f) => {
        const v = list(r.fields[f]), m = other ? list(main!.fields[f]) : []
        const pool = WRITERS.has(f) ? (other ? writersOf(main!) : []) : m
        const odd = (x: string) => other && LISTY.has(f) && pool.length > 0 && !inList(WRITERS.has(f) ? 'Lyricist' : f, pool, x)
        const whole = other && !LISTY.has(f) && differs(f, v, m)
        return (
          <Fragment key={f}>
            <dt>{f}</dt>
            <dd className={`${whole ? 'cv-diff' : ''} ${f === 'ISRC' ? 'mono' : ''} ${f === 'Title' ? 'cv-ftitle' : ''}`}>
              {v.length ? v.map((x, j) => <Fragment key={j}>{j > 0 && ', '}<span className={odd(x) ? 'cv-odd' : ''}>{x}</span></Fragment>) : <span className="muted">— blank</span>}
              {whole && <small className="cv-main">Main version: {m.join(', ')}</small>}
            </dd>
          </Fragment>
        )
      })}
      {hasLink([r]) && <><dt>Link</dt><dd><Links urls={[r.link]} /></dd></>}
    </dl>
  )
}

/** What the app checked on an LNV row, in plain words: the verdict, the recording (title, album, ISRC, year) and the
 *  work (writers, publisher). */
export function Checks({ r }: { r: CaseRecord }) {
  const ch = r.check
  if (!ch) return null
  const level = ch.level === 'exact' ? ['good', 'Exact match'] : ch.level === 'possible' ? ['warn', 'Possible match']
    : ch.level === 'isrc_only' ? ['warn', 'Only the ISRC is the same'] : ['bad', 'Not the same song by the rule']
  const why = (Array.isArray(r.why) ? r.why : []).filter((w) => !w.good || w.text.startsWith('Writers: one') || w.text.startsWith('Later year'))
  const mark = (ok: boolean | undefined | null, text: string, title: string) => ok == null ? null
    : <span className={ok ? 'good' : 'bad'} title={title}>{ok ? <Check size={13} /> : <X size={13} />}{text}</span>
  const simple = ch.stage1 == null
  return (
    <div className="cv-checks">
      <b className={`cv-level ${level[0]}`}>{level[1]}</b>
      {mark(ch.stage1, 'Same recording', 'Title, album, ISRC and release year')}
      {mark(ch.stage2, 'Same work', 'Title, album, lyricist, composer and publisher')}
      {simple && mark(ch.writers === 'same' || ch.writers === 'close', ch.writers === 'blank' ? 'Writers missing' : ch.writers === 'differ' ? 'Different writers' : 'Same writers', 'Lyricists and composers')}
      {simple && ch.publisher !== 'unchecked' && mark(ch.publisher === 'same', ch.publisher === 'same' ? 'Same publisher' : 'Different publisher', 'Publisher')}
      {why.map((w) => <span key={w.text} className={w.good ? 'warn' : 'bad'}>{w.good ? '~ ' : <X size={13} />}{w.text}</span>)}
    </div>
  )
}

/** ① The DSP's main version: the original – the oldest recording with no remix, lofi or other tag. */
export function MainCard({ r, source, count, open }: { r: CaseRecord; source: string; count: number; open: () => void }) {
  return (
    <article className="cv-card main">
      <header>
        <span className="cv-badge muso">{source} · Main version</span>
        <b className="cv-title">{value(r.fields.Title)}</b>
        <span className="grow" />
        {count > 1 && <span className="muted cv-count">1 of {n(count)} {source} versions</span>}
        <button type="button" className="cv-open" onClick={open} title="Everything the sheet holds for it">All details<ChevronRight size={15} /></button>
      </header>
      <Fields r={r} />
    </article>
  )
}

/** ② One LNV row that may be the song: its row number, what the app checked, and its fields against the main version. */
export function LnvCard({ r, main, badge, tick, open, note }: {
  r: CaseRecord; main: CaseRecord | null; badge: string; open: () => void; note?: ReactNode
  tick?: { on: boolean; label: string; radio?: boolean; change: () => void }
}) {
  return (
    <article className={`cv-card lnv ${tick?.on ? 'on' : ''}`}>
      <header>
        <button type="button" className="cv-badge lnv cv-rowbtn" onClick={open} title="See everything about this LNV row">{badge}<ChevronRight size={14} /></button>
        <b className="cv-title">{value(r.fields.Title)}</b>
        <span className="grow" />
        {tick && <label className={`cv-tick ${tick.on ? 'on' : ''}`}><input type={tick.radio ? 'radio' : 'checkbox'} checked={tick.on} onChange={tick.change} />{tick.label}</label>}
      </header>
      <Checks r={r} />
      {note}
      <Fields r={r} main={main} />
    </article>
  )
}

/** Where a recording lands in the LNV with the answer on screen (SongReview's Land). */
export type Spot = { tone: 'link' | 'have' | 'new' | 'off' | 'wait'; row?: number; to: string; note: string; again?: boolean }

/** A recording's place in the LNV, as a small label: its LNV row (a link), a row of its own, or waiting. */
export function SpotLabel({ r, spot, openRow }: { r: CaseRecord; spot?: Spot; openRow: (row: number) => void }) {
  const row = spot?.row ?? r.lnv_row ?? undefined
  const tone = spot?.tone ?? (r.lnv_row ? 'have' : 'wait')
  const text = tone === 'link' ? `LNV row ${row}` : tone === 'have' ? `LNV row ${row}` : tone === 'new' ? (spot?.again ? 'Same row as the song' : 'Gets its own row')
    : tone === 'off' ? 'Not added' : 'Own row once answered'
  return (
    <span className={`rv-land ${tone}`} title={spot?.note}>
      {row && (tone === 'link' || tone === 'have') ? <button type="button" onClick={() => openRow(row)}>{text}</button> : text}
    </span>
  )
}

/** ③ The song's other DSP versions – possible matches to the main version (similar title, the same writers): each
 *  with the LNV row it has or gets, how its credits differ from the main's, and its tick when step 1 may split it. */
export function VersionList({ c, spots, merging, isIn, toggle, open, openRow, save }: {
  c: ReviewCase; spots: Spot[]; merging: boolean; isIn: (r: CaseRecord) => boolean; toggle: (id: number) => void
  open: (i: number) => void; openRow: (row: number) => void; save: (items: CleanDecisionIn[]) => Promise<boolean>
}) {
  const rest = c.muso.map((r, i) => ({ r, i })).slice(1)
  const [all, setAll] = useState(rest.length <= 10)
  const main = c.muso[0]
  return (
    <>
      <div className="cv-versions">
        {(all ? rest : rest.slice(0, 8)).map(({ r, i }) => {
          const on = isIn(r)
          const diff = creditsDiff(r, main)
          return (
            <div key={r.id ?? i} className={`cv-ver ${on ? '' : 'off'}`}>
              {merging && <input type="checkbox" checked={on} onChange={() => toggle(r.id!)} aria-label="Same song as the main version" title="Ticked: the same song as the main version. Untick a different song." />}
              <div className="grow cv-ver-main">
                <div className="cv-ver-top">
                  <button type="button" className="rv-ver-open" onClick={() => open(i)} title="Everything the sheet holds for it">{value(r.fields.Title)}</button>
                  {r.version && <span className="cv-tag">{r.version}</span>}
                </div>
                <small className="muted">{[value(r.fields['Film / album']), value(r.fields.Year).slice(0, 4), list(r.fields.ISRC)[0]].filter(Boolean).join(' · ')}</small>
                {diff.map(([label, names]) => <div key={label} className="rv-ver-diff"><span className="muted">{label}: </span><span className="cv-odd">{names.join(', ')}</span></div>)}
                {r.moved && (
                  <div className="cv-moved"><Link2 size={14} />Mapped here from “{r.moved.from}”
                    <button type="button" className="rv-text-btn" onClick={() => save([{ key: `map:${r.id}`, choice: null }])}><Undo2 size={14} />Undo</button></div>
                )}
              </div>
              <SpotLabel r={r} spot={on ? spots[i] : undefined} openRow={openRow} />
            </div>
          )
        })}
      </div>
      {!all && <button type="button" className="cs-more" onClick={() => setAll(true)}>Show all {rest.length} versions</button>}
    </>
  )
}

/* ---------- ⑤ titles ---------- */

/** One recording's line in the titles part: where it lands, the LNV title there, the app's default and the saved choice. */
export type TitleLine = {
  r: CaseRecord; i: number; spot: Spot
  lnv?: { title: string; row: number; label: string }
  def: TitleMode; saved?: { mode: TitleMode; value: string }
}
const MODES: { mode: TitleMode | 'map'; label: string }[] = [
  { mode: 'main', label: 'Same as main version' }, { mode: 'muso', label: 'Keep {source}' }, { mode: 'lnv', label: 'Keep LNV' },
  { mode: 'custom', label: 'Customise' }, { mode: 'map', label: 'Map to exact match…' },
]

/** ⑤ The titles that go into the LNV: one line per recording, the title it gets and where that title comes from –
 *  the main version, the DSP, the LNV, typed by hand – or the recording mapped onto a song the app matched exactly. */
export function TitleSection({ lines, titles, source, save, map, closed }: {
  lines: TitleLine[]; titles: Step1['titles']; source: string; save: (items: CleanDecisionIn[]) => Promise<boolean>
  map: (r: CaseRecord) => void; closed?: string
}) {
  // a choice shows at once, before the reload brings it back saved
  const [local, setLocal] = useState<Record<string, { mode: TitleMode; value: string } | null>>({})
  const [typing, setTyping] = useState<Record<string, string>>({})
  useEffect(() => { setLocal({}); setTyping({}) }, [titles])
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})

  const id = (l: TitleLine) => String(l.r.id)
  const choiceOf = (l: TitleLine) => (id(l) in local ? local[id(l)] : l.saved) ?? null
  const modeOf = (l: TitleLine): TitleMode => choiceOf(l)?.mode ?? l.def
  const muso = (l: TitleLine) => value(l.r.fields.Title)
  const main = lines.find((l) => l.i === 0)
  const plain = (l: TitleLine, mode: TitleMode): string => mode === 'muso' ? muso(l) : mode === 'lnv' ? l.lnv?.title ?? muso(l)
    : mode === 'custom' ? choiceOf(l)?.value ?? muso(l) : main && l !== main ? plain(main, modeOf(main)) : muso(l)
  const finalOf = (l: TitleLine) => plain(l, modeOf(l))
  const from = (l: TitleLine) => {
    const m = modeOf(l)
    return m === 'main' ? 'Same as main version' : m === 'muso' ? `From ${source}` : m === 'lnv' ? `From ${l.lnv?.label ?? 'the LNV'}` : 'Typed by you'
  }

  /** Save one line's choice; a new main title is carried to every line that follows the main version. */
  const choose = (l: TitleLine, mode: TitleMode, typed?: string) => {
    const text = mode === 'custom' ? (typed ?? '').trim() : plain(l, mode)
    if (mode === 'custom' && !text) return
    const clear = mode === l.def && mode !== 'custom'
    const items: CleanDecisionIn[] = [clear ? { key: `title:${l.r.id}`, choice: null } : { key: `title:${l.r.id}`, choice: mode, data: { value: text } }]
    const next: Record<string, { mode: TitleMode; value: string } | null> = { [id(l)]: clear ? null : { mode, value: text } }
    if (l === main) {
      lines.filter((x) => x !== main && modeOf(x) === 'main').forEach((x) => {
        items.push({ key: `title:${x.r.id}`, choice: 'main', data: { value: text } })
        next[id(x)] = { mode: 'main', value: text }
      })
    }
    setLocal((x) => ({ ...x, ...next }))
    void save(items)
  }
  const startCustom = (l: TitleLine) => {
    setTyping((x) => ({ ...x, [id(l)]: finalOf(l) }))
    setLocal((x) => ({ ...x, [id(l)]: { mode: 'custom', value: finalOf(l) } }))
    setTimeout(() => inputs.current[id(l)]?.select(), 0)
  }
  const endCustom = (l: TitleLine) => {
    const text = (typing[id(l)] ?? '').trim()
    if (text && (l.saved?.mode !== 'custom' || l.saved.value !== text)) choose(l, 'custom', text)
  }

  if (closed) return <p className="cv-none">{closed}</p>
  if (!lines.length) return <p className="cv-none">No recording of this song goes into the LNV yet.</p>
  return (
    <div className="cv-titles">
      {lines.map((l) => {
        const mode = modeOf(l)
        const moved = l.r.moved
        return (
          <div key={id(l)} className={`cv-tl ${l.i === 0 ? 'main' : ''}`}>
            <div className="cv-tl-head">
              <span className="cv-tl-rec">
                <b>{muso(l)}</b>
                <span className={`cv-tag ${l.i === 0 ? 'main' : ''}`}>{l.i === 0 ? 'Main version' : l.r.version ?? 'Version'}</span>
              </span>
              <span className="grow" />
              <span className="cv-tl-goes"><ArrowRight size={14} />{l.spot.tone === 'off' ? 'Not added' : l.spot.to}</span>
            </div>
            {moved ? (
              <div className="cv-moved"><Link2 size={14} />Mapped here from “{moved.from}”
                <button type="button" className="rv-text-btn" onClick={() => save([{ key: `map:${l.r.id}`, choice: null }])}><Undo2 size={14} />Undo</button></div>
            ) : null}
            <div className="cv-modes" role="radiogroup" aria-label={`Title for ${muso(l)}`}>
              {MODES.filter((m) => !(m.mode === 'main' && l.i === 0)).map((m) => {
                const on = m.mode === mode
                const off = m.mode === 'lnv' && !l.lnv
                const hint = m.mode === 'map' ? 'Add this version, or every version of the song, to a song the app matched exactly'
                  : m.mode === 'custom' ? 'Type the title' : off ? 'This recording has no LNV row yet' : plain(l, m.mode as TitleMode)
                return (
                  <button key={m.mode} type="button" role={m.mode === 'map' ? undefined : 'radio'} aria-checked={m.mode === 'map' ? undefined : on}
                    className={`cv-mode ${on ? 'on' : ''} ${m.mode === 'map' ? 'map' : ''}`} disabled={off} title={hint}
                    onClick={() => m.mode === 'map' ? map(l.r) : m.mode === 'custom' ? startCustom(l) : choose(l, m.mode as TitleMode)}>
                    {on && <Check size={14} />}{m.label.replace('{source}', source)}{m.mode === l.def && <small> (as is)</small>}
                  </button>
                )
              })}
            </div>
            {mode === 'custom' && (
              <input ref={(el) => { inputs.current[id(l)] = el }} className="cv-custom" value={typing[id(l)] ?? choiceOf(l)?.value ?? ''}
                onChange={(e) => setTyping((x) => ({ ...x, [id(l)]: e.target.value }))} onBlur={() => endCustom(l)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} placeholder="Type the title for the LNV" aria-label="Custom title" />
            )}
            <div className="cv-final">
              <span className="muted">Title in the LNV</span>
              <b>{finalOf(l)}</b>
              <span className={`cv-from ${mode}`}>{from(l)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ---------- map onto an exact match ---------- */

/** A song the app matched exactly: what a recording can be mapped onto. */
export type Target = {
  c: ReviewCase; row: number; to: number; title: string; film: string; writers: string; isrcs: string[]
  /** how the Songs list matched it, and the song name it sits under there */
  match?: 'exact' | 'possible'; family?: string
}

export function targetsOf(cases: ReviewCase[], exact: (c: ReviewCase) => boolean): Target[] {
  return cases.filter((c) => exact(c) && c.muso[0]?.id != null && !c.muso[0].moved).flatMap((c) => {
    const row = c.answer.rows?.[0] ?? c.lnv.find((r) => r.check?.level === 'exact')?.row ?? c.lnv[0]?.row
    if (!row) return []
    const lnv = c.lnv.find((r) => r.row === row)
    return [{ c, row, to: c.muso[0].id!, title: value(lnv?.fields.Title) || c.title, film: value(lnv?.fields['Film / album'] ?? c.muso[0].fields['Film / album']),
      writers: writersOf(lnv ?? c.muso[0]).join(', '), isrcs: [...list(lnv?.fields.ISRC), ...list(c.muso[0].fields.ISRC)], match: 'exact' as const }]
  })
}

/** The popup that maps a recording – or every recording of its song – onto a song the app matched exactly: search,
 *  pick the song, then say whether only this version or all of them join it. They become that song's versions, each
 *  with a row of its own naming its LNV row (or linked to the version row the LNV has), and fill what it lacks. */
export function MapDialog({ c, rec, recs, targets, source, close, save, done, link }: {
  c: ReviewCase; rec: CaseRecord; recs: CaseRecord[]; targets: Target[]; source: string; close: () => void
  save: (items: CleanDecisionIn[]) => Promise<boolean>; done: (all: boolean, t: Target) => void
  /** a "Not in the LNV" song: it can also be that song itself – linked to the LNV row, no row of its own */
  link?: (t: Target) => void
}) {
  const base = c.title.replace(/\s*[-–(\[].*$/, '').trim()
  const [q, setQ] = useState(base)
  const [picked, setPicked] = useState<Target | null>(null)
  const [busy, setBusy] = useState(false)
  const found = useMemo(() => {
    const s = norm(q)
    const words = q.toLowerCase().split(/\s+/).map(norm).filter((w) => w.length > 2)
    return targets.filter((t) => t.c.id !== c.id)
      .map((t) => {
        const hay = norm(`${t.title} ${t.c.title} ${t.family ?? ''} ${t.film} ${t.writers} ${t.isrcs.join(' ')} ${t.row}`)
        const score = !s ? 1 : hay.includes(s) ? 3 + (norm(t.title).startsWith(s) ? 2 : 0) : words.filter((w) => hay.includes(w)).length / Math.max(1, words.length)
        return { t, score }
      })
      .filter((x) => x.score >= (s ? 0.5 : 0))
      .sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title))
      .slice(0, 80).map((x) => x.t)
  }, [q, targets, c.id])
  const go = async (all: boolean) => {
    if (!picked) return
    setBusy(true)
    const ids = (all ? recs : [rec]).map((r) => r.id!).filter((x) => x != null && x !== picked.to)
    const ok = await save(ids.map((x) => ({ key: `map:${x}`, choice: 'join' as const, data: { to: picked.to, row: picked.row, title: picked.title, from: c.title } })))
    setBusy(false)
    if (ok) { done(all, picked); close() }
  }
  return (
    <Drawer open onClose={close} title={link ? <>Map to a song in the LNV</> : <>Map to an exact match</>}
      subtitle={<span className="muted">“{value(rec.fields.Title)}” – {link
        ? `pick the exact or possible match in Songs that it is: search its title, film, writer, ISRC or LNV row.`
        : 'pick the song the app matched exactly that this recording belongs to.'}</span>}>
      {!picked ? (
        <div className="mp">
          <label className="cs-search mp-search"><Search size={17} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a title, film, writer, ISRC or LNV row…" /></label>
          <p className="muted mp-count">{n(found.length)} {link ? 'song' : 'exact match'}{found.length === 1 ? '' : link ? 's' : 'es'}{q ? ` for “${q}”` : ''}{found.length === 80 ? ' (first 80 – type more to narrow)' : ''}</p>
          <div className="mp-list">
            {!found.length && <p className="cv-none">No {link ? 'exact or possible match' : 'song the app matched exactly'} fits. Try fewer words, the film, a writer or an ISRC.</p>}
            {found.map((t) => {
              const isrc = t.isrcs.find((x) => norm(q).length >= 4 && norm(x).includes(norm(q))) ?? t.isrcs[0]
              return (
                <button key={`${t.c.id}:${t.row}`} type="button" className="mp-item" onClick={() => setPicked(t)}>
                  <span className="cv-badge lnv">LNV row {t.row}</span>
                  {link && t.match && <span className={`mp-match ${t.match}`}>{t.match === 'exact' ? 'Exact' : 'Possible'}</span>}
                  <span className="grow mp-text"><b>{t.title}</b>
                    <small className="muted">{[norm(t.c.title) !== norm(t.title) && `${source}: ${t.c.title}`, t.film, t.writers].filter(Boolean).join(' · ')}</small>
                    {isrc && <small className="mp-isrc mono">ISRC {isrc}{t.isrcs.length > 1 ? ` +${t.isrcs.length - 1}` : ''}</small>}</span>
                  <span className="muted mp-vers">{t.c.muso.length} {source} version{t.c.muso.length === 1 ? '' : 's'}</span>
                  <ChevronRight size={16} />
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="mp mp-ask">
          <button type="button" className="rv-text-btn" onClick={() => setPicked(null)}>← Back to the search</button>
          <div className="mp-target">
            <span className="cv-badge lnv">LNV row {picked.row}</span>
            {link && picked.match && <span className={`mp-match ${picked.match}`}>{picked.match === 'exact' ? 'Exact match' : 'Possible match'}</span>}
            <b>{picked.title}</b>
            <small className="muted">{[picked.film, picked.writers, picked.isrcs[0] && `ISRC ${picked.isrcs.join(', ')}`].filter(Boolean).join(' · ')}</small>
          </div>
          {link && <>
            <h3>Is “{value(rec.fields.Title)}” this song?</h3>
            <div className="mp-choices one">
              <button type="button" className="mp-choice main" disabled={busy} onClick={() => { link(picked); close() }}>
                <b>Yes – the same song as LNV row {picked.row}</b>
                <span>“{c.title}” is linked to it: no row of its own</span>
                <small className="muted">It moves to Songs, under that row; what the LNV row leaves blank is filled from {source}. Undo is on the song.</small>
              </button>
            </div>
            <h3 className="mp-or">Or a version of it – which recordings join “{picked.title}”?</h3>
          </>}
          {!link && <h3>Add which recordings to “{picked.title}”?</h3>}
          <div className="mp-choices">
            <button type="button" className="mp-choice" disabled={busy} onClick={() => go(false)}>
              <b>Only this version</b>
              <span>“{value(rec.fields.Title)}”{rec.version ? ` · ${rec.version}` : ''}</span>
              <small className="muted">The rest of “{c.title}” stays where it is.</small>
            </button>
            {recs.length > 1 && (
              <button type="button" className="mp-choice" disabled={busy} onClick={() => go(true)}>
                <b>All {recs.length} versions of this song</b>
                <span>“{c.title}” and its versions</span>
                <small className="muted">The whole song becomes part of “{picked.title}”.</small>
              </button>
            )}
          </div>
          <p className="muted mp-what">They become versions of LNV row {picked.row}: each gets a row of its own naming it as the original (or joins the version row the LNV already has), and fills what that song’s rows leave blank. Undo is on the song they join.</p>
          {busy && <div className="loading"><span className="spinner" />Saving…</div>}
        </div>
      )}
    </Drawer>
  )
}

/* ---------- shared by the review screens ---------- */

export const SHOW = ['Title', 'Film / album', 'Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC', 'Year']
export const RULE = {
  writers: { same: ['good', 'Same writers'], close: ['good', 'Writers: one name extra'], differ: ['bad', 'Different writers'], blank: ['warn', 'Writers missing – cannot check'] },
  publisher: { same: ['good', 'Same publisher'], differ: ['bad', 'Different publisher'], unchecked: ['warn', 'Publisher not checked'] },
} as const
export const DECIDES = new Set(['Title', 'Lyricist', 'Composer'])

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="sm-kbd">{children}</kbd>

/** Enter / A = confirm, R = keep the versions apart, U = undo, ↑ ↓ = move – while not typing. */
export function useKeys(keys: Record<string, () => void>) {
  const ref = useRef(keys)
  ref.current = keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.drawer, .modal')) return
      const t = e.target as HTMLElement
      const tick = t instanceof HTMLInputElement && (t.type === 'checkbox' || t.type === 'radio')   // keys still work after a tick
      if (/^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !tick)) return
      if (e.key === 'Enter' && /^(BUTTON|A)$/.test(t.tagName)) return
      const fn = ref.current[e.key === 'Enter' ? 'enter' : e.key.toLowerCase()]
      if (!fn) return
      e.preventDefault()
      fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** One column of a comparison: a record (Muso version, LNV row, IPRS work), its badge, and – when it can be
 *  chosen – the tick that chooses it. */
export type Col = {
  r: CaseRecord; badge: string; tone: 'muso' | 'lnv' | 'iprs' | 'add'
  pick?: { on: boolean; label: string; radio?: boolean; change: () => void }
  open?: () => void
}


/** The same-song checks over a record's column: why it fits or not, in a few words. */
function Marks({ r, ref }: { r: CaseRecord; ref?: CaseRecord | null }) {
  const ch = r.check
  if (ch && ch.stage1 !== undefined && ch.stage1 !== null) {
    // the user's rule: stage 1 the recording, stage 2 the work; both = exact, one = possible
    const failed = (Array.isArray(r.why) ? r.why : []).filter((w) => !w.good || w.text.startsWith('Writers: one') || w.text.startsWith('Later year'))
    const level = ch.level === 'exact' ? 'Exact match' : ch.level === 'possible' ? 'Possible match' : ch.level === 'isrc_only' ? 'Only the ISRC is the same' : ''
    return (
      <div className="rvc-marks">
        {level && <b className={`rvc-level ${ch.level}`}>{level}</b>}
        <span className={ch.stage1 ? 'good' : 'bad'} title="The recording: song name, album, ISRC, release year">{ch.stage1 ? <Check size={12} /> : <X size={12} />}Same recording</span>
        <span className={ch.stage2 ? 'good' : 'bad'} title="The work: song name, album, lyricist, composer, publisher">{ch.stage2 ? <Check size={12} /> : <X size={12} />}Same work</span>
        {failed.map((w) => <span key={w.text} className={w.good ? 'warn' : 'bad'}>{w.good ? '~' : <X size={12} />}{w.text}</span>)}
      </div>
    )
  }
  const why = Array.isArray(r.why) ? r.why.filter((w) => !w.good || w.text.startsWith('Same')) : []
  const marks = why.length ? why.map((w) => [w.good ? 'good' : 'bad', w.text.split(' – ')[0]] as const)
    : r.check ? (['writers', 'publisher'] as const).map((k) => RULE[k][r.check![k] as keyof typeof RULE[typeof k]] as readonly [string, string]) : []
  if (!marks.length) return null
  // the rule looks at every version and at one company under two names: the names on screen may differ, so do not say "same"
  const pubs = list(ref?.fields.Publisher)
  const renamed = pubs.length > 0 && !list(r.fields.Publisher).some((x) => inList('Publisher', pubs, x))
  const worded = marks.map(([tone, text]) => [tone, text === 'Same publisher' && renamed ? 'Publisher counted as same' : text] as const)
  const wrong = worded.filter(([tone, text]) => tone !== 'good' || text === 'Publisher counted as same')
  return <div className="rvc-marks">{(wrong.length ? wrong : [['good', 'Matches'] as const]).map(([tone, text]) => <span key={text} className={tone}>{tone === 'good' ? <Check size={12} /> : tone === 'bad' ? <X size={12} /> : '?'}{text}</span>)}</div>
}

/** Records side by side, one column each and one line per field, so every difference sits on the same line. The
 *  title is marked against the `base` column; among the writers, only the names the other side does not have are. */
export function Compare({ cols, fields = SHOW, base = 0 }: { cols: Col[]; fields?: string[]; base?: number | null }) {
  const ref = base == null ? null : cols[base]?.r
  const rows = fields.filter((f) => DECIDES.has(f) || cols.some((c) => list(c.r.fields[f]).length))
  const odd = (f: string, i: number, x: string) => {
    if (base == null || !WRITERS.has(f) || cols.length < 2) return false
    // the backend knows aliases and group members: a column it calls the same writers has no odd names
    const sameWriters = (r: CaseRecord) => r.check?.writers === 'same' || (Array.isArray(r.why) && r.why.some((w) => w.text === 'Same writers'))
    if (i !== base && sameWriters(cols[i].r)) return false
    // lyricist or composer does not matter: DSPs list everyone under both, so a name counts if it is anywhere on the other side
    const against = i === base ? cols.filter((_, j) => j !== base).map((c) => c.r) : [ref!]
    return against.every((o) => !sameWriters(o) && writersOf(o).length > 0 && !inList(f, writersOf(o), x))
  }
  return (
    <table className="rvc" style={{ minWidth: 100 + cols.length * 240 }}>
      <thead>
        <tr>
          <th className="rvc-f" />
          {cols.map((c, i) => (
            <th key={i} className={`rvc-h ${c.tone} ${c.pick?.on ? 'on' : ''}`}>
              {c.open ? <button type="button" className="rvc-name rvc-open" onClick={c.open} title="See everything about it">{c.badge}<ChevronRight size={14} /></button> : <span className="rvc-name">{c.badge}</span>}
              {c.pick && <label className="rvc-pick"><input type={c.pick.radio ? 'radio' : 'checkbox'} checked={c.pick.on} onChange={c.pick.change} />{c.pick.label}</label>}
              <Marks r={c.r} ref={i === base ? null : ref} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => (
          <tr key={f}>
            <th className="rvc-f">{f}</th>
            {cols.map((c, i) => {
              const v = list(c.r.fields[f])
              const cell = ref && i !== base && f === 'Title' ? cellOf(f, list(ref.fields[f]), v) : ''
              return <td key={i} className={`${cell ? `c-${cell}` : ''} ${f === 'Title' ? 'rvc-title' : ''} ${f === 'ISRC' || f === 'IPRS code' || f === 'ISWC' ? 'mono' : ''}`}>
                {v.length ? v.map((x, j) => <Fragment key={j}>{j > 0 && ', '}<span className={odd(f, i, x) ? 'rvc-odd' : ''}>{x}</span></Fragment>) : <span className="muted">—</span>}</td>
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** One answer of a case: green when it is the chosen one (Enter), otherwise its own key. */
export function Act({ on, k, onClick, disabled, children }: { on?: boolean; k?: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return <button type="button" className={`btn sm-big ${on ? 'primary' : ''}`} disabled={disabled} onClick={onClick}>{on && <Check size={15} />}{children}{on ? <Kbd>Enter</Kbd> : k && <Kbd>{k}</Kbd>}</button>
}

/** A part of a case that folds: its heading opens and closes it, and the choice is remembered. */
export function Part({ id, title, note, initial = true, children }: { id: string; title: ReactNode; note?: ReactNode; initial?: boolean; children: ReactNode }) {
  const [open, setOpen] = useStored(`mrm-part-${id}`, initial)
  return (
    <section className={`rv-sec ${open ? '' : 'shut'}`}>
      <button type="button" className="rv-sec-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={15} className="rv-chev" /><b>{title}</b>{note && <small className="muted">{note}</small>}
      </button>
      {open && <div className="rv-sec-body">{children}</div>}
    </section>
  )
}

/** A yes/no the viewer chose before (folded parts, the wide case, the slim sidebar), kept in this browser. */
export function useStored(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { const x = localStorage.getItem(key); return x == null ? initial : x === '1' } catch { return initial } })
  return [v, (x: boolean) => { setV(x); try { localStorage.setItem(key, x ? '1' : '0') } catch { /* private mode */ } }]
}

/** The sheet's columns under plain headings; a column no heading claims goes under "More". */
export const GROUPS: [string, RegExp][] = [
  ['Credits', /artist|singer|lyricist|composer|author|writer|producer|engineer|publisher|credit|role/i],
  ['Release', /title|song|album|type of|date|label|upc|track count|line/i],
  ['Recording', /isrc|duration|length|genre|popularity|bpm|key/i],
  ['Links and IDs', /link|url|\bid\b/i],
]
export function grouped(fields: { name: string; value: string }[]) {
  const of = (name: string) => (/link|url|\bid\b/i.test(name) ? 'Links and IDs' : /label/i.test(name) ? 'Release' : GROUPS.find(([, test]) => test.test(name))?.[0] ?? 'More')
  return [...GROUPS.map(([g]) => g), 'More'].map((g) => [g, fields.filter((f) => of(f.name) === g)] as const).filter(([, x]) => x.length)
}

/** ← → in a popup: previous / next, while the keyboard is not typing. */
export function useArrows(prev: (() => void) | null, next: (() => void) | null) {
  const ref = useRef({ prev, next })
  ref.current = { prev, next }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      const fn = e.key === 'ArrowLeft' ? ref.current.prev : e.key === 'ArrowRight' ? ref.current.next : null
      if (!fn) return
      e.preventDefault()
      fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Previous / next buttons and "2 of 19" in a popup's head. */
export const PopNav = ({ label, at, total, go }: { label: string; at: number; total: number; go: (i: number) => void }) => total > 1 ? (
  <span className="pop-nav">
    <span className="muted">{label} {at + 1} of {total}</span>
    <button type="button" className="sm-nav" disabled={at === 0} onClick={() => go(at - 1)} title="Previous (←)" aria-label="Previous"><ArrowLeft size={17} /></button>
    <button type="button" className="sm-nav" disabled={at === total - 1} onClick={() => go(at + 1)} title="Next (→)" aria-label="Next"><ArrowRight size={17} /></button>
  </span>
) : null

/** Everything the sheet holds for one version, in a popup over most of the screen: first its main fields against the
 *  main version's, then every column of its sheet row. ← → go to the previous / next version. A recording listed on
 *  several sheet rows shows one row at a time. */
export function VersionDetails({ r, main, at, total, source, go, close }: { r: CaseRecord; main: CaseRecord; at: number; total: number; source: string; go: (i: number) => void; close: () => void }) {
  const { clientId } = useClient()
  const [rows, setRows] = useState<{ row: number; fields: { name: string; value: string }[] }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState(0)
  useEffect(() => {
    let on = true
    setRows(null); setError(null); setTab(0)
    api.cleanRows(clientId, r.sheet_rows ?? []).then((x) => { if (on) setRows(x.rows) }).catch((e) => { if (on) setError((e as Error).message) })
    return () => { on = false }
  }, [clientId, r])
  useArrows(at > 0 ? () => go(at - 1) : null, at < total - 1 ? () => go(at + 1) : null)
  const row = rows?.[tab]
  return (
    <Drawer open onClose={close} title={value(r.fields.Title)} subtitle={
      <div className="rv-det-sub">
        <span className={`cv-tag ${at === 0 ? 'main' : ''}`}>{at === 0 ? 'Main version' : r.version ?? 'Version'}</span>
        <span className="muted">{source}</span>
        <PopNav label="Version" at={at} total={total} go={go} />
      </div>}>
      <section className="pop-glance">
        <h4>{at === 0 ? 'The main version' : 'Compared with the main version'}</h4>
        <Fields r={r} main={at === 0 ? null : main} />
      </section>
      {error ? <div className="alert bad">{error}</div> : !rows ? <div className="loading"><span className="spinner" />Loading…</div> : !row ? <p className="muted">This row is no longer in the sheet.</p> : (
        <>
          {rows.length > 1 && <div className="rv-tabs rv-det-tabs">{rows.map((x, i) => <button key={x.row} type="button" className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>Sheet row {x.row}</button>)}</div>}
          <div className="pop-groups">
            {grouped(row.fields).map(([g, fields]) => (
              <section key={g} className="rv-det">
                <h4>{g}</h4>
                <dl>{fields.map((f) => <Fragment key={f.name}><dt>{f.name}</dt><dd>{/^https?:\/\//.test(f.value) ? <a href={f.value} target="_blank" rel="noreferrer">{f.value}<ExternalLink size={12} /></a> : f.value}</dd></Fragment>)}</dl>
              </section>
            ))}
          </div>
        </>
      )}
    </Drawer>
  )
}

/** One LNV row with what each file holds for it, side by side. ← → go through the LNV rows of the song's screen. */
export function LnvRowDetails({ row, rows, go, close }: { row: number; rows: number[]; go: (row: number) => void; close: () => void }) {
  const { clientId } = useClient()
  const [records, setRecords] = useState<CaseRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let on = true
    setRecords(null); setError(null)
    api.stepRow(clientId, row).then((r) => { if (on) setRecords(r as CaseRecord[]) }).catch((e) => { if (on) setError((e as Error).message) })
    return () => { on = false }
  }, [clientId, row])
  const at = Math.max(0, rows.indexOf(row))
  const total = rows.includes(row) ? rows.length : 1
  useArrows(at > 0 ? () => go(rows[at - 1]) : null, at < total - 1 ? () => go(rows[at + 1]) : null)
  const lnv = records?.findIndex((r) => r.src === 'LNV') ?? -1
  return (
    <Drawer open onClose={close} title={`LNV row ${row}`} subtitle={
      <div className="rv-det-sub"><span className="muted">What each file holds for this song</span>
        <PopNav label="LNV row" at={at} total={total} go={(i) => go(rows[i])} /></div>}>
      {error ? <div className="alert bad">{error}</div> : !records ? <div className="loading"><span className="spinner" />Loading…</div> : (
        <div className="rv-table-wrap"><Compare base={lnv >= 0 ? lnv : null} fields={[...SHOW, 'Alternate title', 'ISWC', 'IPRS code', 'Language', 'Label', 'Length']}
          cols={records.map((r): Col => ({ r, tone: r.src === 'LNV' ? 'lnv' : r.src === 'IPRS' ? 'iprs' : 'muso', badge: r.src === 'LNV' ? `LNV row ${r.row ?? ''}` : r.src === 'IPRS' ? r.ref ?? 'IPRS' : r.src }))} /></div>
      )}
    </Drawer>
  )
}
