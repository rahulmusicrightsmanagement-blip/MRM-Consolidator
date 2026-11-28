import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, CircleCheckBig, Flag, RotateCcw } from 'lucide-react'
import { Button, ConfirmDialog, Dropdown, FileButton } from '../../components/ui'
import { api } from '../../lib/api'
import type { LnvOrder } from '../../lib/api'
import { fmtDate } from '../../lib/client'
import type { Stage1Done } from '../../types'
import { n } from './Block'

/** The two LNVs of a client: stage 1 – the LNV with Muso vs LNV's (step 2's) answers written in – and stage 2 – the one
 *  LNV vs IPRS (step 3) checks: step 2's result, kept when step 2 is marked completed, or a corrected one uploaded in
 *  its place. */

const ORDER_KEY = 'mrm-lnv-order'
function useLnvOrder(): [LnvOrder, (o: LnvOrder) => void] {
  const [o, setO] = useState<LnvOrder>(() => { try { return localStorage.getItem(ORDER_KEY) === 'album' ? 'album' : 'song' } catch { return 'song' } })
  return [o, (x) => { setO(x); try { localStorage.setItem(ORDER_KEY, x) } catch { /* private mode */ } }]
}

const ROWS_KEY = 'mrm-lnv-rows'
type LnvRows = 'checked' | 'all'
/** Which rows the stage 1 download holds – the songs checked in step 2, or every row of the LNV – kept for next time. */
function useLnvRows(): [LnvRows, (r: LnvRows) => void] {
  const [r, setR] = useState<LnvRows>(() => { try { return localStorage.getItem(ROWS_KEY) === 'all' ? 'all' : 'checked' } catch { return 'checked' } })
  return [r, (x) => { setR(x); try { localStorage.setItem(ROWS_KEY, x) } catch { /* private mode */ } }]
}
const ROWS = [
  { value: 'checked' as const, label: 'Checked songs', hint: 'Only the songs checked in step 2 – numbered 1, 2, 3 …' },
  { value: 'all' as const, label: 'Every row', hint: 'The whole LNV with the answers – what goes on to LNV vs IPRS' },
]

const ORDERS = [
  { value: 'song' as const, label: 'Songs A–Z', hint: "By song title – each song's rows together, its main version first" },
  { value: 'album' as const, label: 'Albums A–Z', hint: 'By album (film), then song – rows with no album last' },
]

/** Download the stage 1 LNV, the rows in the order picked: by song or by album. */
export function Stage1Download({ clientId, before, primary, label = 'Download stage 1 LNV' }: {
  clientId: number; before?: () => Promise<boolean>; primary?: boolean; label?: string
}) {
  const [order, setOrder] = useLnvOrder()
  const [rows, setRows] = useLnvRows()
  return (
    <span className="lnv-dl">
      <Dropdown className="lnv-dl-order" label="Which rows" value={rows} options={ROWS} onChange={setRows} menuWidth={320}
        shown={<>{rows === 'all' ? 'Every row' : 'Checked songs'}</>} />
      <Dropdown className="lnv-dl-order" label="Order of the rows" value={order} options={ORDERS} onChange={setOrder} menuWidth={300}
        shown={<>Order: {order === 'album' ? 'Albums A–Z' : 'Songs A–Z'}</>} />
      <FileButton className={primary ? 'primary' : ''} url={api.stage1Url(clientId, order, rows)} before={before}
        title={`${rows === 'all' ? "The client's whole LNV" : 'The songs checked in step 2'} with step 2's answers, ${order === 'album' ? 'sorted by album, then song' : 'sorted by song'} – takes a few seconds`}>{label}</FileButton>
    </span>
  )
}

/** The end of Muso vs LNV: mark it completed – its LNV goes on to LNV vs IPRS as the stage 2 LNV – or, once done, when
 *  and by whom, open it again, and the download. needs: songs with no answer yet. flush saves the answers waiting. */
export function CompleteBar({ clientId, stage1, needs, flush, complete }: {
  clientId: number; stage1: Stage1Done | null; needs: number; flush: () => Promise<boolean>
  complete: (done: boolean) => Promise<boolean>
}) {
  const [ask, setAsk] = useState<'done' | 'reopen' | null>(null)
  const [busy, setBusy] = useState(false)
  const go = async (done: boolean) => {
    setBusy(true)
    try { if (!done || await flush()) await complete(done) } finally { setBusy(false); setAsk(null) }
  }
  return (
    <div className={`lnv-bar ${stage1 ? 'done' : ''} ${stage1?.changed ? 'stale' : ''}`}>
      <span className="lnv-bar-icon" aria-hidden>{stage1 ? <CircleCheckBig size={20} /> : <Flag size={18} />}</span>
      <div className="lnv-bar-text">
        {stage1 ? <>
          <b>Muso vs LNV completed<span className="lnv-stage">Stage 1 LNV</span></b>
          <span>{fmtDate(stage1.done_at)}{stage1.by ? ` · by ${stage1.by}` : ''} – its LNV is the stage 2 LNV in LNV vs IPRS.</span>
          {stage1.changed && <span className="t-warn">Answers changed since then – complete again to put them into the stage 2 LNV.</span>}
        </> : <>
          <b>{needs ? `${n(needs)} song${needs === 1 ? '' : 's'} still need an answer` : 'Every song answered'}<span className="lnv-stage">Stage 1 LNV</span></b>
          <span>When the checks are done, mark it completed: the LNV with these answers goes on to LNV vs IPRS as the stage 2 LNV.</span>
        </>}
      </div>
      <div className="lnv-bar-acts">
        <Stage1Download clientId={clientId} before={flush} />
        {stage1 ? <>
          {stage1.changed && <Button variant="primary" disabled={busy} icon={busy ? <span className="spinner small" /> : <Check size={15} />} onClick={() => go(true)}>Complete again</Button>}
          <Link className="btn" to={`/iprs?client=${clientId}`}>LNV vs IPRS<ArrowRight size={15} /></Link>
          <Button variant="ghost" disabled={busy} icon={<RotateCcw size={14} />} onClick={() => setAsk('reopen')}>Reopen</Button>
        </> : (
          <Button variant="primary" className="lnv-complete" disabled={busy} icon={busy ? <span className="spinner small" /> : <Check size={15} />}
            onClick={() => needs ? setAsk('done') : go(true)}>{busy ? 'Completing…' : 'Mark as completed'}</Button>
        )}
      </div>
      <ConfirmDialog open={ask === 'done'} tone="primary" title="Complete Muso vs LNV?" confirmLabel="Complete anyway"
        onCancel={() => setAsk(null)} onConfirm={() => go(true)}>
        <p><b>{n(needs)}</b> song{needs === 1 ? ' has' : 's have'} no answer yet. Where the app has an answer it is used; a new song with none stays out of the LNV.</p>
        <p>The LNV with these answers becomes the stage 2 LNV, the one LNV vs IPRS checks.</p>
      </ConfirmDialog>
      <ConfirmDialog open={ask === 'reopen'} tone="primary" title="Open Muso vs LNV again?" confirmLabel="Reopen"
        onCancel={() => setAsk(null)} onConfirm={() => go(false)}>
        <p>The client goes back to step 2. The stage 2 LNV stays as it is until step 2 is completed again.</p>
      </ConfirmDialog>
    </div>
  )
}
