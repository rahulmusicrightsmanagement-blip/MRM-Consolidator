import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CornerDownLeft, FileText, Music2, Search, User } from 'lucide-react'
import { api } from '../lib/api'
import { useOptionalClient } from '../lib/client'
import type { ClientRow } from '../types'

interface Item { id: string; label: string; hint: string; kind: 'page' | 'work' | 'client'; go: () => void }

/** Ctrl+K: jump to a client, a section, or any work by title, MRM ID, ISWC or tune code. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [clients, setClients] = useState<ClientRow[]>([])
  const navigate = useNavigate()
  const client = useOptionalClient()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery(''); setIndex(0)
    setTimeout(() => input.current?.focus(), 0)
    api.clients().then((d) => setClients(d.clients)).catch(() => {})
  }, [open])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [{ id: 'home', label: 'Client tracker', hint: 'all clients', kind: 'page', go: () => navigate('/') },
      { id: 'new', label: 'Add client', hint: '', kind: 'page', go: () => navigate('/clients/new') },
      { id: 'iprs', label: 'LNV vs IPRS', hint: 'clients with Muso vs LNV completed', kind: 'page', go: () => navigate('/iprs') }]
    if (client) {
      const base = `/clients/${client.clientId}`
      const sections: [string, string][] = [['', 'Client home'], ...(client.detail?.societies ?? []).map((s) => [`/societies/${s.code}`, `${s.code} workspace`] as [string, string])]
      for (const [path, label] of sections) {
        out.push({ id: 'p' + path, label, hint: client.detail?.client.name ?? '', kind: 'page', go: () => navigate(base + path) })
      }
      for (const w of client.works ?? []) {
        out.push({ id: 'w' + w.id, label: w.title, kind: 'work', go: () => navigate(`${base}/works/${w.id}`),
          hint: [w.mrm_id, ...(w.identifiers.IPRS ?? []), ...(w.identifiers.PRS ?? []), ...(w.identifiers.ISWC ?? [])].join(' · ') })
      }
    }
    for (const c of clients) out.push({ id: 'c' + c.id, label: c.name, hint: `client · ${c.works} works`, kind: 'client', go: () => navigate(`/clients/${c.id}`) })
    const q = query.trim().toLowerCase()
    if (!q) return out.slice(0, 12)
    return out.filter((i) => `${i.label} ${i.hint}`.toLowerCase().includes(q)).slice(0, 30)
  }, [query, client, clients, navigate])

  if (!open) return null
  const choose = (i: Item) => { onClose(); i.go() }
  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search" onClick={(e) => e.stopPropagation()}>
        <label className="palette-input">
          <Search size={18} />
          <input ref={input} value={query} placeholder={client ? 'Search works, MRM ID, ISWC, tune code, clients…' : 'Search clients…'}
            onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, items.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
              if (e.key === 'Enter' && items[index]) choose(items[index])
            }} />
        </label>
        <ul className="palette-list" role="listbox">
          {items.length === 0 && <li className="palette-empty">No results</li>}
          {items.map((i, n) => (
            <li key={i.id} role="option" aria-selected={n === index} className={n === index ? 'active' : ''} onMouseEnter={() => setIndex(n)} onClick={() => choose(i)}>
              {i.kind === 'work' ? <Music2 size={15} /> : i.kind === 'client' ? <User size={15} /> : <FileText size={15} />}
              <span className="palette-label">{i.label}</span>
              <span className="palette-hint">{i.hint}</span>
              {n === index && <CornerDownLeft size={14} className="muted" />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
