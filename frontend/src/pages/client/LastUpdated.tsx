import { useState } from 'react'
import { ArrowRight, ChevronDown, ChevronUp, Clock } from 'lucide-react'
import type { LastUpdate } from '../../types'
import { whenText } from './when'

/** The song that was changed last – its name, when, by whom, what – with the way back to it; the ones before it fold
 *  out. The reviewer goes on from where the work stopped, whoever did it. */
export function LastUpdated({ last, open, has, nameOf }: {
  last: LastUpdate[]; open: (key: string) => void; has: (key: string) => boolean
  /** a song's name as the lists have it now */
  nameOf: (key: string) => string | undefined
}) {
  const [more, setMore] = useState(false)
  const now = last[0]
  if (!now) return (
    <div className="lu empty" aria-label="Last updated song"><Clock size={15} /><span className="muted">Last updated song: none yet – the first answer you save shows here.</span></div>
  )
  const line = (x: LastUpdate, first: boolean) => (
    <div key={x.key} className={`lu-line ${first ? 'first' : ''}`}>
      <b className="lu-title" title={nameOf(x.key) ?? x.title}>{nameOf(x.key) || x.title || 'A song'}</b>
      <span className="lu-when" title={whenText(x.at, true)}>{whenText(x.at)}</span>
      {x.by && <span className="muted lu-by">by {x.by}</span>}
      {x.what && <span className="muted lu-what" title={x.what}>{x.what}</span>}
      <span className="grow" />
      {has(x.key) ? <button type="button" className="btn sm" onClick={() => open(x.key)} title="Open this song and go on from there">{first ? 'Continue from here' : 'Open'}<ArrowRight size={13} /></button>
        : <span className="muted lu-gone">no longer in a list</span>}
    </div>
  )
  return (
    <section className="lu" aria-label="Last updated song">
      <div className="lu-head"><Clock size={15} /><span className="lu-label">Last updated song</span>{line(now, true)}
        {last.length > 1 && <button type="button" className="rv-text-btn lu-more" onClick={() => setMore(!more)} aria-expanded={more}>{more ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{more ? 'Less' : `${last.length - 1} before`}</button>}</div>
      {more && <div className="lu-list">{last.slice(1).map((x) => line(x, false))}</div>}
    </section>
  )
}
