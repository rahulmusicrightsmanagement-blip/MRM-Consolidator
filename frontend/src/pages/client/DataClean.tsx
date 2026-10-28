import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Check, CircleHelp, Copy, Download, ExternalLink, FileSpreadsheet, Minus, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { Button, ConfirmDialog, Empty, FileDrop, Mono } from '../../components/ui'
import { api } from '../../lib/api'
import type { CleanDecisionIn } from '../../lib/api'
import { fmtDate, useClient } from '../../lib/client'
import { useToast } from '../../lib/toast'
import type { CleanDecisionT, CleanPayload, CleanResult, DspSong, FillItem, LnvBrief, SpellingItem } from '../../types'

/** Step 1 of the consolidate process as a side-by-side compare: the client's LNV (our sheet) on the left, one export
 *  (Muso, Spotify or Apple Music from MRM-Extractor) on the right, matched songs on one line. Every line says what
 *  it is and what will happen to it; the app's choice is already filled in and the Outcome menu changes it. */
type Decide = (items: CleanDecisionIn[]) => Promise<void>
type Kind = 'look' | 'isrc' | 'duplicate' | 'missing' | 'found' | 'other'
type Item = { key: string; decision?: CleanDecisionT; auto?: Omit<CleanDecisionT, 'auto'> }
interface Opt { value: string; label: string; make: CleanDecisionIn }
interface Line {
  id: string; kind: Kind; item: Item; options: Opt[]
  lnv: LnvBrief[]; keep?: number | null; also?: string
  song: DspSong | Omit<DspSong, 'key'> | null; songNote?: string
  why?: string; warn: string[]; fills?: string[]; search: string; pop: number
}

const KIND: Record<Kind, { label: string; icon: ReactNode; tone: string; chip: string }> = {
  look: { label: 'Possible match', icon: <CircleHelp size={14} />, tone: 'info', chip: 'Possible matches' },
  isrc: { label: 'ISRC on wrong song', icon: <AlertTriangle size={14} />, tone: 'bad', chip: 'ISRC problems' },
  duplicate: { label: 'Duplicate in LNV', icon: <Copy size={14} />, tone: 'warn', chip: 'Duplicates' },
  missing: { label: 'Only on export', icon: <Plus size={14} />, tone: 'bad', chip: 'Missing from LNV' },
  found: { label: 'In both', icon: <Check size={14} />, tone: 'good', chip: 'In both' },
  other: { label: 'Only on export', icon: <Minus size={14} />, tone: 'neutral', chip: 'Not the client\'s writing' },
}
const ORDER: Kind[] = ['look', 'isrc', 'duplicate', 'missing', 'found', 'other']
const PAGE = 50
const n = (x: number) => x.toLocaleString()
const list = (xs: string[], max = 3) => xs.length ? xs.slice(0, max).join(', ') + (xs.length > max ? ` +${xs.length - max}` : '') : '—'
const plain = (text: string, src: string) => text.replace(/\bDSP\b/g, src)
const valueOf = (d?: Pick<CleanDecisionT, 'choice' | 'data'> | null) => d ? `${d.choice}:${d.data?.keep ?? d.data?.row ?? d.data?.rows?.[0] ?? ''}` : ''
const SheetTag = ({ kind, children }: { kind: 'lnv' | 'export'; children: ReactNode }) => <span className={`sheet-tag ${kind}`}>{children}</span>
const opt = (key: string, label: string, choice: CleanDecisionIn['choice'], data?: CleanDecisionIn['data']): Opt =>
  ({ value: valueOf(choice ? { choice, data } : null) || 'same', label, make: { key, choice, data } })

/** Every line of the compare, from the result's lists. */
function buildLines(r: CleanResult, src: string): Line[] {
  const fills = new Map<number, string[]>()
  for (const f of r.fills) if (f.decision?.choice === 'accept') fills.set(f.row, [...(fills.get(f.row) ?? []), f.field])
  const lnvText = (rows: LnvBrief[]) => rows.map((x) => `${x.row} ${x.title} ${x.movie} ${x.isrcs.join(' ')} ${x.writers.join(' ')}`).join(' ')
  const songText = (s: Line['song']) => s ? `${s.title} ${s.album} ${s.isrcs.join(' ')} ${s.lyricists.join(' ')} ${s.composers.join(' ')}` : ''
  const out: Line[] = []
  for (const c of r.check) {
    const rows = c.candidates.map((x) => x.lnv)
    out.push({ id: c.key, kind: 'look', item: c, lnv: [rows[0]], also: rows.length > 1 ? `or row ${rows.slice(1).map((x) => x.row).join(', ')}` : undefined,
      song: c.song, why: c.candidates[0].evidence.join(' · '), warn: c.candidates[0].flags.map((f) => plain(f, src)),
      options: [...c.candidates.map((x) => opt(c.key, `Same song as row ${x.row}`, 'same', { rows: [x.row] })), opt(c.key, 'Not in the LNV – add it', 'none')],
      search: `${songText(c.song)} ${lnvText(rows)}`, pop: c.song.popularity })
  }
  for (const c of r.duplicates) {
    const song = c.reasons.map((w) => w.match(/^Both match the '(.+)' DSP song$/)?.[1]).find(Boolean)
    const keep = typeof c.decision?.data?.keep === 'number' ? c.decision.data.keep : c.keeper
    out.push(c.kind === 'wrong_isrc' ? {
      id: c.key, kind: 'isrc', item: c, lnv: c.rows, song: null, songNote: c.reasons[0], warn: [],
      options: [...c.rows.map((x) => opt(c.key, `ISRC belongs to row ${x.row}`, 'owner', { row: x.row })), opt(c.key, 'Belongs to neither', 'neither')],
      search: lnvText(c.rows), pop: 0,
    } : {
      id: c.key, kind: 'duplicate', item: c, lnv: c.rows, keep: c.decision?.choice === 'duplicate' ? keep : null,
      song: null, songNote: song ? `Same song on ${src}: ${song}` : c.reasons[0], warn: [],
      options: [...c.rows.map((x) => opt(c.key, `Keep row ${x.row}, remove the other${c.rows.length > 2 ? 's' : ''}`, 'duplicate', { keep: x.row })),
        opt(c.key, 'Keep all – different songs', 'different')],
      search: lnvText(c.rows), pop: 0,
    })
  }
  for (const m of r.missing) {
    if (m.rejected) continue
    out.push({ id: m.key, kind: m.credit === 'writer' ? 'missing' : 'other', item: m, lnv: [], song: m,
      warn: m.other_composers.length ? [`Other composers credited too: ${list(m.other_composers, 3)}`] : [],
      why: m.credit === 'writer' ? undefined : { shared: 'Other composers are credited', medley: 'Medley / mashup', performer: 'The client is not credited as a writer' }[m.credit],
      options: [opt(m.key, 'Add to LNV', 'add'), opt(m.key, 'Not our song – leave out', 'not_ours')],
      search: songText(m), pop: m.popularity })
  }
  for (const m of r.matched) {
    const rows = m.links.map((l) => l.lnv)
    out.push({ id: m.key, kind: 'found', item: { key: m.key, decision: m.decision }, lnv: rows, song: m.song,
      why: m.confirmed ? 'You confirmed it' : m.auto ?? m.links[0].evidence.join(' · '), warn: m.notes.map((x) => plain(x, src)),
      fills: rows.flatMap((x) => fills.get(x.row) ?? []),
      options: [opt(m.key, 'Same song', null), opt(m.key, 'Not the same – it is missing', 'none')],
      search: `${songText(m.song)} ${lnvText(rows)}`, pop: m.song.popularity })
  }
  return out
}

/** What will happen to a line: the app's choice or yours, changeable. */
function Outcome({ line, decide, busy }: { line: Line; decide: Decide; busy: boolean }) {
  const d = line.item.decision
  const value = line.kind === 'found' ? 'same' : valueOf(d)
  const byApp = !!d?.auto
  const change = (v: string) => {
    const o = line.options.find((x) => x.value === v)
    if (!o) return
    // Choosing the app's own answer again just goes back to it
    decide([line.item.auto && valueOf(line.item.auto) === v ? { key: line.item.key, choice: null } : o.make])
  }
  return (
    <div className="cmp-outcome">
      <select className={`cmp-select ${value ? '' : 'todo'}`} value={value} disabled={busy} onChange={(e) => change(e.target.value)} aria-label="Outcome">
        {!value && <option value="">Choose what to do…</option>}
        {line.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {value && line.kind !== 'found' && <small className="muted">{byApp ? <><Sparkles size={11} /> chosen by the app</> : 'chosen by you'}</small>}
    </div>
  )
}

function LnvCell({ line }: { line: Line }) {
  if (!line.lnv.length) return <div className="cmp-empty">Not in the LNV</div>
  return (
    <div className="cmp-cell">
      {line.lnv.map((x) => (
        <div key={x.row} className={`cmp-song ${line.keep != null && line.keep !== x.row ? 'removed' : ''}`}>
          <span className="cmp-row">Row {x.row}</span>
          <b>{x.title}</b>
          {line.keep === x.row && line.lnv.length > 1 && <span className="cmp-keep">keep</span>}
          {line.keep != null && line.keep !== x.row && <span className="cmp-remove">remove</span>}
          <small>{[x.movie, list(x.writers, 2)].filter((v) => v && v !== '—').join(' · ') || '—'}{x.isrcs.length > 0 && <> · <Mono>{x.isrcs[0]}</Mono></>}</small>
        </div>
      ))}
      {line.also && <small className="muted">{line.also}</small>}
    </div>
  )
}

function SongCell({ line, src }: { line: Line; src: string }) {
  const s = line.song
  if (!s) return <div className="cmp-empty">{line.songNote ?? `Not on ${src}`}</div>
  return (
    <div className="cmp-cell">
      <div className="cmp-song">
        <b>{s.title}</b>
        {s.link && <a href={s.link} target="_blank" rel="noreferrer" title={`Open on ${src}`}><ExternalLink size={12} /></a>}
        <small>{[s.album, s.year].filter(Boolean).join(' · ') || '—'} · {list([...s.lyricists, ...s.composers], 2)}{s.isrcs.length > 0 && <> · <Mono>{s.isrcs[0]}</Mono></>}</small>
      </div>
    </div>
  )
}

function CompareTable({ r, src, decide, busy }: { r: CleanResult; src: string; decide: Decide; busy: boolean }) {
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const lines = useMemo(() => buildLines(r, src), [r, src])
  const todo = (l: Line) => !l.item.decision && l.kind !== 'found' && l.kind !== 'other'
  const counts = Object.fromEntries(ORDER.map((k) => [k, lines.filter((l) => l.kind === k).length])) as Record<Kind, number>
  const nTodo = lines.filter(todo).length
  const show = (params.get('show') ?? (nTodo ? 'todo' : 'all')) as Kind | 'todo' | 'all'
  const setShow = (v: string) => { const p = new URLSearchParams(params); p.set('show', v); setParams(p, { replace: true }); setLimit(PAGE) }
  const q = query.trim().toLowerCase()
  const shown = lines
    .filter((l) => show === 'all' ? l.kind !== 'other' : show === 'todo' ? todo(l) : l.kind === show)
    .filter((l) => !q || l.search.toLowerCase().includes(q))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.pop - a.pop)
  useEffect(() => setLimit(PAGE), [query])
  const chips: [string, string, number, string][] = [
    ['todo', 'To decide', nTodo, 'brand'], ['all', 'All', lines.length - counts.other, ''],
    ...ORDER.map((k) => [k, KIND[k].chip, counts[k], KIND[k].tone] as [string, string, number, string]),
  ]
  return (
    <section className="stack">
      <div className="cmp-bar">
        <div className="cmp-chips" role="tablist" aria-label="Show">
          {chips.map(([id, label, count, tone]) => (
            <button key={id} type="button" role="tab" aria-selected={show === id} className={`${show === id ? 'active' : ''} ${tone}`} onClick={() => setShow(id)}>
              {label}<span>{n(count)}</span>
            </button>
          ))}
        </div>
        <label className="pl-search"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search song, film, writer, row or ISRC…" /></label>
      </div>

      {!shown.length ? (
        <Empty icon={<Check size={22} />} title={show === 'todo' && !q ? 'Nothing left to decide' : 'Nothing here'}>
          {show === 'todo' && !q ? 'Every line has an outcome – the app chose where it was sure, you chose the rest.' : 'Try another filter or search.'}</Empty>
      ) : (
        <div className="cmp">
          <div className="cmp-head">
            <span>Status</span><span><SheetTag kind="lnv">LNV · our sheet</SheetTag></span><span><SheetTag kind="export">{src} · export</SheetTag></span><span>Outcome</span>
          </div>
          {shown.slice(0, limit).map((l) => {
            const k = KIND[l.kind]
            return (
              <div key={l.id} className={`cmp-line ${k.tone} ${todo(l) ? 'todo' : ''}`}>
                <div className="cmp-status"><span className={`cmp-tag ${k.tone}`}>{k.icon}{k.label}</span>
                  {l.why && <small className="muted">{l.why}</small>}</div>
                <LnvCell line={l} />
                <SongCell line={l} src={src} />
                <Outcome line={l} decide={decide} busy={busy} />
                {(l.warn.length > 0 || (l.fills?.length ?? 0) > 0) && (
                  <div className="cmp-notes">
                    {l.warn.map((w) => <span key={w} className="cmp-warn"><AlertTriangle size={12} />{w}</span>)}
                    {l.fills && l.fills.length > 0 && <span className="cmp-fill"><Plus size={12} />Fills empty {l.fills.join(', ')} from {src}</span>}
                  </div>
                )}
              </div>
            )
          })}
          {shown.length > limit && <button type="button" className="pl-more" onClick={() => setLimit((x) => x + PAGE * 2)}>Show more ({n(shown.length - limit)} more lines)</button>}
        </div>
      )}
    </section>
  )
}

/** The few name spellings that stop songs matching, and the empty cells the export fills. */
function Settings({ r, src, decide, busy }: { r: CleanResult; src: string; decide: Decide; busy: boolean }) {
  const names = r.names.filter((x) => !x.info)
  const fields = useMemo(() => {
    const out = new Map<string, FillItem[]>()
    for (const f of r.fills) out.set(f.field, [...(out.get(f.field) ?? []), f])
    return [...out.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [r.fills])
  const filled = r.fills.filter((f) => f.decision?.choice === 'accept').length
  return (
    <div className="cmp-settings">
      {names.length > 0 && (
        <details className="more-detail">
          <summary>Names spelled two ways <span className="mv-count warn">{names.filter((x) => !x.decision).length} to decide</span>
            <small className="muted"> – they stop songs from matching; “same person” matches them straight away</small></summary>
          <div className="cmp-names">
            {names.map((x) => x.kind === 'spelling' ? (
              <label key={x.key}>
                <span><b>{(x as SpellingItem).a.spelling}</b> ≈ <b>{(x as SpellingItem).b.spelling}</b></span>
                <select className={`cmp-select ${x.decision ? '' : 'todo'}`} disabled={busy} value={x.decision?.choice ?? ''}
                  onChange={(e) => decide([{ key: x.key, choice: e.target.value === 'same' ? 'same' : 'different', data: { keep: (x as SpellingItem).a_key } }])}>
                  {!x.decision && <option value="">Choose…</option>}
                  <option value="same">Same person</option><option value="different">Different people</option>
                </select>
              </label>
            ) : (
              <label key={x.key}>
                <span><b>“{x.name}”</b> is not a person's name ({x.count}× in the LNV)</span>
                <select className={`cmp-select ${x.decision ? '' : 'todo'}`} disabled={busy} value={x.decision?.choice ?? ''}
                  onChange={(e) => decide([{ key: x.key, choice: e.target.value === 'fix' ? 'fix' : 'ok' }])}>
                  {!x.decision && <option value="">Choose…</option>}
                  <option value="fix">Fix it in the LNV</option><option value="ok">It is fine</option>
                </select>
              </label>
            ))}
          </div>
        </details>
      )}
      {fields.length > 0 && (
        <details className="more-detail">
          <summary>Empty LNV cells filled from {src} <span className="mv-count">{n(filled)}</span>
            <small className="muted"> – only from songs matched for sure; a filled cell is never changed</small></summary>
          <div className="cmp-fields">
            {fields.map(([field, items]) => {
              const on = items.filter((f) => f.decision?.choice === 'accept')
              return (
                <label key={field} className="cmp-field">
                  <input type="checkbox" checked={on.length > 0} disabled={busy}
                    onChange={() => decide(on.length ? on.map((f) => ({ key: f.key, choice: 'reject' })) : items.map((f) => ({ key: f.key, choice: null })))} />
                  <span><b>{field}</b> <small className="muted">{n(on.length)} of {n(items.length)} cells</small></span>
                </label>
              )
            })}
          </div>
        </details>
      )}
    </div>
  )
}

function Summary({ r, src }: { r: CleanResult; src: string }) {
  const { clientId } = useClient()
  const s = r.summary
  return (
    <section className="card cmp-summary">
      <div className="grow">
        <p className="dc-sentence">{src} lists <b>{n(r.source.songs)} songs</b> for this client: <b className="t-good">{n(s.matched)}</b> are in the LNV,{' '}
          <b className="t-bad">{n(s.missing_credit.writer ?? 0)}</b> are missing, and the LNV has <b className="t-warn">{n(s.duplicates)}</b> duplicates.</p>
        <p className="small muted">{n(s.lnv_not_on_dsp)} LNV rows are not on {src} – that is normal, {src} does not list every song. They are not shown.</p>
      </div>
      <a className="btn sm" href={api.cleanExportUrl(clientId)}><Download size={14} />Download report (Excel)</a>
    </section>
  )
}

/* ---------- the two sheets ---------- */

function Files({ p, busy, onUpload, onSheet, onRemove, result }: {
  p: CleanPayload; busy: boolean; result: CleanResult | null
  onUpload: (f: File) => void; onSheet: (s: string) => void; onRemove: () => void
}) {
  const { clientId } = useClient()
  const sheets = p.dsp?.stats.sheets ?? []
  return (
    <div className="dc-files">
      <div className="dc-file lnv">
        <SheetTag kind="lnv">LNV · our sheet</SheetTag>
        <p className="dc-file-what">The client's catalogue that we keep</p>
        {p.master ? (
          <>
            <p className="dc-file-name"><FileSpreadsheet size={15} />{p.master.name}</p>
            <p className="small muted">{n(p.master.stats.songs ?? 0)} songs · uploaded {fmtDate(p.master.uploaded_at)} · change it on the <Link to={`/clients/${clientId}`}>Home</Link> tab</p>
          </>
        ) : <p className="small">Not uploaded yet – add it on the <Link to={`/clients/${clientId}`}>Home</Link> tab first.</p>}
      </div>
      <div className="dc-vs" aria-hidden><span>compared with</span><ArrowLeft size={16} /></div>
      <div className="dc-file export">
        <SheetTag kind="export">Export · {p.dsp?.source ?? 'Muso / Spotify / Apple Music'}</SheetTag>
        <p className="dc-file-what">What the music services show – the .xlsx from MRM-Extractor</p>
        {p.dsp ? (
          <>
            <p className="dc-file-name"><FileSpreadsheet size={15} />{p.dsp.name}</p>
            <p className="small muted">
              {n(p.dsp.stats.rows ?? 0)} rows{result && <> = {n(result.source.songs)} songs (remixes and other versions counted with their song)</>}
              {sheets.length > 1 && <> · sheet <select className="inline-input" value={p.dsp.sheet} disabled={busy} onChange={(e) => onSheet(e.target.value)} aria-label="Sheet">
                {sheets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select></>}
            </p>
            <div className="dc-file-actions">
              <FileDrop compact title="Replace with another export" hint="Drop the .xlsx here" accept=".xlsx,.xlsm" busy={busy} onFile={onUpload} />
              <Button variant="ghost" icon={<Trash2 size={15} />} disabled={busy} onClick={onRemove} aria-label="Remove export" title="Remove export" />
            </div>
          </>
        ) : (
          <FileDrop title="Upload the export" hint="Muso, Spotify or Apple Music sheet from MRM-Extractor (.xlsx) – one at a time" accept=".xlsx,.xlsm"
            busy={busy} onFile={onUpload} />
        )}
      </div>
    </div>
  )
}

/* ---------- the page ---------- */

export default function DataClean() {
  const { clientId, refresh } = useClient()
  const toast = useToast()
  const [payload, setPayload] = useState<CleanPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [askRemove, setAskRemove] = useState(false)

  useEffect(() => {
    setPayload(null)
    api.clean(clientId).then(setPayload).catch((e) => setError((e as Error).message))
  }, [clientId])

  const run = useCallback(async (label: string, call: () => Promise<CleanPayload>, done?: string) => {
    setBusy(label)
    try {
      setPayload(await call())
      if (done) toast(done, 'good')
      refresh()
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(null)
    }
  }, [refresh, toast])
  const decide: Decide = useCallback((items) => items.length ? run('decide', () => api.cleanDecide(clientId, items),
    items.length > 1 ? `${n(items.length)} changes saved` : undefined) : Promise.resolve(), [clientId, run])

  if (error) return <Empty title="Data clean could not load">{error}</Empty>
  if (!payload) return <div className="loading"><span className="spinner" />Comparing the LNV with the export…</div>
  const r = payload.result
  const src = r?.source.name ?? payload.dsp?.source ?? 'the export'

  return (
    <div className="stack">
      <div className="dc-intro">
        <h2>Data clean <span className="muted">· step 1</span></h2>
        <p className="muted">The client's <SheetTag kind="lnv">LNV</SheetTag> next to the <SheetTag kind="export">export</SheetTag> from Muso, Spotify or Apple Music.
          Each line shows what the app found and what will happen; change the outcome where you disagree.</p>
      </div>
      <Files p={payload} result={r} busy={busy === 'upload'}
        onUpload={(f) => run('upload', () => api.uploadDsp(clientId, f), 'Export compared with the LNV')}
        onSheet={(s) => run('upload', () => api.chooseDspSheet(clientId, s), `Now comparing sheet “${s}”`)}
        onRemove={() => setAskRemove(true)} />
      {busy === 'upload' && <div className="loading"><span className="spinner" />Comparing the two sheets – this takes a few seconds for a big catalogue…</div>}
      {r && busy !== 'upload' && (
        <>
          <Summary r={r} src={src} />
          <Settings r={r} src={src} decide={decide} busy={!!busy} />
          <CompareTable r={r} src={src} decide={decide} busy={!!busy} />
        </>
      )}
      {busy === 'decide' && <div className="dc-saving"><span className="spinner small-dark" />Saving…</div>}

      <ConfirmDialog open={askRemove} title="Remove the export?" confirmLabel="Remove export" onCancel={() => setAskRemove(false)}
        onConfirm={async () => { setAskRemove(false); await run('upload', () => api.deleteDsp(clientId), 'Export removed') }}>
        <p>The export <b>{payload.dsp?.name}</b> is removed. Your choices are kept and used again with the next export.</p>
      </ConfirmDialog>
    </div>
  )
}
