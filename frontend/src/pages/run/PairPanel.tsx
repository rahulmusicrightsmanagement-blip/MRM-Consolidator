import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Plus } from 'lucide-react'
import { api } from '../../lib/api'
import { useRun } from '../../lib/run'
import type { EditChoice, FieldCompare, Link as MapLink, PairPerson, PairResult, PairRow, PairStatus } from '../../types'

/** Fields where the reviewer can pick which value our master keeps. */
const EDITABLE = ['Title', 'Duration', 'ISWC', 'ISRC', 'Authors', 'Composers', 'Publishers']
export const editable = (f: FieldCompare) => EDITABLE.includes(f.field) && (f.result === 'different' || f.result === 'missing_master')

// Plain names for the rows, in the words of someone who works in the Excel files.
const NAMES: Record<string, string> = {
  Title: 'Song title', 'Alternate title': 'Other title', ISWC: 'ISWC', ISRC: 'ISRC', Duration: 'Length',
  Language: 'Language', Category: 'Category', 'Production / movie': 'Film / album', 'Performer / singers': 'Singers',
  'IPRS status': 'Status at IPRS',
}
// Which of these rows the "Use IPRS / Keep ours" choice belongs to.
const CHOICE_FIELD: Record<string, string> = { Title: 'Title', Duration: 'Duration', ISWC: 'ISWC', ISRC: 'ISRC' }
const GROUPS: { id: PairPerson['group']; title: string; one: string; field?: string }[] = [
  { id: 'authors', title: 'Authors (lyrics)', one: 'Author', field: 'Authors' },
  { id: 'composers', title: 'Composers (music)', one: 'Composer', field: 'Composers' },
  { id: 'publishers', title: 'Publishers', one: 'Publisher', field: 'Publishers' },
  { id: 'others', title: 'Others', one: 'Other' },
]
// Excel-style colours: green same, red different, yellow missing in our master; everything else stays white.
const LOOK: Record<PairStatus, { cls: string; text: string }> = {
  same: { cls: 'x-same', text: '✓ Same' },
  different: { cls: 'x-diff', text: '✗ Different' },
  only_iprs: { cls: 'x-missing', text: 'Missing in our master' },
  only_master: { cls: '', text: 'Only in our master' },
  one_side: { cls: '', text: '' },
}
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '' : `${v}%`)
const personStatus = (p: PairPerson): PairStatus => !p.master ? 'only_iprs' : !p.iprs ? 'only_master' : p.diffs.length ? 'different' : 'same'
const personReason = (p: PairPerson) => (p.diffs.includes('perf') && p.diffs.includes('mech') && p.iprs!.per_own === p.iprs!.mec_own
  && p.master!.perf === p.master!.mech ? p.diffs.filter((d) => d !== 'mech') : p.diffs).map((d) => ({
  perf: `Share is different (IPRS ${pct(p.iprs!.per_own)}, ours ${pct(p.master!.perf)})`,
  mech: `Mechanical share is different (IPRS ${pct(p.iprs!.mec_own)}, ours ${pct(p.master!.mech)})`,
  ipi: 'IPI number is different',
  role: `Role is different (IPRS ${p.iprs!.role}, ours ${p.master!.role})`,
})[d])

/** One song, both files, one Excel-like table: what IPRS says next to what our master says. */
export function PairPanel({ work, row, rowNote, link }: { work: string | null; row: number | null; rowNote?: string; link?: MapLink }) {
  const { runId, payload, editMaster, busy } = useRun()
  const [data, setData] = useState<PairResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [onlyDiff, setOnlyDiff] = useState(false)

  useEffect(() => {
    let live = true
    setData(null)
    api.pair(runId, work, row).then((d) => { if (live) { setData(d); setError(null) } }).catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [runId, work, row])

  if (error) return <div className="alert bad small">{error}</div>
  if (!data) return <div className="x-loading"><span className="spinner" />Reading both files…</div>

  const both = !!data.internal_no && !!data.master_row
  const linkedRow = link?.state === 'linked' ? link.master_row : null
  const compare = (field: string) => link?.comparison?.fields.find((f) => f.field === field)
  const choiceOf = (field: string) => payload!.master_edits.find((e) => e.master_row === linkedRow && e.field === field)?.choice
  const pick = (field: string, choice: EditChoice) =>
    editMaster([{ master_row: linkedRow!, field, internal_no: link!.internal_no, choice: choiceOf(field) === choice ? null : choice }])
  const show = (s: PairStatus, r?: PairRow) => !onlyDiff || s === 'different' || (s === 'only_iprs' && (!r || !!r.master_col))
  const iprsOnlyColumns = data.sections.flatMap((s) => s.rows).filter((r) => r.status === 'only_iprs' && !r.master_col).length
  const diffCount = (data.counts.different ?? 0) + (data.counts.only_iprs ?? 0) - iprsOnlyColumns

  /** "Use IPRS / Keep ours" (or "Add to our master") for a field our master can take from IPRS. */
  const actions = (field?: string) => {
    const f = field && linkedRow ? compare(field) : undefined
    if (!f || !editable(f)) return null
    const c = choiceOf(f.field)
    if (f.result === 'missing_master') {
      return <button type="button" className={`x-btn ${c === 'iprs' ? 'on' : ''}`} disabled={!!busy} onClick={() => pick(f.field, 'iprs')}>
        {c === 'iprs' ? <><Check size={13} />Added</> : <><Plus size={13} />Add to our master</>}</button>
    }
    return (
      <span className="x-pick">
        <button type="button" className={`x-btn ${c === 'iprs' ? 'on' : ''}`} disabled={!!busy} onClick={() => pick(f.field, 'iprs')}>{c === 'iprs' && <Check size={13} />}Use IPRS</button>
        <button type="button" className={`x-btn ${c === 'master' ? 'on' : ''}`} disabled={!!busy} onClick={() => pick(f.field, 'master')}>{c === 'master' && <Check size={13} />}Keep ours</button>
      </span>
    )
  }

  const line = (r: PairRow) => {
    const field = CHOICE_FIELD[r.label]
    const c = field && linkedRow ? choiceOf(field) : undefined
    // A column only the IPRS file has (e.g. its status) is not something our master is missing.
    const look = r.status === 'only_iprs' && !r.master_col ? { cls: '', text: 'Only in the IPRS file' } : LOOK[r.status]
    return (
      <tr key={r.label + r.letter} className={c === 'iprs' ? 'x-same' : look.cls}>
        <td className="x-col">{r.letter}</td>
        <td className="x-what">{NAMES[r.label] ?? r.label.replace(/^IPRS block (\d+) · /, 'IPRS $1 – ')}</td>
        {data.internal_no && <td className="x-val">{r.iprs}</td>}
        {data.master_row && <td className="x-val">{c === 'iprs'
          ? <><b>{r.iprs}</b><span className="x-sub">{r.master ? <>was <s>{r.master}</s></> : 'was empty'}</span></>
          : r.master}</td>}
        {both && <td className="x-result">{c === 'iprs' ? 'Will use IPRS' : c === 'master' ? 'Keeping ours' : look.text}</td>}
        {both && <td className="x-act">{actions(field)}</td>}
      </tr>
    )
  }

  const heading = (key: string, text: string, act?: ReactNode) => (
    <tr key={key} className="x-head"><td colSpan={both ? 5 : 3}>{text}</td>{both && <td className="x-act">{act}</td>}</tr>
  )
  const [details, blocks, rest] = ['work', 'blocks', 'rest'].map((id) => data.sections.find((s) => s.id === id)!.rows.filter((r) => show(r.status, r)))

  return (
    <div className="x-pair">
      <div className="x-top">
        <p className="x-say">
          {both ? <>IPRS work <b>{data.internal_no}</b> next to row <b>{data.master_row}</b> of our master. {diffCount === 0
            ? 'Everything that is in both files is the same.' : <>Rows in <span className="x-key x-diff">red</span> or <span className="x-key x-missing">yellow</span> need a look.</>}</>
            : data.internal_no ? <>This IPRS work is <b>not in our master</b>. Everything IPRS has for it:</>
            : <>Row <b>{data.master_row}</b> of our master. IPRS does not have this song.</>}
          {rowNote && <span className="muted"> {rowNote}</span>}
        </p>
        {both && <label className="x-only"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Show only differences ({diffCount})</label>}
      </div>

      <div className="x-wrap">
        <table className="x-sheet">
          <thead>
            <tr><th className="x-col">Excel column</th><th>What</th>
              {data.internal_no && <th>IPRS file says</th>}
              {data.master_row && <th>Our master says</th>}
              {both && <th>Result</th>}{both && <th />}</tr>
          </thead>
          <tbody>
            {details.length > 0 && heading('h-work', 'Song details')}
            {details.map(line)}
            {GROUPS.map((g) => {
              const people = data.people.filter((p) => p.group === g.id && show(personStatus(p)))
              if (!people.length) return null
              const c = g.field && linkedRow ? choiceOf(g.field) : undefined
              return [
                heading(`h-${g.id}`, g.title, actions(g.field)),
                ...people.map((p, i) => {
                  const s = personStatus(p)
                  return (
                    <tr key={`${g.id}${i}`} className={c === 'iprs' ? 'x-same' : LOOK[s].cls}>
                      <td className="x-col">{p.master?.col}</td>
                      <td className="x-what">{g.one}</td>
                      {data.internal_no && <td className="x-val">{p.iprs && <>{p.iprs.name}<span className="x-sub">IPI {p.iprs.ipi || '—'} · share {pct(p.iprs.per_own) || '—'}</span></>}</td>}
                      {data.master_row && <td className="x-val">{p.master && <>{p.master.name}<span className="x-sub">IPI {p.master.ipi || '—'} · share {pct(p.master.perf) || '—'}</span></>}</td>}
                      {both && <td className="x-result">{c === 'iprs' ? 'Will use IPRS' : c === 'master' ? 'Keeping ours'
                        : s === 'different' ? personReason(p).map((t) => <div key={t}>{t}</div>) : LOOK[s].text}</td>}
                      {both && <td />}
                    </tr>
                  )
                }),
              ]
            })}
            {blocks.length > 0 && heading('h-blocks', 'IPRS codes in our master')}
            {blocks.map(line)}
            {data.master_row && rest.length > 0 && heading('h-rest', data.internal_no ? 'Other details only our master has' : 'Other details')}
            {data.master_row && rest.map(line)}
          </tbody>
        </table>
      </div>
      <Originals data={data} />
    </div>
  )
}

/** The untouched rows from both files, for anyone who wants to check against Excel. */
function Originals({ data }: { data: PairResult }) {
  const iprs = data.iprs_raw, master = data.master_raw
  return (
    <details className="x-orig">
      <summary>See the original rows exactly as they are in the files</summary>
      <div className="x-orig-grid">
        {iprs && (
          <div className="x-wrap">
            <table className="x-sheet">
              <thead><tr><th className="x-col">Column</th><th>IPRS file heading</th>{iprs.rows.map((r) => <th key={r.row}>Row {r.row}</th>)}</tr></thead>
              <tbody>{iprs.columns.map((c, i) => (
                <tr key={c.letter}><td className="x-col">{c.letter}</td><td className="x-what">{c.header}</td>
                  {iprs.rows.map((r) => <td key={r.row} className="x-val">{r.cells[i]}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {master && (
          <div className="x-wrap">
            <table className="x-sheet">
              <thead><tr><th className="x-col">Column</th><th>Our master heading</th><th>Row {master.row}</th></tr></thead>
              <tbody>{master.columns.filter((c) => c.value.trim()).map((c) => (
                <tr key={c.letter}><td className="x-col">{c.letter}</td><td className="x-what">{c.header}</td><td className="x-val">{c.value}</td></tr>
              ))}</tbody>
            </table>
            <p className="small muted">The {master.columns.length - data.master_filled} empty columns of this row are not shown.</p>
          </div>
        )}
      </div>
    </details>
  )
}
