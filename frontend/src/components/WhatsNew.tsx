import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react'
import changelog from '../../../CHANGELOG.md?raw'
import versionFile from '../../../VERSION?raw'
import { markSeen, releases, unseen } from '../lib/whatsNew'

const VERSION = versionFile.trim()
const ALL = releases(changelog)
const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

/** What changed in the app: opens by itself once per version, and from the version number any time – this version's
 *  points first, the earlier versions' below. */
export function WhatsNew({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [first, setFirst] = useState(() => unseen(VERSION))
  const [earlier, setEarlier] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const shown = open || first
  const close = () => { markSeen(VERSION); setFirst(false); setEarlier(false); onClose() }
  const closeRef = useRef(close)
  closeRef.current = close
  // opened from the version number: the earlier versions are asked for too
  useEffect(() => { if (open) setEarlier(true) }, [open])
  useEffect(() => {
    if (!shown) return
    markSeen(VERSION)   // once: a reload does not bring it back
    btn.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown])
  if (!shown) return null
  const now = ALL.find((r) => r.version === VERSION)
  const before = ALL.filter((r) => r.version !== VERSION)
  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal wn" role="dialog" aria-modal="true" aria-label="What’s new" onClick={(e) => e.stopPropagation()}>
        <header><span className="wn-icon"><Sparkles size={18} /></span><div className="grow"><h2>What’s new</h2><p>Version {VERSION}{now ? ` · ${day(now.date)}` : ''}</p></div>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close"><X size={18} /></button></header>
        <div className="wn-body">
          <ul className="wn-now">{(now?.points ?? ['Small improvements.']).map((t) => <li key={t}>{t}</li>)}</ul>
          <button type="button" className="rv-text-btn wn-more" onClick={() => setEarlier(!earlier)} aria-expanded={earlier}>{earlier ? <ChevronUp size={14} /> : <ChevronDown size={14} />}Earlier changes</button>
          {earlier && before.map((r) => (
            <section key={r.version} className="wn-old"><h3>Version {r.version}<small>{day(r.date)}</small></h3><ul>{r.points.map((t) => <li key={t}>{t}</li>)}</ul></section>))}
        </div>
        <div className="modal-actions"><button ref={btn} type="button" className="btn primary" onClick={close}>Got it</button></div>
      </div>
    </div>, document.body)
}
