import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ChevronsUpDown, KeyRound, LayoutGrid, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Sun, SunMoon, Users, X } from 'lucide-react'
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

/** Sidebar (app navigation, plus the open client's steps in `side`) and a slim top bar with the trail. */
export function AppShell({ children, trail, side }: { children: ReactNode; trail?: ReactNode; side?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [palette, setPalette] = useState(false)
  const [open, setOpen] = useState(false)   // the sidebar on small screens
  const [mini, setMini] = useState(() => { try { return localStorage.getItem('mrm-side-mini') === '1' } catch { return false } })
  const fold = () => { setMini(!mini); try { localStorage.setItem('mrm-side-mini', mini ? '0' : '1') } catch { /* private mode */ } }
  const { pathname, search } = useLocation()

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
  useEffect(() => setOpen(false), [pathname, search])

  return (
    <div className={`shell2 ${open ? 'nav-open' : ''} ${mini ? 'mini' : ''}`}>
      <aside className="side" aria-label="Navigation">
        <div className="side-top">
          <Link to="/" className="logo">
            <span className="logo-mark" aria-hidden>
              <svg viewBox="0 0 32 32" width="16" height="16"><path d="M12 22.5a3 3 0 1 1-2-2.83V9.5l11-2.5v12.5a3 3 0 1 1-2-2.83V10.6l-7 1.6z" fill="currentColor" /></svg>
            </span>
            <span className="logo-text"><strong>MRM</strong><small>Consolidator</small></span>
          </Link>
          <button type="button" className="icon-btn side-close" onClick={() => setOpen(false)} aria-label="Close menu"><X size={18} /></button>
          <button type="button" className="icon-btn side-fold" onClick={fold} title={mini ? 'Expand the sidebar' : 'Collapse the sidebar'} aria-label={mini ? 'Expand the sidebar' : 'Collapse the sidebar'}>
            {mini ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
        </div>
        <button type="button" className="side-search" onClick={() => setPalette(true)} title="Search (Ctrl K)">
          <Search size={14} /><span className="lbl">Search</span><Kbd>Ctrl K</Kbd>
        </button>
        <nav className="side-nav">
          <NavLink to="/" end title="Clients"><LayoutGrid size={16} /><span className="lbl">Clients</span></NavLink>
          <NavLink to="/clients/new" title="Add client"><Plus size={16} /><span className="lbl">Add client</span></NavLink>
        </nav>
        {side}
        <div className="side-foot">
          <UserMenu theme={theme} onTheme={() => setTheme(NEXT[theme])} />
        </div>
      </aside>
      <div className="side-scrim" onClick={() => setOpen(false)} aria-hidden />

      <div className="main2">
        <header className="topbar2">
          <button type="button" className="icon-btn side-open" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={18} /></button>
          <nav className="crumbs2" aria-label="Breadcrumb">
            <Link to="/">Clients</Link>
            {trail && <><span className="sep">/</span><span className="current">{trail}</span></>}
          </nav>
        </header>
        <main className="page">{children}</main>
        <footer className="app-footer"><b>MRM-Consolidator</b><span>Music Rights Management</span><span>·</span><span>v{VERSION}</span></footer>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  )
}

/** The signed-in user at the foot of the sidebar: account, Users (admins), theme and Sign out. */
function UserMenu({ theme, onTheme }: { theme: Theme; onTheme: () => void }) {
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
      <button type="button" className="user-row" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="avatar">{label.slice(0, 1).toUpperCase()}</span>
        <span className="user-row-text"><b>{label}</b><small>{user.is_super_admin ? 'Super admin' : user.is_admin ? 'Admin' : 'Member'}</small></span>
        <ChevronsUpDown size={14} className="muted" />
      </button>
      {open && (
        <div className="user-pop" role="menu">
          <div className="user-pop-head"><b>{label}</b>{user.name && <span className="muted small">{user.email}</span>}</div>
          {user.is_admin && <button type="button" role="menuitem" onClick={() => go('/users')}><Users size={15} />Users</button>}
          <button type="button" role="menuitem" onClick={() => go('/account')}><KeyRound size={15} />Change password</button>
          <button type="button" role="menuitem" onClick={onTheme}>
            {theme === 'light' ? <Sun size={15} /> : theme === 'dark' ? <Moon size={15} /> : <SunMoon size={15} />}
            Theme: {theme === 'system' ? 'automatic' : theme}</button>
          <button type="button" role="menuitem" onClick={async () => { setOpen(false); await signOut(); navigate('/login') }}><LogOut size={15} />Sign out</button>
        </div>
      )}
    </div>
  )
}
