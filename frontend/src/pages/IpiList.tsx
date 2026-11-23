import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search, Trash2 } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, ConfirmDialog, Guide, Stat } from '../components/ui'
import { api } from '../lib/api'
import type { IpiShow } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDate } from '../lib/client'
import { useToast } from '../lib/toast'
import type { IpiMemberT, IpiPayload, IpiUploadT } from '../types'
import { FileCard } from './client/Consolidate'

/** The IPI / CAE list: the society's member list (IPRS "AllNameType"), kept for every client. Each member's real name
 *  (PA) with their pseudonyms (PP) and group names (PG), each with its IPI. Uploading a newer list adds the new names
 *  and updates the changed ones here. Step 2 shows every name as the list has it – "RK" as "Ram Krishna" – and the LNV
 *  takes the member's PA name unless the reviewer keeps the LNV's, Muso's or a typed one. */

const fmt = (x?: number) => (x ?? 0).toLocaleString('en-IN')
const TYPE: Record<string, string> = { PA: 'Real name', PP: 'Pseudonym', PG: 'Group name' }
const ROLE: Record<string, string> = { C: 'Composer', A: 'Author', CA: 'Composer & author', E: 'Publisher', AR: 'Arranger', SE: 'Sub-publisher' }
const SHOWS: [IpiShow, string][] = [['all', 'All members'], ['new', 'New in the latest list'], ['updated', 'Updated in the latest list']]

/** What one upload changed, in a line. */
function uploadText(u: IpiUploadT) {
  const s = u.stats
  if (u.kind === 'clear') return `List cleared – ${fmt(s.removed)} names removed`
  return [`${fmt(s.added)} added`, `${fmt(s.updated)} updated`, `${fmt(s.unchanged)} unchanged`,
    u.kind === 'replace' ? `${fmt(s.removed)} removed (not in the file)` : s.kept ? `${fmt(s.kept)} kept from earlier lists` : '']
    .filter(Boolean).join(' · ')
}

export default function IpiList() {
  const { user } = useAuth()
  const toast = useToast()
  const [data, setData] = useState<IpiPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [show, setShow] = useState<IpiShow>('all')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [replace, setReplace] = useState(false)
  const [asking, setAsking] = useState(false)
  const [history, setHistory] = useState(false)
  const [last, setLast] = useState<IpiUploadT | null>(null)   // the upload just made: what it changed
  const seq = useRef(0)

  const load = useCallback(async (query: string, s: IpiShow, p: number) => {
    const mine = ++seq.current
    try {
      const d = await api.ipi(query, s, p)
      if (mine === seq.current) { setData(d); setError(null) }
    } catch (e) { if (mine === seq.current) setError((e as Error).message) }
  }, [])
  // a search waits for the typing to stop
  useEffect(() => {
    const t = window.setTimeout(() => { void load(q.trim(), show, page) }, q ? 250 : 0)
    return () => window.clearTimeout(t)
  }, [q, show, page, load])

  const upload = async (file: File) => {
    setBusy(true)
    try {
      const d = await api.uploadIpi(file, replace)
      setLast(d.upload ?? null)
      setQ(''); setShow('all'); setPage(1)
      setData(d)
      toast(`IPI / CAE list saved – ${d.upload ? uploadText(d.upload) : `${fmt(d.summary.names)} names`}`, 'good')
    } catch (e) { toast((e as Error).message, 'bad') } finally { setBusy(false) }
  }
  const clear = async () => {
    try {
      const d = await api.clearIpi()
      setData(d); setLast(null); setPage(1)
      toast('The IPI / CAE list is cleared', 'good')
    } catch (e) { toast((e as Error).message, 'bad') }
    setAsking(false)
  }

  const s = data?.summary
  const latest = s?.latest && s.latest.kind !== 'clear' ? s.latest : null
  return (
    <AppShell trail={<span className="trail-name">IPI / CAE list</span>}>
      <header className="page-header">
        <div><div className="eyebrow">Names · every client</div><h1>IPI / CAE list</h1>
          <p className="lede">{!s ? 'Loading…' : s.names ? <>{fmt(s.members)} members · {fmt(s.names)} names
            {latest && <> · updated {fmtDate(latest.at)} from <b title={latest.name}>{latest.name}</b></>}</> : 'No list yet – upload the society’s member list'}</p></div>
        {user?.is_admin && !!s?.names && <div className="page-actions"><Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setAsking(true)}>Clear the list</Button></div>}
      </header>

      <Guide id="ipi-list" title="How the IPI / CAE list is used" steps={[
        <>Upload the society’s <b>member list</b> (like “Member list (06.10.25).xlsx”): each member’s <b>real name (PA)</b> with their <b>pseudonyms (PP)</b> and group names, each with its IPI.</>,
        <>In <b>Muso vs LNV</b> every singer, composer, lyricist and publisher is looked up in it: a pseudonym or another spelling shows as the member’s PA name – “RK” as “Ram Krishna”. An LNV name is found by its <b>CAE number</b> first.</>,
        <>The LNV keeps the list’s name unless you pick the <b>LNV’s</b>, <b>Muso’s</b> or a <b>typed</b> one in the field’s dropdown.</>,
        <>Upload a newer list any time: new names are added and changed ones updated here. Tick <b>Remove names not in this file</b> to replace the whole list.</>,
      ]} />

      <section className="ipi-up">
        <FileCard tone="lnv" label="Member list" what="IPI / CAE member list (.xlsx or .csv) – NAME, IPI NO, BASE NO, NAME TYPE"
          file={latest?.name} text={latest ? `${fmt(s?.names)} names · ${fmt(s?.members)} members` : null} busy={busy} onFile={upload} accept=".xlsx,.xlsm,.csv" />
        <div className="ipi-up-side">
          <label className="ipi-replace"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            <span><b>Remove names not in this file</b><small className="muted">Off: names from earlier lists that this file does not have are kept</small></span></label>
          {last && <p className="ipi-last" role="status"><b>{last.name}</b> {uploadText(last)}</p>}
        </div>
      </section>

      {s && s.names > 0 && (
        <div className="ipi-stats">
          <Stat label="Members" value={fmt(s.members)} hint="one per real name" />
          <Stat label="Real names (PA)" value={fmt(s.types.PA)} tone="brand" />
          <Stat label="Pseudonyms (PP)" value={fmt(s.types.PP)} tone="info" hint="shown as the member’s real name" />
          <Stat label="Group names (PG)" value={fmt(s.types.PG)} hint="never turned into one person" />
        </div>
      )}

      {error && <div className="alert bad">{error}</div>}
      {s && s.names > 0 && data && (
        <section className="ipi-body">
          <div className="ipi-tools">
            <div className="rv-tabs" role="tablist" aria-label="Which members">
              {SHOWS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={show === id} className={show === id ? 'on' : ''}
                onClick={() => { setShow(id); setPage(1) }}>{label}{show === id && <span>{fmt(data.total)}</span>}</button>)}
            </div>
            <label className="cs-search ipi-search"><Search size={15} /><input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }}
              placeholder="Search a name, pseudonym, IPI or base number…" aria-label="Search the IPI / CAE list" /></label>
          </div>
          {!data.members.length ? <p className="sm-list-none">{q ? <>No member matches “{q}”.</> : show === 'all' ? 'The list is empty.' : 'Nothing here for the latest list.'}</p> : (
            <div className="ipi-table-wrap">
              <table className="data ipi-table">
                <thead><tr><th>Member – real name (PA)</th><th>IPI</th><th>Role</th><th>Other names in the list</th></tr></thead>
                <tbody>{data.members.map((m) => <MemberRow key={m.member} m={m} />)}</tbody>
              </table>
            </div>
          )}
          {data.pages > 1 && (
            <div className="ipi-pages">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} icon={<ChevronLeft size={15} />}>Previous</Button>
              <span className="muted">Page {fmt(data.page)} of {fmt(data.pages)} · {fmt(data.total)} members</span>
              <Button size="sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next<ChevronRight size={15} /></Button>
            </div>
          )}
        </section>
      )}

      {s && s.uploads.length > 0 && (
        <section className="ipi-history">
          <button type="button" className="rv-text-btn" onClick={() => setHistory(!history)} aria-expanded={history}>
            {history ? <ChevronUp size={14} /> : <ChevronDown size={14} />}Uploads ({fmt(s.uploads.length)})</button>
          {history && (
            <table className="data ipi-uploads">
              <thead><tr><th>When</th><th>File</th><th>By</th><th>What changed</th></tr></thead>
              <tbody>{s.uploads.map((u) => (
                <tr key={u.id}><td className="nowrap">{fmtDate(u.at)}</td><td>{u.kind === 'clear' ? <span className="muted">List cleared</span> : u.name}</td>
                  <td>{u.by || '—'}</td><td>{uploadText(u)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
      )}

      <ConfirmDialog open={asking} title="Clear the IPI / CAE list?" confirmLabel="Clear the list" onCancel={() => setAsking(false)} onConfirm={clear}>
        <p>Every name of the list goes. Muso vs LNV then shows the names as the files write them, until a list is uploaded again.</p>
      </ConfirmDialog>
    </AppShell>
  )
}

function MemberRow({ m }: { m: IpiMemberT }) {
  const others = m.names.filter((x) => x.type !== 'PA')
  const pa = m.names.find((x) => x.type === 'PA')
  return (
    <tr className={m.new ? 'ipi-new' : m.updated ? 'ipi-upd' : ''}>
      <td><b>{m.name}</b>{m.new && <span className="ipi-flag new">New</span>}{m.updated && !m.new && <span className="ipi-flag upd">Updated</span>}
        <small className="muted ipi-sub">{pa && pa.name !== m.name ? <>{pa.name} · </> : null}<span className="mono">{m.member}</span></small></td>
      <td className="mono nowrap">{m.ipi || '—'}</td>
      <td className="nowrap">{ROLE[m.role] ?? (m.role || '—')}</td>
      <td>{others.length ? <span className="ipi-names">{others.map((x) => (
        <span key={`${x.type}-${x.ipi}-${x.name}`} className={`ipi-name ${x.type.toLowerCase()} ${x.new ? 'new' : x.updated ? 'upd' : ''}`} title={`${TYPE[x.type] ?? x.type}${x.ipi ? ` · IPI ${x.ipi}` : ''}`}>
          <i>{x.type}</i>{x.name}{x.ipi && <small className="mono">{x.ipi}</small>}</span>
      ))}</span> : <span className="muted">—</span>}</td>
    </tr>
  )
}
