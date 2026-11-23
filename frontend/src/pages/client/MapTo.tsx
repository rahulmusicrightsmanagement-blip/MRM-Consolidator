import { useMemo, useState } from 'react'
import { Check, ChevronRight, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Drawer, Dropdown } from '../../components/ui'
import type { CleanDecisionIn } from '../../lib/api'
import type { CaseRecord, RemarkChoice, ReviewCase, Step1 } from '../../types'
import { n, norm } from './Block'
import type { Family, Pending } from './Families'
import { mapItems, remarkItems, remarkOf, spotsFor } from './remarkModel'
import type { Spot } from './remarkModel'

/** The Remark dropdown: why a song is mapped. Its choices are one list for every user (Settings); a removed one stays on
 *  the songs that have it. */
export function RemarkPick({ d, now, pick, busy }: { d: Step1; now: ReturnType<typeof remarkOf>; pick: (r: RemarkChoice | null) => void; busy?: boolean }) {
  const list = d.remark_list ?? []
  const name = now === 'mixed' ? '' : now?.name ?? ''
  const at = now && now !== 'mixed' ? list.find((r) => r.id === now.id) : undefined
  return (
    <Dropdown className={`rm-dd ${name ? 'on' : ''}`} label="Remark" menuWidth={420} value={now === 'mixed' ? 'mixed' : at ? String(at.id) : name ? 'old' : 'none'}
      shown={now === 'mixed' ? 'Several remarks' : name || 'No remark'}
      options={[{ value: 'none', label: 'No remark', disabled: busy },
        ...(name && !at ? [{ value: 'old', label: name, hint: 'Removed in Settings – this song keeps it', disabled: true }] : []),
        ...list.map((r, i) => ({ value: String(r.id), label: r.name, hint: r.help || undefined, sep: i === 0, disabled: busy }))]}
      onChange={(v) => pick(v === 'none' ? null : list.find((r) => String(r.id) === v) ?? null)} />
  )
}

const FROM = [['all', 'Muso and LNV'], ['muso', 'Muso list'], ['lnv', 'LNV list']] as const
const MATCH = [['all', 'Exact and possible'], ['exact', 'Exact match'], ['possible', 'Possible match']] as const

/** Map a song that is not in the LNV to an existing ISRC / song: an exact or possible match, of the Muso list or the LNV
 *  list, found by its title, ISRC, film, writer or LNV row – with the remark saying why. */
export function MapTo({ c, recs, families, d, p, save, close, done, same }: {
  c: ReviewCase; recs: CaseRecord[]; families: Family[]; d: Step1; p: Pending
  save: (items: CleanDecisionIn[]) => Promise<boolean>; close: () => void
  /** mapped as a version: was it the whole song? */
  done: (all: boolean, s: Spot) => void
  /** it is that very song: linked to the LNV row, no row of its own */
  same: (row: number, title: string) => void
}) {
  const all = useMemo(() => spotsFor(c, families, p), [c, families, p])
  const hits = (q: string, xs: Spot[]) => { const s = norm(q); return xs.filter((x) => !s || norm(`${x.title} ${x.family} ${x.film} ${x.writers} ${x.isrcs.join(' ')} ${x.row ?? ''}`).includes(s)) }
  const base = c.title.replace(/\s*[-–(\[].*$/, '').trim()
  const [q, setQ] = useState(() => (hits(base, all).length ? base : ''))
  const [from, setFrom] = useState<(typeof FROM)[number][0]>('all')
  const [match, setMatch] = useState<(typeof MATCH)[number][0]>('all')
  const [at, setAt] = useState<Spot | null>(null)
  const [how, setHow] = useState<'version' | 'same'>('version')
  const [whole, setWhole] = useState(true)
  const start = remarkOf(d, recs)
  const [remark, setRemark] = useState<RemarkChoice | null | undefined>(undefined)   // undefined: as it is
  const [busy, setBusy] = useState(false)
  const inFrom = useMemo(() => all.filter((x) => from === 'all' || x.from === from), [all, from])
  const found = hits(q, inFrom.filter((x) => match === 'all' || x.match === match))
  const now = remark === undefined ? start : remark
  const chosen = whole ? recs : recs.slice(0, 1)
  const go = async () => {
    if (!at) return
    setBusy(true)
    const extra = remark === undefined ? [] : remarkItems(how === 'same' ? recs : chosen, remark)
    const ok = await save(how === 'version' ? [...mapItems(c, chosen, at), ...extra] : extra)
    setBusy(false)
    if (!ok) return
    if (how === 'same' && at.row != null) same(at.row, at.title)
    else done(chosen.length === recs.length, at)
    close()
  }
  const badge = (x: Spot) => <><span className={`cv-badge ${x.from}`}>{x.from === 'muso' ? d.source : `LNV row ${x.row}`}</span><span className={`mp-match ${x.match}`}>{x.match === 'exact' ? 'Exact' : 'Possible'}</span></>
  return (
    <Drawer open onClose={close} title={<>Map to existing ISRC / song</>} subtitle={<span className="muted">“{c.title}” – pick the song it belongs to, from the exact and possible matches.</span>}>
      {!at ? (
        <div className="mp">
          <label className="cs-search mp-search"><Search size={17} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search an ISRC, title, film, writer or LNV row…" /></label>
          <div className="as-kinds" role="group" aria-label="Which list">{FROM.map(([id, label]) => <button key={id} type="button" className={from === id ? 'on' : ''} aria-pressed={from === id} onClick={() => setFrom(id)}>{label === 'Muso list' ? `${d.source} list` : label}<b>{n(id === 'all' ? all.length : all.filter((x) => x.from === id).length)}</b></button>)}</div>
          <div className="as-kinds" role="group" aria-label="Which match">{MATCH.map(([id, label]) => <button key={id} type="button" className={match === id ? 'on' : ''} aria-pressed={match === id} onClick={() => setMatch(id)}>{label}<b>{n(id === 'all' ? inFrom.length : inFrom.filter((x) => x.match === id).length)}</b></button>)}</div>
          <p className="muted mp-count">{n(found.length)} song{found.length === 1 ? '' : 's'}{q ? ` for “${q}”` : ''}{found.length > 100 ? ' (first 100 – type to narrow)' : ''}</p>
          <div className="mp-list">
            {!found.length && <p className="cv-none">No exact or possible match fits. Try fewer words, or an ISRC.</p>}
            {found.slice(0, 100).map((x) => (
              <button key={x.key} type="button" className="mp-item" onClick={() => { setAt(x); setHow('version') }}>
                {badge(x)}
                <span className="grow mp-text"><b>{x.title}</b><small className="muted">{[x.version && x.version !== 'Original' && x.version, norm(x.family) !== norm(x.title) && `In “${x.family}”`, x.film, x.writers].filter(Boolean).join(' · ')}</small>
                  <small className="mp-isrc mono">{x.isrcs.length ? `ISRC ${x.isrcs.join(', ')}` : 'No ISRC'}</small></span>
                {x.checked && <span className="as-checked"><Check size={13} />Checked</span>}<ChevronRight size={16} />
              </button>))}
          </div>
        </div>
      ) : (
        <div className="mp mp-ask">
          <button type="button" className="rv-text-btn" onClick={() => setAt(null)}>← Back to the list</button>
          <div className="mp-target">{badge(at)}<b>{at.title}</b><small className="muted">{[at.film, at.writers, at.isrcs.length ? `ISRC ${at.isrcs.join(', ')}` : 'No ISRC'].filter(Boolean).join(' · ')}</small></div>
          <h3>Remark – why is it mapped?</h3>
          <div className="rm-line"><RemarkPick d={d} now={now} pick={setRemark} /><Link className="rm-set" to="/settings">Edit the list in Settings</Link></div>
          <h3>How does “{c.title}” go into the LNV?</h3>
          <div className="rm-how" role="radiogroup" aria-label="How it goes into the LNV">
            <label className={how === 'version' ? 'on' : ''}><input type="radio" name="rm-how" checked={how === 'version'} onChange={() => setHow('version')} />
              <span><b>A song of its own, mapped to “{at.title}”</b><small>A new LNV row naming {at.row != null ? `LNV row ${at.row}` : 'that song'} as its original{recs.length > 1 ? ' – one row per recording' : ''}. The Remark column says why.</small></span></label>
            {at.row != null && <label className={how === 'same' ? 'on' : ''}><input type="radio" name="rm-how" checked={how === 'same'} onChange={() => setHow('same')} />
              <span><b>The same song as LNV row {at.row}</b><small>No row of its own. The Remark column of that row says why.</small></span></label>}
          </div>
          {how === 'version' && recs.length > 1 && <label className="rm-all"><input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />All {recs.length} recordings of this song{whole ? '' : ` – now only “${recs[0].fields.Title}”`}</label>}
          <div className="as-foot"><button type="button" className="btn primary" disabled={busy} onClick={go}>{busy ? <span className="spinner small" /> : <Check size={15} />}Map it</button>
            <button type="button" className="btn ghost" onClick={() => setAt(null)}>Choose another</button></div>
        </div>
      )}
    </Drawer>
  )
}
