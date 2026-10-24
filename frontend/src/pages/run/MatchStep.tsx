import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ban, Download, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { StatusBar } from '../../components/StatusBar'
import { Badge, Button, Card, DataTable, Empty, Mono } from '../../components/ui'
import { useRun } from '../../lib/run'
import { songForWork } from '../../lib/model'
import type { FillBlock, FillRow } from '../../types'
import { MapTab, GapsTab } from './Panels'
import { PairPanel } from './PairPanel'
import { SuggestionReview } from './Suggestions'

/** One step instead of "Map with master" + "Fill IPRS columns": every song's outcome, exceptions first. */
type View = 'decide' | 'client' | 'general' | 'not_registered' | 'new' | 'not_our_work' | 'all' | 'links'

/** Reason types, read from the reasons the server writes into "Purpose of amendment", with what each means for
 *  royalties, what to ask IPRS and which proof to attach. */
type Priority = 'high' | 'medium'
interface ReasonType { id: string; label: string; test: RegExp; priority: Priority; impact: string; fix: string; proof: string }
const CLIENT_REASONS: ReasonType[] = [
  { id: 'credit', label: 'Client not credited', test: /^Client not credited/, priority: 'high',
    impact: 'IPRS pays this work without the client – their share goes to the other writers or stays unclaimed.',
    fix: 'Ask IPRS to add the client to the work with the right role and share.',
    proof: 'Credits (CD inlay or DSP screenshot), digital link, split sheet or agreement.' },
  { id: 'share', label: 'Share differs', test: /^Client share/, priority: 'high',
    impact: 'The client is paid the share IPRS has on file, not the agreed share.',
    fix: 'Ask IPRS to change the client\'s share to the one in our master.',
    proof: 'Split sheet or publishing / writer agreement showing the agreed split.' },
  { id: 'role', label: 'Role differs', test: /^Client is (Author|Composer)/, priority: 'high',
    impact: 'Lyricist and composer shares are paid separately – a wrong role can lose one of them.',
    fix: 'Ask IPRS to correct the client\'s role (lyricist / composer, or both).',
    proof: 'Credits showing "Lyrics by" / "Music by".' },
  { id: 'ipi', label: 'IPI number', test: /^Client IPI/, priority: 'high',
    impact: 'The IPI links the credit to the client\'s account – a missing or wrong one can hold the payment or send it to a namesake.',
    fix: 'Give IPRS the client\'s correct IPI name number for this work.',
    proof: 'The client\'s IPRS membership details (IPI name number).' },
  { id: 'society', label: 'Wrong society', test: /^Client shown with society/, priority: 'medium',
    impact: 'Shown with another society, the client may be treated as a foreign or non-member writer and paid through another route.',
    fix: 'Ask IPRS to show the client as an IPRS member on this work.',
    proof: 'IPRS membership confirmation.' },
]
const GENERAL_REASONS: ReasonType[] = [
  { id: 'total', label: 'Shares ≠ 100%', test: /^Shares do not total/, priority: 'high',
    impact: 'A registration whose shares do not add up to 100% is usually held or paid only in part.',
    fix: 'Ask IPRS to add the missing party or correct the shares so they total 100%.',
    proof: 'Split sheet with every writer and publisher share.' },
  { id: 'dup', label: 'Same ISWC on 2 works', test: /^Same ISWC/, priority: 'high',
    impact: 'Two registrations of one song split or block royalties – usage may be paid to only one of them.',
    fix: 'Ask IPRS to merge the duplicate works into one.',
    proof: 'Both IPRS work numbers and the shared ISWC.' },
  { id: 'composers', label: 'Composers', test: /^Composers –/, priority: 'medium',
    impact: 'Music shares are split among the wrong people.',
    fix: 'Ask IPRS to correct the composer list (add / remove, with IPI numbers).',
    proof: 'Credits and split sheet.' },
  { id: 'authors', label: 'Authors', test: /^Authors –/, priority: 'medium',
    impact: 'Lyric shares are split among the wrong people.',
    fix: 'Ask IPRS to correct the author (lyricist) list, with IPI numbers.',
    proof: 'Credits and split sheet.' },
  { id: 'publishers', label: 'Publishers', test: /^Publishers –/, priority: 'medium',
    impact: 'The publisher share goes to the wrong company or stays unclaimed.',
    fix: 'Ask IPRS to correct the publisher on the work.',
    proof: 'Publishing or label agreement.' },
  { id: 'iswc', label: 'ISWC differs', test: /^ISWC /, priority: 'medium',
    impact: 'Different ISWCs stop the song being matched across societies and services.',
    fix: 'Confirm the correct ISWC with IPRS and update whichever side is wrong.',
    proof: 'ISWC from the original registration.' },
]
type Group = ReasonType

/** "Publishers – Only in IPRS: X; Only in master: Y" → readable pieces. */
function Reason({ text, groups }: { text: string; groups: Group[] }) {
  const g = groups.find((x) => x.test.test(text))
  const [head, rest] = text.includes(' – ') ? [text.slice(0, text.indexOf(' – ')), text.slice(text.indexOf(' – ') + 3)] : ['', text]
  const parts = rest.split('; ').map((p) => {
    const [label, names] = p.split(': ')
    if (label === 'Only in IPRS') return <span key={p}><em>only at IPRS:</em> {names}</span>
    if (label === 'Only in master') return <span key={p}><em>only in our master:</em> {names}</span>
    return <span key={p}>{p}</span>
  })
  return (
    <div className="reason">
      {g && <span className={`reason-tag ${g.priority}`}>{g.label}</span>}
      <span className="reason-text">{head && g?.label !== head && <b>{head}: </b>}{parts.reduce<ReactNode[]>((a, p, i) => i ? [...a, ' · ', p] : [p], [])}</span>
    </div>
  )
}

/** Each IPRS work's latest round – an earlier, kept block drops out once a new block for the same code follows it. */
const currentBlocks = (r: FillRow) => {
  const newer = new Set(r.blocks.filter((b) => b.round === 'new').map((b) => b.internal_no))
  return r.blocks.filter((b) => !(b.round === 'kept' && newer.has(b.internal_no)))
}

/** Where this block goes in the master, in words. */
function RoundTag({ b }: { b: FillBlock }) {
  if (b.round === 'kept') return <span className="round-tag kept" title="This IPRS code already has an amendment in our master and nothing new was found – the block is left exactly as it is">Earlier amendment – kept (block {b.slot})</span>
  if (b.round === 'new') return <span className="round-tag new" title="Something new since the earlier amendment – written into the next free IPRS block; the earlier block stays as it is">New → block {b.slot} (block {b.earlier.join(', ')} kept)</span>
  return null
}

const statusTone = (v: string) => v === 'Uploaded' ? 'good' : v === 'Amend' ? 'warn' : v === 'Not registered' ? 'bad' : 'neutral'

function StatusList({ r, pick }: { r: FillRow; pick: (b: FillBlock) => string }) {
  if (!r.blocks.length) {
    if (r.state === 'pending') return <Badge tone="brand" icon={false}>Waiting</Badge>
    return <Badge tone={r.not_our_work ? 'neutral' : 'bad'} icon={false}>{r.not_our_work ? 'Not our work' : 'Not registered'}</Badge>
  }
  return <div className="status-list">{r.blocks.map((b) => <Badge key={b.slot} tone={statusTone(pick(b))} icon={false}>{r.blocks.length > 1 ? `${b.slot}: ` : ''}{pick(b)}</Badge>)}</div>
}

function NotOursButton({ r }: { r: FillRow }) {
  const { flagSongs, busy } = useRun()
  if (r.marked_in_master) return <span className="small muted">marked in master</span>
  if (r.state === 'pending') return null
  return (
    <Button size="sm" variant={r.not_our_work ? 'default' : 'ghost'} disabled={!!busy} onClick={(e) => { e.stopPropagation(); flagSongs([r.key], !r.not_our_work) }}>
      {r.not_our_work ? 'Undo Not our work' : 'Not our work'}</Button>
  )
}

const songCell = (r: FillRow) => <div><strong>{r.title}</strong><span className="small muted block">{r.master_row ? `master row ${r.master_row}` : 'new row – added from IPRS'}</span></div>
const bulkNotOurs = (flagSongs: (k: string[], on: boolean) => Promise<void>, busy: string | null) => (sel: FillRow[], clear: () => void) => (
  <>
    <Button size="sm" icon={<Ban size={14} />} disabled={!!busy} onClick={async () => { await flagSongs(sel.map((r) => r.key), true); clear() }}>Mark {sel.length} Not our work</Button>
    <Button size="sm" variant="ghost" disabled={!!busy} onClick={async () => { await flagSongs(sel.map((r) => r.key), false); clear() }}>Remove Not our work</Button>
  </>
)

/** IPRS and our master side by side for one registration, with the "keep IPRS / keep ours" choices. */
function Detail({ r, b, focus }: { r: FillRow; b?: FillBlock; focus?: string[] }) {
  const { model, openSong } = useRun()
  const link = b ? model?.links.get(b.internal_no) : undefined
  const song = b && model ? songForWork(model, b.internal_no) : null
  return (
    <div className="detail" onClick={(e) => e.stopPropagation()}>
      {song && <div className="decide-head"><h4>{r.title}</h4><Button size="sm" variant="ghost" onClick={() => openSong(song.key)}>Open song<ExternalLink size={13} /></Button></div>}
      <PairPanel work={b?.internal_no ?? null} row={r.master_row} link={link} focus={focus} />
    </div>
  )
}

/** Client amend / General amend: one line per IPRS registration that needs an amendment, grouped by reason. */
function AmendView({ kind, rows, filter, setFilter }: { kind: 'client' | 'general'; rows: FillRow[]; filter: string; setFilter: (f: string) => void }) {
  const { exportUrl, flagSongs, busy } = useRun()
  const groups = kind === 'client' ? CLIENT_REASONS : GENERAL_REASONS
  const reasonsOf = (b: FillBlock) => kind === 'client' ? b.client_reasons : b.general_reasons
  const lines = rows.flatMap((r) => currentBlocks(r).filter((b) => (kind === 'client' ? b.client_status : b.general_status) === 'Amend').map((b) => ({ key: `${r.key}-${b.slot}`, r, b })))
  const count = (g: Group) => lines.filter((l) => reasonsOf(l.b).some((t) => g.test.test(t))).length
  const group = groups.find((g) => g.id === filter)
  const shown = group ? lines.filter((l) => reasonsOf(l.b).some((t) => group.test.test(t))) : lines
  if (!lines.length) return <Empty title={kind === 'client' ? 'No client amendments' : 'No general amendments'}>
    {kind === 'client' ? 'IPRS has the client\'s own credit right on every registration.' : 'Every other detail on the registrations agrees with our master.'}</Empty>
  // Most urgent first: high-priority reasons, then the number of reasons.
  const rank = (b: FillBlock) => (reasonsOf(b).some((t) => groups.find((g) => g.test.test(t))?.priority === 'high') ? 0 : 1) * 100 - reasonsOf(b).length
  const sorted = [...shown].sort((a, b) => rank(a.b) - rank(b.b))
  return (
    <div className="stack">
      <div className="mv-intro">
        <p className="grow">{kind === 'client'
          ? <><b>Client status “Amend”</b> – IPRS has the <b>client's own credit</b> wrong. These come first: the client may not be paid, or paid the wrong amount.</>
          : <><b>General Status “Amend”</b> – the client's credit is right, but <b>something else</b> on the registration differs from our master: co-writers, publishers, ISWC or share totals.</>}</p>
        <a className="btn sm" href={exportUrl('amend_lnv')}><Download size={14} />Amend report (LNV)</a>
      </div>
      <div className="reason-cards" role="tablist" aria-label="Reason">
        <button type="button" role="tab" aria-selected={!group} className={`reason-card ${!group ? 'active' : ''}`} onClick={() => setFilter('')}>
          <span className="rc-top"><b>All reasons</b><span className="rc-n">{lines.length}</span></span>
          <small>Every registration to amend, most urgent first.</small>
        </button>
        {groups.filter((g) => count(g) > 0).map((g) => (
          <button key={g.id} type="button" role="tab" aria-selected={filter === g.id} className={`reason-card ${g.priority} ${filter === g.id ? 'active' : ''}`} onClick={() => setFilter(filter === g.id ? '' : g.id)}>
            <span className="rc-top"><b>{g.label}</b><span className="rc-n">{count(g)}</span></span>
            <small>{g.impact}</small>
            <span className={`rc-prio ${g.priority}`}>{g.priority === 'high' ? 'High priority' : 'Medium priority'}</span>
          </button>
        ))}
      </div>
      {group && (
        <div className="reason-guide">
          <div><span>Why it matters</span><p>{group.impact}</p></div>
          <div><span>What to ask IPRS</span><p>{group.fix}</p></div>
          <div><span>Proof to attach</span><p>{group.proof}</p></div>
        </div>
      )}
      <Card flush>
        <DataTable rows={sorted} rowKey={(l) => l.key} search={(l) => `${l.r.title} ${l.b.internal_no} ${reasonsOf(l.b).join(' ')}`}
          selectable bulk={(sel, clear) => bulkNotOurs(flagSongs, busy)(sel.map((l) => l.r), clear)}
          columns={[
            { key: 'song', header: 'Song', sort: (l) => l.r.title, render: (l) => songCell(l.r) },
            { key: 'code', header: 'IPRS code', sort: (l) => l.b.internal_no, render: (l) => <div><Mono>{l.b.internal_no}</Mono>
              {l.b.round === 'first' ? (l.r.blocks.length > 1 && <span className="small muted block">block {l.b.slot}</span>) : <RoundTag b={l.b} />}</div> },
            { key: 'what', header: kind === 'client' ? 'What is wrong with the client\'s credit' : 'What else differs', render: (l) => <div className="reasons">{reasonsOf(l.b).map((t) => <Reason key={t} text={t} groups={groups} />)}</div> },
            { key: 'purpose', header: 'Purpose of amendment (goes into the Excel)', render: (l) => <p className="purpose">{l.b.purpose || <span className="muted">—</span>}</p> },
            { key: 'other', header: kind === 'client' ? 'General Status' : 'Client status', render: (l) => {
              const v = kind === 'client' ? l.b.general_status : l.b.client_status
              return <Badge tone={statusTone(v)} icon={false}>{v}</Badge>
            } },
            { key: 'nw', header: '', render: (l) => <NotOursButton r={l.r} /> },
          ]}
          expand={(l) => <Detail r={l.r} b={l.b} focus={reasonsOf(l.b)} />} />
      </Card>
    </div>
  )
}

/** Songs without an IPRS registration, songs added from IPRS, songs marked "Not our work", or every song. */
function SongsView({ rows, intro, download }: { rows: FillRow[]; intro: ReactNode; download?: { href: string; label: string } }) {
  const { flagSongs, busy } = useRun()
  return (
    <div className="stack">
      <div className="mv-intro"><p className="grow">{intro}</p>{download && <a className="btn sm" href={download.href}><Download size={14} />{download.label}</a>}</div>
      <Card flush>
        <DataTable<FillRow> rows={rows} rowKey={(r) => r.key} search={(r) => `${r.title} ${r.blocks.map((b) => `${b.internal_no} ${b.iswc} ${b.isrc}`).join(' ')}`}
          selectable bulk={bulkNotOurs(flagSongs, busy)} empty="No songs here."
          columns={[
            { key: 'title', header: 'Song', sort: (r) => r.title, render: songCell },
            { key: 'codes', header: 'IPRS blocks', render: (r) => r.blocks.length ? <div className="block-list">{r.blocks.map((b) => (
              <div key={b.slot}><span className="mono small">{b.slot}: {b.internal_no}</span>{b.round !== 'first' && <RoundTag b={b} />}</div>))}</div>
              : r.state === 'not_registered' || r.state === 'not_our_work' ? (r.status_slot
                ? <span className="round-tag new">status → block {r.status_slot}</span> : <span className="round-tag kept">already marked in our master</span>)
              : <span className="muted small">—</span> },
            { key: 'client', header: 'Client status', render: (r) => <StatusList r={r} pick={(b) => b.client_status} /> },
            { key: 'general', header: 'General Status', render: (r) => <StatusList r={r} pick={(b) => b.general_status} /> },
            { key: 'nw', header: '', render: (r) => <NotOursButton r={r} /> },
          ]}
          expand={(r) => r.blocks.length ? <Detail r={r} b={r.blocks[0]} /> : r.master_row ? <Detail r={r} /> : null} />
      </Card>
    </div>
  )
}

export function IprsMatchStep() {
  const { payload, model, exportUrl } = useRun()
  const [params, setParams] = useSearchParams()
  const fill = payload!.result.fill
  const waiting = model?.review.length ?? 0
  const rows = useMemo(() => fill?.rows ?? [], [fill])
  if (!fill) return <Empty title="Nothing to show yet">Upload the IPRS report and our master first.</Empty>

  const hasAmend = (r: FillRow, k: 'client_status' | 'general_status') => currentBlocks(r).some((b) => b[k] === 'Amend')
  const sets: Record<Exclude<View, 'decide' | 'links'>, FillRow[]> = {
    client: rows.filter((r) => !r.not_our_work && hasAmend(r, 'client_status')),
    general: rows.filter((r) => !r.not_our_work && hasAmend(r, 'general_status')),
    not_registered: rows.filter((r) => r.state === 'not_registered'),
    new: rows.filter((r) => r.origin === 'iprs'),
    not_our_work: rows.filter((r) => r.state === 'not_our_work'),
    all: rows,
  }
  const raw = params.get('view') as View | null
  const fallback: View = waiting ? 'decide' : sets.client.length ? 'client' : sets.general.length ? 'general' : 'all'
  const view: View = raw && (raw !== 'decide' || waiting) ? raw : fallback
  const setView = (v: View, reason = '') => {
    const n = new URLSearchParams(params)
    n.set('view', v)
    if (reason) n.set('reason', reason); else n.delete('reason')
    setParams(n, { replace: true })
  }
  const reason = params.get('reason') ?? ''

  const sm = fill.summary
  const tabs: { id: View; label: string; n?: number; tone: string }[] = [
    ...(waiting ? [{ id: 'decide' as View, label: 'To decide', n: waiting, tone: 'brand' }] : []),
    { id: 'client', label: 'Client amend', n: sets.client.length, tone: 'warn' },
    { id: 'general', label: 'General amend', n: sets.general.length, tone: 'warn' },
    { id: 'not_registered', label: 'Not registered', n: sets.not_registered.length, tone: 'bad' },
    { id: 'new', label: 'New from IPRS', n: sets.new.length, tone: '' },
    { id: 'not_our_work', label: 'Not our work', n: sets.not_our_work.length, tone: '' },
    { id: 'all', label: 'All songs', n: rows.length, tone: '' },
    { id: 'links', label: 'IPRS ↔ master links', tone: '' },
  ]

  return (
    <div className="stack">
      <section className="card outcome">
        <div className="outcome-head">
          <div className="grow"><h3>How the catalogue came out</h3>
            <p className="muted small">{rows.length.toLocaleString()} songs in the updated master · matched songs are done automatically – only the tabs with a number need you.</p>
            {(sm.kept > 0 || sm.new_rounds > 0) && <p className="small rounds-note">Every IPRS block that already has data in our master is <b>left untouched</b> – new information goes into the <b>next empty block</b>
              {sm.new_rounds > 0 && <> · <b>{sm.new_rounds}</b> IPRS code{sm.new_rounds === 1 ? ' has' : 's have'} something new since the earlier block</>}.</p>}</div>
          <a className="btn primary sm" href={exportUrl('final')}><Download size={14} />Download updated master</a>
        </div>
        <StatusBar label="Songs by outcome" segments={[
          { label: 'Uploaded – nothing to do', value: sm.uploaded, tone: 'good', onClick: () => setView('all') },
          { label: 'Amend', value: sm.amend, tone: 'warning', onClick: () => setView(sets.client.length ? 'client' : 'general') },
          { label: 'Not registered', value: sm.not_registered, tone: 'critical', onClick: () => setView('not_registered') },
          { label: 'Not our work', value: sm.not_our_work, tone: 'neutral', onClick: () => setView('not_our_work') },
          { label: 'Waiting for your decision', value: sm.pending, tone: 'serious', onClick: () => waiting && setView('decide') },
        ]} />
      </section>

      <nav className="mv-tabs" role="tablist" aria-label="Results">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={view === t.id} className={`${view === t.id ? 'active' : ''} ${t.tone}`} onClick={() => setView(t.id)}>
            {t.label}{t.n !== undefined && <span className={`mv-count ${t.n ? t.tone : ''}`}>{t.n.toLocaleString()}</span>}
          </button>
        ))}
      </nav>

      {view === 'decide' && <SuggestionReview />}
      {(view === 'client' || view === 'general') && <AmendView key={view} kind={view} rows={sets[view]} filter={reason} setFilter={(f) => setView(view, f)} />}
      {view === 'not_registered' && <SongsView rows={sets.not_registered} download={{ href: exportUrl('registration_lnv'), label: 'Registration report (LNV)' }}
        intro={<><b>Not registered</b> – songs in our master with no IPRS registration. Block 1 gets “Not registered”; register them at IPRS.</>} />}
      {view === 'new' && <SongsView rows={sets.new}
        intro={<><b>New from IPRS</b> – IPRS works our master did not have. They are added at the bottom of the updated master, with their IPRS code.</>} />}
      {view === 'not_our_work' && <SongsView rows={sets.not_our_work}
        intro={<><b>Not our work</b> – songs you (or the master) marked as not the client's. Both statuses say “Not our work”; nothing to amend.</>} />}
      {view === 'all' && <SongsView rows={rows}
        intro={<>Every song of the updated master and its IPRS columns. A song IPRS registered more than once keeps <b>one row</b> and fills block 1, 2, 3 …</>} />}
      {view === 'links' && (
        <>
          <MapTab />
          <details className="more-detail"><summary>See the songs added from IPRS and the gaps filled in our master</summary><GapsTab /></details>
        </>
      )}
    </div>
  )
}
