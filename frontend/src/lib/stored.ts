import { useState } from 'react'

/** A yes/no the viewer chose before (folded parts, the slim sidebar), kept in this browser. */
export function useStored(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => { try { const x = localStorage.getItem(key); return x == null ? initial : x === '1' } catch { return initial } })
  return [v, (x: boolean) => { setV(x); try { localStorage.setItem(key, x ? '1' : '0') } catch { /* private mode */ } }]
}
