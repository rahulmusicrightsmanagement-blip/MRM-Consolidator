import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { api, SIGNED_OUT_EVENT } from './api'
import type { User } from '../types'

interface Auth {
  user: User | null
  /** false until the first /api/auth/me/ answer, so pages don't flash the login screen. */
  ready: boolean
  signIn: (email: string, password: string) => Promise<User>
  signOut: () => Promise<void>
  setUser: (u: User | null) => void
}

const AuthContext = createContext<Auth>(null!)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setReady(true))
    const onSignedOut = () => setUser(null)
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut)
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut)
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    const u = await api.login(email, password)
    await api.me() // Django rotates the CSRF token on login; fetch the new cookie.
    setUser(u)
    return u
  }, [])

  const signOut = useCallback(async () => {
    try { await api.logout() } finally { setUser(null); await api.me().catch(() => null) }
  }, [])

  return <AuthContext.Provider value={{ user, ready, signIn, signOut, setUser }}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)

function Loading() {
  return <div className="auth-loading"><span className="spinner" /></div>
}

/** Route wrapper: signed-in users see the page, everyone else goes to /login (and comes back after). */
export function RequireAuth() {
  const { user, ready } = useAuth()
  const location = useLocation()
  if (!ready) return <Loading />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  return <Outlet />
}

/** Route wrapper for pages only admins (and the super admin) may open. */
export function RequireAdmin() {
  const { user } = useAuth()
  if (!user?.is_admin) return <Navigate to="/" replace />
  return <Outlet />
}
