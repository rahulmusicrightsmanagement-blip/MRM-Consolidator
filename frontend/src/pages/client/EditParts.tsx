import { createContext, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Pencil, Undo2, X } from 'lucide-react'
import type { CaseRecord } from '../../types'
import { isEdited, labelOf, rawOf, typedText, typedValue } from './editModel'
import { list } from './Block'

/** Editing in place, shared by the review screens: the box to type a value, the pencil beside a value, and the DSP's
 *  (Muso's) own values – corrected where they are shown. */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The box to type a value in place: ready to type (the cursor after the text), with ✓ to keep it and ✕ to drop it –
 *  or Enter / leaving the box, and Esc. done(null): nothing changed. check: why a text cannot be kept (the box stays). */
export function EditBox({ initial, label, placeholder, done, check }: {
  initial: string; label: string; placeholder: string; done: (text: string | null) => void; check?: (text: string) => string | undefined
}) {
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | undefined>()
  const over = useRef(false)   // a click on ✓ or ✕ is on its way: leaving the box is not "keep"
  const keep = () => {
    const t = text.trim()
    const wrong = t !== initial.trim() && t ? check?.(t) : undefined
    if (wrong) setError(wrong)
    else done(t)
  }
  return (
    <div className="fe-edit-wrap">
      <div className="fe-edit">
        <input autoFocus className={`fc-in ${error ? 'wrong' : ''}`} value={text} onChange={(e) => { setText(e.target.value); setError(undefined) }} aria-label={label} placeholder={placeholder} aria-invalid={!!error}
          onFocus={(e) => { const end = e.currentTarget.value.length; e.currentTarget.setSelectionRange(end, end) }}
          onBlur={() => { if (!over.current) keep() }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); keep() } if (e.key === 'Escape') { e.preventDefault(); done(null) } }} />
        <button type="button" className="fe-btn ok" title="Keep (Enter)" aria-label="Keep"
          onPointerDown={() => { over.current = true }} onClick={() => { over.current = false; keep() }}><Check size={15} /></button>
        <button type="button" className="fe-btn" title="Cancel (Esc)" aria-label="Cancel"
          onPointerDown={() => { over.current = true }} onClick={() => { over.current = false; done(null) }}><X size={15} /></button>
      </div>
      {error && <small className="fe-error" role="alert">{error}</small>}
    </div>
  )
}

const PLACEHOLDER: Record<string, string> = {
  Lyricist: 'Names, comma between them', Composer: 'Names, comma between them', Singer: 'Names, comma between them', Publisher: 'Names, comma between them',
  Year: 'e.g. 2015', 'Release date': 'DD-MM-YYYY', ISRC: 'ISRC1 | ISRC2', Link: 'https://…',
}

/** A field's value typed: names split at their commas, several ISRCs at their pipes. done(null) when nothing changed. */
export function TypeIn({ fl, initial, now, done, where = 'the LNV' }: { fl: string; initial: string; now: string[]; done: (v: string[] | null) => void; where?: string }) {
  return (
    <EditBox initial={initial} label={`${labelOf(fl)} for ${where}`} check={(t) => typedValue(fl, t).error}
      placeholder={PLACEHOLDER[fl] ?? `Type the ${labelOf(fl).toLowerCase()} for ${where}`}
      done={(t) => {
        if (t == null) return done(null)
        const { v, error } = typedValue(fl, t)
        done(!error && v.length && !same(v, now) ? v : null)
      }} />
  )
}

/** A value as it goes into the LNV, and its pencil – always at the same place, the top right; only the pencil opens
 *  the box to type it. */
export function EditLine({ label, edit, children, what = 'type the value the LNV keeps' }: { label: string; edit: () => void; children: ReactNode; what?: string }) {
  return (
    <div className="fe">
      <span className="fe-text">{children}</span>
      <button type="button" className="fe-btn pen" onClick={edit} title={`Edit the ${label} – ${what}`} aria-label={`Edit the ${label}`}><Pencil size={14} /></button>
    </div>
  )
}

/* ---------- the DSP's (Muso's) data, corrected ---------- */

/** How a correction is saved (null: taken back – the sheet's own value again). Absent: the data is only shown. */
export type MusoEditing = { source: string; save: (r: CaseRecord, f: string, v: string[] | null) => void; busy?: boolean }
export const MusoContext = createContext<MusoEditing | null>(null)

/** One field of a DSP recording, with its pencil: the value is corrected right here – what goes into the LNV from it
 *  changes with it, the sheet's own value stays written under it and can be brought back. */
export function MusoField({ r, f, children, compact }: { r: CaseRecord; f: string; children: ReactNode; compact?: boolean }) {
  const ctx = useContext(MusoContext)
  const [typing, setTyping] = useState(false)
  const edited = isEdited(r, f)
  if (!ctx || r.id == null || r.src === 'LNV') return <>{children}</>
  const now = list(r.fields[f])
  if (typing) return (
    <TypeIn fl={f} initial={typedText(f, now)} now={now} where={ctx.source} done={(v) => { setTyping(false); if (v) ctx.save(r, f, v) }} />
  )
  return (
    <div className={`mf ${compact ? 'compact' : ''} ${edited ? 'edited' : ''}`}>
      <EditLine label={`${ctx.source} ${labelOf(f).toLowerCase()}`} what={`correct the ${ctx.source} data`} edit={() => setTyping(true)}>{children}</EditLine>
      {edited && (
        <small className="mf-was">Edited – {ctx.source} file: {rawOf(r, f).join(', ') || 'blank'}
          <button type="button" className="rv-text-btn" disabled={ctx.busy} onClick={() => ctx.save(r, f, null)} title={`Back to the value in the ${ctx.source} file`}><Undo2 size={12} />Put back</button></small>
      )}
    </div>
  )
}
