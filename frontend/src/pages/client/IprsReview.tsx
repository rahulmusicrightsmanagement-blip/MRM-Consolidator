import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Search, Undo2 } from 'lucide-react'
import { api } from '../../lib/api'
import type { CaseRecord, SongRecord, Step3 } from '../../types'
import { list, n, norm } from './Block'
import { Act, Compare, WideBtn, useKeys, useStored } from './SongReview'
import type { Col } from './SongReview'

/** Step 2 – the LNV (the master) against the client's IPRS report, laid out like step 1: one list, one case at a
 *  time, the IPRS work next to the LNV row with the same-song checks. Only "Which LNV row?" needs an answer;
 *  the other kinds are the results – what to amend, what to register, what IPRS has that the LNV does not. */

type Kind = 'which' | 'amend' | 'register' | 'only' | 'matched'
const KIND: Record<Kind, { label: string; short: string; tone: string }> = {
  which: { label: 'Which LNV row?', short: 'Which row?', tone: 'info' },
  amend: { label: 'Amend at IPRS', short: 'Amend', tone: 'warn' },
  register: { label: 'Register at IPRS', short: 'Register', tone: 'bad' },
  only: { label: 'Only at IPRS', short: 'Only IPRS', tone: 'violet' },
  matched: { label: 'Registered', short: 'Registered', tone: 'brand' },
}
const KINDS = Object.keys(KIND) as Kind[]
const FIELDS = ['Title', 'Film / album', 'Lyricist', 'Composer', 'Publisher', 'Singer', 'ISRC', 'ISWC', 'IPRS code', 'Year', 'Length']

type Case = { id: string; kind: Kind; title: string; sub: string; needs: boolean; text: string }
  & ({ kind: 'which'; x: Step3['review'][number] } | { kind: 'amend'; x: Step3['amend'][number] } | { kind: 'register'; x: Step3['register'][number] }
    | { kind: 'only'; x: Step3['iprs_only'][number] } | { kind: 'matched'; x: Step3['matched'][number] })

function casesOf(d: Step3): Case[] {
  const out: Case[] = []
  d.review.forEach((x) => out.push({ id: `w${x.key}`, kind: 'which', x, title: x.title, needs: !x.decision,
    sub: x.decision ? (x.decision.none ? 'Not in the LNV – added' : `LNV row ${x.decision.row}`) : 'Needs you', text: `${x.title} ${x.key}` }))
  d.amend.forEach((x) => out.push({ id: `a${x.row}`, kind: 'amend', x, title: x.title, needs: false, sub: x.why[0] ?? 'Differs at IPRS', text: `${x.title} ${x.film} ${x.row} ${x.codes.join(' ')}` }))
  d.register.forEach((x) => out.push({ id: `r${x.row}`, kind: 'register', x, title: x.title, needs: false, sub: `LNV row ${x.row}`, text: `${x.title} ${x.film} ${x.row}` }))
  d.iprs_only.forEach((x) => out.push({ id: `o${x.key}`, kind: 'only', x, title: x.title, needs: false,
    sub: x.not_ours ? "Not the client's work" : 'Add to the LNV', text: `${x.title} ${x.key} ${list(x.record.fields.Lyricist)} ${list(x.record.fields.Composer)}` }))
  d.matched.forEach((x) => out.push({ id: `m${x.row}`, kind: 'matched', x, title: x.title, needs: false, sub: `LNV row ${x.row} · ${x.codes.join(', ')}`, text: `${x.title} ${x.film} ${x.row} ${x.codes.join(' ')}` }))
  return out
}

export default function IprsReview({ d, run, clientId, save }: {
  d: Step3; run: number; clientId: number; save: (work: () => Promise<unknown>) => void
}) {
  const cases = useMemo(() => casesOf(d), [d])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<Kind | 'all'>(d.counts.review_open ? 'which' : 'amend')
  const [needsOnly, setNeedsOnly] = useState(d.counts.review_open > 0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const filterBy = (k: Kind | 'all', needs: boolean) => { setKind(k); setNeedsOnly(needs); setSelectedId(null) }

  const shown = useMemo(() => {
    const s = norm(q)
    return cases.filter((c) => c.id === selectedId || ((kind === 'all' || c.kind === kind) && (!needsOnly || c.needs) && (!s || norm(c.text).includes(s))))
  }, [cases, q, kind, needsOnly, selectedId])
  const counts = useMemo(() => {
    const k: Record<string, number> = {}
    cases.forEach((c) => { if (!needsOnly || c.needs) k[c.kind] = (k[c.kind] ?? 0) + 1 })
    return k
  }, [cases, needsOnly])
  const sel = shown.find((c) => c.id === selectedId) ?? shown[0] ?? null
  const at = sel ? shown.indexOf(sel) : -1
  const go = (delta: number) => { const x = shown[at + delta]; if (x) setSelectedId(x.id) }
  useEffect(() => { if (sel) refs.current[sel.id]?.scrollIntoView({ block: 'nearest' }) }, [sel])
  const needs = cases.filter((c) => c.needs).length
  const [wide, setWide] = useStored('mrm-wide', false)
  useKeys({ w: () => setWide(!wide) })

  return (
    <section className="cs-body rv">
      <div className={`sm-review ${wide ? 'wide' : ''}`}>
        <div className="sm-list">
          <div className="sm-list-head">
            <label className="cs-search sm-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search song, IPRS code, LNV row…" /></label>
            <div className="rv-tabs">
              <button type="button" className={needsOnly ? 'on' : ''} onClick={() => filterBy('all', true)}>Needs you<span>{n(needs)}</span></button>
              <button type="button" className={!needsOnly ? 'on' : ''} onClick={() => filterBy(kind, false)}>Everything<span>{n(cases.length)}</span></button>
            </div>
            <div className="rv-list-tools">
              <select className="rv-kind" value={kind} onChange={(e) => filterBy(e.target.value as Kind | 'all', needsOnly)} aria-label="Kind of case">
                <option value="all">Every kind</option>
                {KINDS.filter((k) => counts[k] || kind === k).map((k) => <option key={k} value={k}>{KIND[k].label} ({n(counts[k])})</option>)}
              </select>
            </div>
          </div>
          <div className="sm-list-items">
            {!shown.length ? <p className="sm-list-none">{needsOnly && !q ? 'Nothing needs you – every IPRS work has its LNV row.' : 'Nothing matches.'}</p>
              : shown.map((c) => (
                <button key={c.id} type="button" ref={(el) => { refs.current[c.id] = el }} className={`sm-item ${sel?.id === c.id ? 'on' : ''}`} onClick={() => setSelectedId(c.id)}>
                  <span className="sm-item-text"><b>{c.title}</b><small>{KIND[c.kind].label} · <span className={`rv-verdict ${c.needs ? 'open' : ''}`}>{c.sub}</span></small></span>
                </button>
              ))}
          </div>
        </div>
        {sel ? <IprsCase key={sel.id} c={sel} run={run} clientId={clientId} save={save} pos={at + 1} total={shown.length} prev={() => go(-1)} next={() => go(1)}
            wideBtn={<WideBtn wide={wide} toggle={() => setWide(!wide)} />} />
          : <div className="sm-detail sm-detail-none muted">Nothing to show.</div>}
      </div>
    </section>
  )
}

function IprsCase({ c, run, clientId, save, pos, total, prev, next, wideBtn }: {
  c: Case; run: number; clientId: number; save: (work: () => Promise<unknown>) => void; pos: number; total: number; prev: () => void; next: () => void
  wideBtn: React.ReactNode
}) {
  const decided = c.kind === 'which' ? c.x.decision : null
  const [pick, setPick] = useState<number | 'none' | null>(decided ? (decided.none ? 'none' : decided.row ?? null) : null)
  const send = (to: number | 'none') => {
    if (c.kind !== 'which') return
    const x = c.x
    save(() => api.decideMany(run, [to === 'none' ? { internal_no: x.key, action: 'new', rejected_rows: x.records.slice(1).map((r) => r.row!) } : { internal_no: x.key, master_row: to }]))
    next()
  }
  const only = c.kind === 'which' && c.x.records.length === 2 ? c.x.records[1].row! : null
  const row = pick === 'none' ? null : pick ?? only
  const confirm = () => { if (pick !== null) send(pick) }
  useKeys({ enter: confirm, a: confirm, s: () => { if (row !== null) send(row) }, n: () => { if (c.kind === 'which') send('none') }, arrowdown: next, j: next, arrowup: prev, k: prev })
  const iprs = (r: SongRecord): Col => ({ r: r as CaseRecord, tone: 'iprs', badge: `IPRS ${list(r.fields['IPRS code'])[0] ?? r.ref ?? ''}` })
  const lnv = (r: SongRecord): Col => ({ r: r as CaseRecord, tone: 'lnv', badge: `LNV row ${r.row}` })
  const head = (
    <div className="sm-detail-top">
      <div className="sm-detail-nav">
        <span className="rv-kind-name">{KIND[c.kind].label}</span>
        <span className="grow" />
        <span className="muted rv-pos">{n(pos)} of {n(total)}</span>
        <button type="button" className="sm-nav" disabled={pos <= 1} onClick={prev} title="Previous (↑)"><ArrowLeft size={15} /></button>
        <button type="button" className="sm-nav" disabled={pos >= total} onClick={next} title="Next (↓)"><ArrowRight size={15} /></button>
        {wideBtn}
      </div>
      <h3>{c.title}</h3>
    </div>
  )

  if (c.kind === 'which') {
    const [work, ...rows] = c.x.records
    const x = c.x
    return (
      <div className="sm-detail rv-case">
        {head}
        <div className="rv-scroll">
          {x.reason && <p className="rv-why">{x.reason}</p>}
          <Compare fields={FIELDS} cols={[iprs(work), ...rows.map((r): Col => ({ ...lnv(r), pick: rows.length > 1 ? { on: pick === r.row, radio: true, label: 'This is the song', change: () => setPick(r.row!) } : undefined }))]} />
        </div>
        <div className="rv-bar">
          <p className="rv-outcome">{pick === 'none' ? 'The IPRS work is added to the LNV as a new song, with its IPRS code.'
            : pick !== null ? `LNV row ${pick} gets IPRS code ${x.key}.` : rows.length > 1 ? 'Tick the LNV row this IPRS work is, or add it to the LNV.' : `Is this IPRS work LNV row ${rows[0]?.row}?`}</p>
          <div className="sm-decide">
            {rows.length > 0 && <Act on={pick !== null && pick !== 'none'} k="S" disabled={row === null} onClick={() => { if (row !== null) send(row) }}>{row !== null ? `Same song as row ${row}` : 'Tick an LNV row above'}</Act>}
            <Act on={pick === 'none'} k="N" onClick={() => send('none')}>New song – add to LNV</Act>
            {decided && <button type="button" className="rv-text-btn" onClick={() => save(() => api.decide(run, x.key, 'clear'))}><Undo2 size={14} />Undo</button>}
          </div>
        </div>
      </div>
    )
  }

  if (c.kind === 'amend') {
    const [song, ...works] = c.x.records
    return (
      <div className="sm-detail rv-case">
        {head}
        <div className="rv-scroll">
          <Compare fields={FIELDS} cols={[lnv(song), ...works.map(iprs)]} />
          <section className="rv-fills">
            <h4>What to amend at IPRS</h4>
            <ul className="rv-reasons">{[...c.x.why, ...c.x.detail].map((t) => <li key={t}>{t}</li>)}</ul>
          </section>
        </div>
        <div className="rv-bar"><p className="rv-outcome">On the amendment list – the IPRS registration is brought in line with the LNV.</p></div>
      </div>
    )
  }

  if (c.kind === 'register') return (
    <div className="sm-detail rv-case">
      {head}
      <div className="rv-scroll"><Compare fields={FIELDS} cols={[lnv(c.x.record)]} base={null} /></div>
      <div className="rv-bar"><p className="rv-outcome">IPRS does not have this song – it is on the registration list.</p></div>
    </div>
  )

  if (c.kind === 'only') {
    const x = c.x
    return (
      <div className="sm-detail rv-case">
        {head}
        <div className="rv-scroll"><Compare fields={FIELDS} cols={[iprs(x.record)]} base={null} /></div>
        <div className="rv-bar">
          <p className="rv-outcome">{x.not_ours ? 'Left out of the LNV.' : 'Added to the LNV as a new song, with its IPRS code.'}</p>
          <div className="sm-decide">
            <Act on={!x.not_ours} onClick={() => save(() => api.flagSongs(run, [x.key], false))}>Add to the LNV</Act>
            <Act on={x.not_ours} onClick={() => save(() => api.flagSongs(run, [x.key], true))}>Not the client's work</Act>
          </div>
        </div>
      </div>
    )
  }

  return <Registered row={c.x.row} clientId={clientId} head={head} />
}

/** A registered song: what each file holds for it, fetched when opened. */
function Registered({ row, clientId, head }: { row: number; clientId: number; head: React.ReactNode }) {
  const [records, setRecords] = useState<SongRecord[] | null>(null)
  useEffect(() => { let on = true; api.stepRow(clientId, row).then((r) => { if (on) setRecords(r) }).catch(() => { if (on) setRecords([]) }); return () => { on = false } }, [clientId, row])
  const lnv = records?.find((r) => r.src === 'LNV')
  return (
    <div className="sm-detail rv-case">
      {head}
      <div className="rv-scroll">
        {!records ? <div className="loading"><span className="spinner" />Loading…</div> : (
          <Compare fields={FIELDS} base={lnv ? records.indexOf(lnv) : null}
            cols={records.map((r): Col => ({ r: r as CaseRecord, tone: r.src === 'LNV' ? 'lnv' : 'iprs', badge: r.src === 'LNV' ? `LNV row ${r.row ?? ''}` : r.src === 'IPRS' ? r.ref ?? 'IPRS' : r.src }))} />
        )}
      </div>
    </div>
  )
}
