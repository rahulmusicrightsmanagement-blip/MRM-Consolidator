import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hintFor } from '../lib/hints'

/** The small explanation shown once the pointer has rested on a button, a mark or a label for five seconds – two lines
 *  at most. The browser's own tooltip of that thing waits too: it would come sooner and say more. */
const DELAY = 5000
const ACTIVE = 'button, a, input, select, textarea, summary, label, [role=tab], [role=option], [role=radio], [data-hint]'
const INFO = `.cv-checks span, .cv-level, .rvc-marks span, .keep-chip, .li-n, .rv-verdict, .cv-badge, .cv-tag, .cv-from, .fam-count, .fam-legend span, .rv-done-name,
  dt, th, legend, h4, h5, .badge, .stat, .mp-match, .ipi-name, .ipi-flag, .ipi-was, .ipi-is, .fx-other, .fx-fill, .fx-fill-note, .fx-hint, .gr-same, .gr-more, td.fx-dm,
  .ls-sub i, .ls-opt, .lnv-stage, .rv-land, .as-req, .as-opt, .as-joined, .as-checked, .un-done, .un-with, .sv, .rv-by, .rv-recheck, .s2-stage, .s2-file, .pc-opt small, .pc-warn, .sc-file, .side-ver`

function explain(from: Element | null): { el: Element; text: string } | null {
  let el = from instanceof Element ? from.closest(`${ACTIVE}, ${INFO}`) : null
  for (let i = 0; el && i < 5; i += 1) {
    const own = el.getAttribute('data-hint')
    const text = own ?? hintFor({
      text: el.matches('input, select, textarea') ? '' : (el as HTMLElement).innerText ?? '', label: el.getAttribute('aria-label') ?? undefined,
      title: el.getAttribute('title') ?? el.getAttribute('data-title') ?? undefined, placeholder: el.getAttribute('placeholder') ?? undefined,
      bad: el.classList.contains('bad'), tag: el.tagName, cls: el.getAttribute('class') ?? '',
    })
    if (text) return { el, text }
    el = el.parentElement?.closest(`${ACTIVE}, ${INFO}`) ?? null
  }
  return null
}

export function HintLayer() {
  const [pop, setPop] = useState<{ text: string; x: number; y: number; up: boolean } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let over: Element | null = null, timer = 0
    let titled: [Element, string][] = []
    const clear = () => {
      window.clearTimeout(timer)
      titled.forEach(([el, t]) => { el.removeAttribute('data-title'); if (!el.hasAttribute('title')) el.setAttribute('title', t) })
      titled = []
      over = null
      setPop(null)
    }
    const enter = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const found = explain(e.target as Element)
      if (found && found.el === over) return
      clear()
      if (!found) return
      over = found.el
      for (let el: Element | null = e.target as Element; el && el !== document.body; el = el.parentElement) {
        const t = el.getAttribute('title')
        if (t) { titled.push([el, t]); el.setAttribute('data-title', t); el.removeAttribute('title') }
      }
      timer = window.setTimeout(() => {
        if (!found.el.isConnected) return
        const r = found.el.getBoundingClientRect()
        const up = r.bottom + 70 > window.innerHeight
        setPop({ text: found.text, x: Math.max(8, Math.min(r.left + Math.min(r.width, 320) / 2 - 170, window.innerWidth - 348)), y: up ? r.top - 8 : r.bottom + 8, up })
      }, DELAY)
    }
    const leave = (e: PointerEvent) => { if (!e.relatedTarget) clear() }
    document.addEventListener('pointerover', enter)
    document.addEventListener('pointerout', leave)
    for (const t of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(t, clear, { capture: true, passive: true })
    window.addEventListener('scroll', clear, true)
    return () => {
      clear()
      document.removeEventListener('pointerover', enter)
      document.removeEventListener('pointerout', leave)
      for (const t of ['pointerdown', 'keydown', 'wheel'] as const) document.removeEventListener(t, clear, { capture: true })
      window.removeEventListener('scroll', clear, true)
    }
  }, [])
  if (!pop) return null
  return createPortal(
    <div ref={box} className={`hint ${pop.up ? 'up' : ''}`} role="tooltip" style={{ left: pop.x, top: pop.y }}><span>{pop.text}</span></div>, document.body)
}
