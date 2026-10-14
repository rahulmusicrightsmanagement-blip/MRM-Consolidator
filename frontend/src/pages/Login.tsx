import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Eye, EyeOff, LogIn } from 'lucide-react'
import { useAuth } from '../lib/auth'
import versionFile from '../../../VERSION?raw'

/** Email + password sign-in. New accounts are created by the super admin, so there is no sign-up. */
export default function Login() {
  const { user, ready, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from || '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (ready && user) return <Navigate to={from} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null); setBusy(true)
    try {
      await signIn(email.trim(), password)
      navigate(from, { replace: true })
    } catch (err) {
      setError((err as Error).message)
      setPassword('')
    } finally { setBusy(false) }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit} noValidate>
        <div className="login-brand">
          <span className="logo-mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="20" height="20"><path d="M12 22.5a3 3 0 1 1-2-2.83V9.5l11-2.5v12.5a3 3 0 1 1-2-2.83V10.6l-7 1.6z" fill="currentColor" /></svg>
          </span>
          <div><strong>MRM</strong> <span className="logo-sub">Consolidator</span></div>
        </div>
        <div>
          <h1>Sign in</h1>
          <p className="muted small">Use the email and password your admin gave you.</p>
        </div>
        <label>Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        <label>Password
          <span className="password-field">
            <input type={show ? 'text' : 'password'} autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} required />
            <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </span>
        </label>
        {error && <div className="alert bad small" role="alert">{error}</div>}
        <button type="submit" className="btn primary block" disabled={busy || !email.trim() || !password}>
          {busy ? <span className="spinner small" /> : <LogIn size={15} />}Sign in
        </button>
        <p className="muted small login-help">Forgot your password? Ask the super admin to reset it.</p>
      </form>
      <footer className="login-footer">MRM-Consolidator · v{versionFile.trim()}</footer>
    </div>
  )
}
