import { useEffect, useRef, useState } from 'react'
import type { FocusEvent } from 'react'

/** A panel that closes by itself: it opens while the pointer is on it (or focus is in it) and closes a moment after
 *  the pointer leaves. Used by the sidebar and the song list when they are not locked open. */
export function usePeek(openDelay = 90, closeDelay = 320) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const clear = () => { if (timer.current !== undefined) { window.clearTimeout(timer.current); timer.current = undefined } }
  const later = (v: boolean, ms: number) => { clear(); timer.current = window.setTimeout(() => setOpen(v), ms) }
  useEffect(() => clear, [])
  return {
    open,
    set: (v: boolean) => { clear(); setOpen(v) },
    toggle: () => { clear(); setOpen((o) => !o) },
    handlers: {
      onMouseEnter: () => later(true, openDelay),
      onMouseLeave: () => later(false, closeDelay),
      onFocus: () => { clear(); setOpen(true) },
      onBlur: (e: FocusEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) later(false, closeDelay) },
    },
  }
}

/** A yes/no kept in the browser (a panel locked open …). */
export function useFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { const x = localStorage.getItem(key); return x == null ? initial : x === '1' } catch { return initial } })
  return [v, (x: boolean) => { setV(x); try { localStorage.setItem(key, x ? '1' : '0') } catch { /* private mode */ } }]
}
