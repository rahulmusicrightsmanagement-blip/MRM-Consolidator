import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Plus, Undo2 } from 'lucide-react'
import { api } from '../../lib/api'
import { samePerson } from '../../lib/names'
import { useRun } from '../../lib/run'
import type { EditChoice, FieldCompare, Link as MapLink, PairPerson, PairResult, PairRow, PairStatus } from '../../types'

/** Fields where the reviewer can pick which value our master keeps. */
const EDITABLE = ['Title', 'Alternate title', 'Duration', 'ISWC', 'ISRC', 'Language', 'Film / album', 'Singers', 'Authors', 'Composers', 'Publishers']
export const editable = (f: FieldCompare) => EDITABLE.includes(f.field) && (f.result === 'different' || f.result === 'missing_master')

// Plain names for the rows, in the words of someone who works in the Excel files.
const NAMES: Record<string, string> = {
  Title: 'Song title', 'Alternate title': 'Other title', ISWC: 'ISWC', ISRC: 'ISRC', Duration: 'Length',
  Language: 'Language', Category: 'Category', 'Production / movie': 'Film / album', 'Performer / singers': 'Singers',
  'IPRS status': 'Status at IPRS',
}
// Which of these rows the "Use IPRS / Keep ours" choice belongs to (the field name the server stores).
const CHOICE_FIELD: Record<string, string> = {
  Title: 'Title', 'Alternate title': 'Alternate title', Duration: 'Duration', ISWC: 'ISWC', ISRC: 'ISRC',
  Language: 'Language', 'Production / movie': 'Film / album', 'Performer / singers': 'Singers',
}
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
/** focus: the amendment reasons this song was opened for – shown first, in plain words, with where to look. */
export function PairPanel({ work, row, rowNote, link, focus }: { work: string | null; row: number | null; rowNote?: string; link?: MapLink; focus?: string[] }) {
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
  const choiceOf = (field: string) => payload!.master_edits.find((e) => e.master_row === linkedRow && e.field === field)?.choice
  const pick = (field: string, choice: EditChoice) =>
    editMaster([{ master_row: linkedRow!, field, internal_no: link!.internal_no, choice: choiceOf(field) === choice ? null : choice }])
  const show = (s: PairStatus, r?: PairRow) => !onlyDiff || s === 'different' || (s === 'only_iprs' && (!r || !!r.master_col))
  const iprsOnlyColumns = data.sections.flatMap((s) => s.rows).filter((r) => r.status === 'only_iprs' && !r.master_col).length
  const diffCount = (data.counts.different ?? 0) + (data.counts.only_iprs ?? 0) - iprsOnlyColumns

  /** A row the reviewer can settle: values differ, or IPRS has one our master lacks (and our master has the column). */
  const choosable = (field: string | undefined, status: PairStatus, hasCol: boolean) =>
    !!field && !!linkedRow && !!link && (status === 'different' || (status === 'only_iprs' && (hasCol || field === 'Singers')))

  /** "Use IPRS / Keep ours" – once chosen, the buttons give way to the result and an Undo. */
  const actions = (field: string | undefined, missing: boolean) => {
    if (!field) return null
    const c = choiceOf(field)
    if (c) return <button type="button" className="x-btn ghost" disabled={!!busy} onClick={() => pick(field, c)} title="Undo this choice"><Undo2 size={13} />Undo</button>
    return (
      <span className="x-pick">
        <button type="button" className="x-btn use" disabled={!!busy} onClick={() => pick(field, 'iprs')}>{missing ? <><Plus size={13} />Add IPRS value</> : 'Use IPRS'}</button>
        {!missing && <button type="button" className="x-btn" disabled={!!busy} onClick={() => pick(field, 'master')}>Keep ours</button>}
      </span>
    )
  }

  /** The value our master ends up with, in place of the two values. */
  const finalCell = (c: EditChoice, iprs: ReactNode, master: ReactNode, empty: boolean) => (
    <td className="x-val x-final" colSpan={2}>
      <span className={`x-chosen ${c}`}>{c === 'iprs' ? 'From IPRS' : 'Ours kept'}</span>
      <b>{c === 'iprs' ? iprs : master}</b>
      <span className="x-sub">{c === 'iprs' ? (empty ? 'our master was empty' : <>was <s>{master}</s></>) : <>IPRS has <s>{iprs || '—'}</s> – not used</>}</span>
    </td>
  )

  const line = (r: PairRow) => {
    const field = CHOICE_FIELD[r.label]
    const can = choosable(field, r.status, !!r.master_col)
    const c = can && field ? choiceOf(field) : undefined
    // A column only the IPRS file has (e.g. its status) is not something our master is missing.
    const look = r.status === 'only_iprs' && !r.master_col && field !== 'Singers' ? { cls: '', text: 'Only in the IPRS file' } : LOOK[r.status]
    return (
      <tr key={r.label + r.letter} className={c ? `x-decided ${c}` : look.cls}>
        <td className="x-col">{r.letter}</td>
        <td className="x-what">{NAMES[r.label] ?? r.label.replace(/^IPRS block (\d+) · /, 'IPRS $1 – ')}</td>
        {c && both ? finalCell(c, r.iprs, r.master, !r.master) : <>
          {data.internal_no && <td className="x-val">{r.iprs}</td>}
          {data.master_row && <td className="x-val">{r.master}</td>}
        </>}
        {both && <td className="x-result">{c === 'iprs' ? <span className="x-pill good">Will use IPRS</span> : c === 'master' ? <span className="x-pill">Keeping ours</span>
          : look.text && <span className={`x-pill ${look.cls}`}>{look.text}</span>}{r.note && !c && <span className="x-sub">{r.note}</span>}</td>}
        {both && <td className="x-act">{can ? actions(field, r.status === 'only_iprs') : null}</td>}
      </tr>
    )
  }

  const heading = (key: string, text: string, act?: ReactNode) => (
    <tr key={key} className="x-head"><td colSpan={both ? 5 : 3}>{text}</td>{both && <td className="x-act">{act}</td>}</tr>
  )
  const clientName = payload!.result.iprs?.client.name ?? ''
  const isClient = (p: PairPerson) => !!clientName && [p.iprs?.name, p.master?.name].some((n) => n && samePerson(n, clientName))
  const masterIssues = (payload!.result.master?.issues ?? []).filter((i) => i.row === data.master_row)
  // The column type a master slot sits in ("Author 1" → Author) – when it is not the row's role, say so.
  const slotKind = (p: PairPerson) => p.master?.slot.replace(/\s*\d+$/, '') ?? ''
  const [details, blocks, rest] = ['work', 'blocks', 'rest'].map((id) => data.sections.find((s) => s.id === id)!.rows.filter((r) => show(r.status, r)))

  return (
    <div className="x-pair">
      {(!!focus?.length || masterIssues.length > 0) && (
        <div className="x-focus">
          <b className="x-focus-title">What to look at</b>
          {focus?.map((t) => (
            <div key={t} className="x-focus-line amend"><span className="x-focus-tag">Amend at IPRS</span><span>{t}
              {/^Client/.test(t) && <span className="x-sub">See the rows tagged <b>Client</b> below – IPRS on the left, our master on the right.</span>}</span></div>
          ))}
          {masterIssues.map((i) => (
            <div key={i.code + i.message} className="x-focus-line master"><span className="x-focus-tag">Fix our master</span><span>{i.message}</span></div>
          ))}
        </div>
      )}
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
              const all = data.people.filter((p) => p.group === g.id)
              const differs = all.some((p) => personStatus(p) !== 'same')
              const can = !!g.field && differs && choosable(g.field, all.some((p) => p.master) ? 'different' : 'only_iprs', true)
              const c = can ? choiceOf(g.field!) : undefined
              // Once settled, only the side our master keeps is listed.
              const people = all.filter((p) => c === 'iprs' ? !!p.iprs : c === 'master' ? !!p.master : show(personStatus(p)))
              if (!people.length) return null
              const sideIprs = all.some((p) => p.iprs), missing = !all.some((p) => p.master)
              return [
                heading(`h-${g.id}`, c ? `${g.title} – ${c === 'iprs' ? 'IPRS list will replace ours' : 'keeping our list'}` : g.title, can ? actions(g.field, missing) : undefined),
                ...people.map((p, i) => {
                  const s = personStatus(p)
                  const client = isClient(p)
                  const wrongColumn = !!p.master && g.id !== 'publishers' && g.id !== 'others' && slotKind(p) !== g.one
                  const person = (x: { name: string; ipi: string } | null, share: number | null | undefined, side: 'iprs' | 'master') => x && <>
                    {x.name}{client && <span className="x-client">Client</span>}
                    <span className="x-sub">IPI {x.ipi || '—'} · share {pct(share) || '—'}{side === 'iprs' && p.iprs ? ` · role ${p.iprs.role}` : ''}
                      {side === 'master' && p.master ? ` · role ${p.master.role || '—'}` : ''}</span>
                    {side === 'master' && p.master && <span className={`x-slot ${wrongColumn ? 'warn' : ''}`}>{p.master.slot} column ({p.master.col}){wrongColumn ? ` – but this is a ${g.one.toLowerCase()}` : ''}</span>}</>
                  return (
                    <tr key={`${g.id}${i}`} className={`${c ? `x-decided ${c}` : wrongColumn ? 'x-missing' : LOOK[s].cls} ${client ? 'x-is-client' : ''}`}>
                      <td className="x-col">{p.master?.col}</td>
                      <td className="x-what">{g.one}</td>
                      {c && both && sideIprs ? (
                        <td className="x-val x-final" colSpan={2}><span className={`x-chosen ${c}`}>{c === 'iprs' ? 'From IPRS' : 'Ours kept'}</span>
                          {c === 'iprs' ? person(p.iprs, p.iprs?.per_own, 'iprs') : person(p.master, p.master?.perf, 'master')}</td>
                      ) : <>
                        {data.internal_no && <td className="x-val">{person(p.iprs, p.iprs?.per_own, 'iprs')}</td>}
                        {data.master_row && <td className="x-val">{person(p.master, p.master?.perf, 'master')}</td>}
                      </>}
                      {both && <td className="x-result">{c ? <span className={`x-pill ${c === 'iprs' ? 'good' : ''}`}>{c === 'iprs' ? 'Will use IPRS' : 'Keeping ours'}</span>
                        : s === 'different' ? personReason(p).map((t) => <div key={t} className="x-reason">{t}</div>)
                        : wrongColumn ? <span className="x-pill x-missing">Fix our master: wrong column</span>
                        : LOOK[s].text && <span className={`x-pill ${LOOK[s].cls}`}>{LOOK[s].text}</span>}</td>}
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
