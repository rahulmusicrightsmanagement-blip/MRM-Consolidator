import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronRight, KeyRound, LogOut, Moon, Plus, Search, Sun, SunMoon, Users } from 'lucide-react'
import { CommandPalette } from './CommandPalette'
import { Kbd } from './ui'
import { useAuth } from '../lib/auth'
import versionFile from '../../../VERSION?raw'

const VERSION = versionFile.trim()

type Theme = 'light' | 'dark' | 'system'
const NEXT: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' }

function readTheme(): Theme {
  try {
    return (localStorage.getItem('mrm-theme') as Theme) || 'system'
  } catch {
    return 'system'
  }
}

/** One top bar, no sidebar: Home › current reconciliation, search, theme and "New". */
export function AppShell({ children, trail }: { children: ReactNode; trail?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [palette, setPalette] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    try { localStorage.setItem('mrm-theme', theme) } catch { /* private mode */ }
  }, [theme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <header className="appbar">
        <Link to="/" className="logo">
          <span className="logo-mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="17" height="17"><path d="M12 22.5a3 3 0 1 1-2-2.83V9.5l11-2.5v12.5a3 3 0 1 1-2-2.83V10.6l-7 1.6z" fill="currentColor" /></svg>
          </span>
          <strong>MRM</strong><span className="logo-sub">Consolidator</span>
        </Link>
        {trail && <><ChevronRight size={16} className="muted trail-sep" /><div className="trail">{trail}</div></>}
        <div className="appbar-right">
          <button type="button" className="search-trigger" onClick={() => setPalette(true)} aria-label="Search">
            <Search size={15} /><span>Search…</span><Kbd>Ctrl K</Kbd>
          </button>
          <button type="button" className="icon-btn" onClick={() => setTheme(NEXT[theme])} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}>
            {theme === 'light' ? <Sun size={18} /> : theme === 'dark' ? <Moon size={18} /> : <SunMoon size={18} />}
          </button>
          <button type="button" className="btn primary" onClick={() => navigate('/clients/new')}><Plus size={15} /><span className="hide-sm">Add client</span></button>
          <UserMenu />
        </div>
      </header>
      <main className="page">{children}</main>
      <footer className="app-footer"><b>MRM-Consolidator</b><span>Music Rights Management</span><span>·</span><span>v{VERSION}</span></footer>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  )
}

/** Avatar button with the signed-in user, their account, Users (super admin only) and Sign out. */
function UserMenu() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  if (!user) return null
  const label = user.name || user.email
  const go = (to: string) => { setOpen(false); navigate(to) }
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="avatar" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={label}>
        {label.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="user-pop" role="menu">
          <div className="user-pop-head"><b>{label}</b>{user.name && <span className="muted small">{user.email}</span>}
            {user.is_super_admin && <span className="muted small">Super admin</span>}</div>
          {user.is_super_admin && <button type="button" role="menuitem" onClick={() => go('/users')}><Users size={15} />Users</button>}
          <button type="button" role="menuitem" onClick={() => go('/account')}><KeyRound size={15} />Change password</button>
          <button type="button" role="menuitem" onClick={async () => { setOpen(false); await signOut(); navigate('/login') }}><LogOut size={15} />Sign out</button>
        </div>
      )}
    </div>
  )
}
