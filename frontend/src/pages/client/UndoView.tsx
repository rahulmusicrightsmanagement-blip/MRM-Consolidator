import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, RotateCcw, Search, Undo2 } from 'lucide-react'
import { ConfirmDialog } from '../../components/ui'
import { api } from '../../lib/api'
import { useClient } from '../../lib/client'
import { useToast } from '../../lib/toast'
import type { ChangeT } from '../../types'
import { n, norm } from './Block'
import { OTHER, changesText } from './changeLog'

/** The Undo section: the songs that were worked on, each with the list of its changes – newest first – to tick and
 *  undo. A song moved from A to B is listed under both. An undone change can be made again. */

type SongChanges = { key: string; title: string; changes: ChangeT[]; live: number }
export function bySong(changes: ChangeT[]): SongChanges[] {
  const out = new Map<string, SongChanges>()
  for (const c of changes) {
    for (const s of c.songs.length ? c.songs : [OTHER]) {
      const x = out.get(s.key) ?? { key: s.key, title: s.title, changes: [], live: 0 }
      x.changes.push(c)
      if (!c.undone_at && !c.closed) x.live += 1
      out.set(s.key, x)
    }
  }
  return [...out.values()]
}
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export function UndoView({ song, flush, act, version }: {
  /** the song to open (from its "Undo" button) */
  song: string | null
  flush: () => Promise<boolean>; act: (work: () => Promise<unknown>) => Promise<boolean>
  /** changes whenever the answers were loaded again: the list follows */
  version: unknown
}) {
  const { clientId } = useClient()
  const toast = useToast()
  const [changes, setChanges] = useState<ChangeT[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(song)
  const [ticked, setTicked] = useState<number[]>([])
  const [asking, setAsking] = useState<number[] | null>(null)
  const [q, setQ] = useState('')
  const load = useCallback(() => api.changes(clientId).then((c) => { setChanges(c); setError('') }).catch((e) => setError((e as Error).message)), [clientId])
  useEffect(() => { void load() }, [load, version])
  const songs = useMemo(() => bySong(changes ?? []), [changes])
  const s = norm(q)
  const shown = songs.filter((x) => !s || norm(x.title).includes(s) || x.changes.some((c) => norm(c.lines.join(' ')).includes(s)))
  const sel = shown.find((x) => x.key === open) ?? shown[0] ?? null
  const byId = useMemo(() => new Map((changes ?? []).map((c) => [c.id, c])), [changes])
  const all = (ids: number[]) => [...new Set(ids.flatMap((i) => [i, ...(byId.get(i)?.with ?? [])]))].flatMap((i) => byId.get(i) ?? []).sort((a, b) => b.id - a.id)
  const undo = async (ids: number[]) => {
    const ok = await flush() && await act(() => api.undo(clientId, ids).then((r) => setChanges(r.changes)))
    setAsking(null)
    if (ok) { setTicked([]); toast(`${changesText(all(ids).length)} undone`, 'good') } else void load()
  }
  const redo = async (c: ChangeT) => { if (await flush() && await act(() => api.redo(clientId, c.id).then((r) => setChanges(r.changes)))) toast('Made again', 'good'); else void load() }

  if (error) return <div className="alert bad">{error}</div>
  if (!changes) return <div className="loading"><span className="spinner" />Reading the changes…</div>
  if (!changes.length) return <p className="un-none">No change yet. Every answer saved from now on is listed here, song by song, and can be undone.</p>
  const canTick = (c: ChangeT) => !c.undone_at && !c.closed
  const live = ticked.filter((i) => { const c = byId.get(i); return c && canTick(c) })
  return (
    <div className="un">
      <div className="un-songs">
        <label className="cs-search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a song or a change…" aria-label="Search the changes" /></label>
        <div className="un-list">{shown.map((x) => (
          <button key={x.key} type="button" className={`sm-item ${sel?.key === x.key ? 'on' : ''}`} onClick={() => { setOpen(x.key); setTicked([]) }}>
            <span className="sm-item-text"><b>{x.title}</b><small>{x.live ? `${changesText(x.live)} to undo` : 'All undone'}</small></span></button>))}
          {!shown.length && <p className="sm-list-none">Nothing matches.</p>}</div>
      </div>
      <div className="un-detail">
        {sel && <>
          <header><h3>{sel.title}</h3><span className="muted">{changesText(sel.changes.length)}, newest first</span><span className="grow" />
            <button type="button" className="btn primary" disabled={!live.length} onClick={() => setAsking(live)}><Undo2 size={15} />Undo selected{live.length ? ` (${n(live.length)})` : ''}</button></header>
          <ul className="un-changes">{sel.changes.map((c) => (
            <li key={c.id} className={c.undone_at ? 'undone' : c.closed ? 'closed' : ''}>
              <label className="un-tick"><input type="checkbox" disabled={!canTick(c)} checked={live.includes(c.id)} aria-label={`Select: ${c.lines[0]}`}
                onChange={() => setTicked((t) => (t.includes(c.id) ? t.filter((i) => i !== c.id) : [...t, c.id]))} />
                <span>{c.lines.map((l) => <b key={l}>{l}</b>)}
                  <small className="muted">{[when(c.at), c.by && `by ${c.by}`, c.songs.length > 1 && `also under ${c.songs.filter((y) => y.key !== sel.key).map((y) => `“${y.title}”`).join(', ')}`].filter(Boolean).join(' · ')}</small>
                  {c.undone_at && <small className="un-done"><Check size={12} />Undone {when(c.undone_at)}{c.undone_by ? ` by ${c.undone_by}` : ''}</small>}
                  {c.closed && !c.undone_at && <small className="muted">From before the sheet was replaced – it can no longer be undone.</small>}
                  {canTick(c) && c.with.length > 0 && <small className="un-with">Undoing it also undoes {c.with.length === 1 ? '1 later change' : `${n(c.with.length)} later changes`} on the same answer.</small>}</span></label>
              {canTick(c) ? <button type="button" className="btn sm" onClick={() => setAsking([c.id])}><Undo2 size={14} />Undo</button>
                : c.undone_at && !c.closed ? <button type="button" className="rv-text-btn" onClick={() => void redo(c)}><RotateCcw size={14} />Make again</button> : null}
            </li>))}</ul>
        </>}
      </div>
      <ConfirmDialog open={!!asking} tone="primary" title={`Undo ${changesText(all(asking ?? []).length)}?`} confirmLabel="Undo" onCancel={() => setAsking(null)} onConfirm={() => undo(asking ?? [])}>
        <ul className="un-ask">{all(asking ?? []).map((c) => <li key={c.id}>{c.lines.join(' · ')}{!(asking ?? []).includes(c.id) && <small className="muted"> – later change on the same answer</small>}</li>)}</ul>
        <p>Each answer goes back to what it was before.</p>
      </ConfirmDialog>
    </div>
  )
}
