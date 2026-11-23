import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ChevronsUpDown, GitCompareArrows, IdCard, KeyRound, LayoutGrid, LogOut, Menu, Moon, Plus, Search, Settings, Sun, SunMoon, Users, X } from 'lucide-react'
import { CommandPalette } from './CommandPalette'
import { Kbd, LockToggle } from './ui'
import { WhatsNew } from './WhatsNew'
import { useAuth } from '../lib/auth'
import { useFlag, usePeek } from '../lib/peek'
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

/** The app's mark: three catalogues (the LNV, the Muso export, the IPRS report) merging into one checked master
 *  sheet – the same drawing as the favicon. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden>
      <defs><linearGradient id="mrm-logo-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4f46e5" /><stop offset="1" stopColor="#1e1b4b" /></linearGradient></defs>
      <rect width="32" height="32" rx="9" fill="url(#mrm-logo-bg)" />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.3">
        <path d="M5.5 9h3c3.6 0 4.6 7 8.2 7" stroke="#a5b4fc" />
        <path d="M5.5 16h11.2" stroke="#e0e7ff" />
        <path d="M5.5 23h3c3.6 0 4.6-7 8.2-7" stroke="#a5b4fc" />
      </g>
      <rect x="17.5" y="10" width="9.5" height="12" rx="2.2" fill="#fbbf24" />
      <path d="M19.9 16.2l1.7 1.7 3.1-3.4" fill="none" stroke="#1e1b4b" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Sidebar (app navigation, plus the open client's steps in `side`) and a slim top bar with the trail. The sidebar
 *  closes by itself to a slim strip of icons and opens while the pointer is on it – or is locked open. */
export function AppShell({ children, trail, side }: { children: ReactNode; trail?: ReactNode; side?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [palette, setPalette] = useState(false)
  const [news, setNews] = useState(false)   // the version was clicked: what changed
  const [open, setOpen] = useState(false)   // the sidebar on small screens
  const [locked, setLocked] = useFlag('mrm-side-lock', false)
  const peek = usePeek()
  const shut = !locked && !peek.open   // the slim strip of icons
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
    <div className={`shell2 ${open ? 'nav-open' : ''} ${locked ? '' : 'auto'} ${shut ? 'mini' : ''} ${!locked && peek.open ? 'peek' : ''}`}>
      <aside className="side" aria-label="Navigation" {...(locked ? {} : peek.handlers)}>
        <div className="side-top">
          <Link to="/" className="logo" aria-label="MRM Consolidator: go to all your clients">
            <LogoMark />
            <span className="logo-text"><strong>MRM</strong><small>Consolidator</small></span>
          </Link>
          <button type="button" className="icon-btn side-close" onClick={() => setOpen(false)} aria-label="Close menu"><X size={18} /></button>
          <LockToggle className="icon-btn side-fold" locked={locked} what="sidebar" toggle={() => { setLocked(!locked); peek.set(false) }} />
        </div>
        <button type="button" className="side-search" onClick={() => setPalette(true)} title="Search (Ctrl K)">
          <Search size={14} /><span className="lbl">Search</span><Kbd>Ctrl K</Kbd>
        </button>
        <nav className="side-nav">
          <NavLink to="/" end title="Clients"><LayoutGrid size={16} /><span className="lbl">Clients</span></NavLink>
          <NavLink to="/clients/new" title="Add client"><Plus size={16} /><span className="lbl">Add client</span></NavLink>
          {/* stage 2: the clients whose Muso vs LNV is completed, their stage 2 LNV against the IPRS report */}
          <NavLink to="/iprs" title="LNV vs IPRS"><GitCompareArrows size={16} /><span className="lbl">LNV vs IPRS</span></NavLink>
          {/* the society's member list: every name of every client looked up in it */}
          <NavLink to="/ipi" title="IPI / CAE list"><IdCard size={16} /><span className="lbl">IPI / CAE list</span></NavLink>
          <NavLink to="/settings" title="Settings"><Settings size={16} /><span className="lbl">Settings</span></NavLink>
        </nav>
        {side}
        <div className="side-foot">
          {/* the app's version, just above the signed-in user */}
          <button type="button" className="side-ver" onClick={() => setNews(true)} title="The app’s version. Click to see what changed."><span className="lbl">MRM-Consolidator</span><b>v{VERSION}</b></button>
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
        <footer className="app-footer"><b>MRM-Consolidator</b><span>Music Rights Management</span><span>·</span><button type="button" className="foot-ver" onClick={() => setNews(true)} title="The app’s version. Click to see what changed.">v{VERSION}</button></footer>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <WhatsNew open={news} onClose={() => setNews(false)} />
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
          <button type="button" role="menuitem" onClick={() => go('/settings')}><Settings size={15} />Settings</button>
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
