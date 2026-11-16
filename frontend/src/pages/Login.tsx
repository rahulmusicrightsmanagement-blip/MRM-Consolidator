import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { CloudUpload, Eye, EyeOff, GitCompareArrows, ListChecks, Lock, LogIn, Mail } from 'lucide-react'
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
  const [caps, setCaps] = useState(false)

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

  const logo = (
    <span className="logo-mark" aria-hidden>
      <svg viewBox="0 0 32 32" width="20" height="20"><path d="M12 22.5a3 3 0 1 1-2-2.83V9.5l11-2.5v12.5a3 3 0 1 1-2-2.83V10.6l-7 1.6z" fill="currentColor" /></svg>
    </span>
  )

  return (
    <div className="login-page">
      <aside className="login-hero" aria-hidden>
        <div className="login-brand light">{logo}<div><strong>MRM</strong> <span className="logo-sub">Consolidator</span></div></div>
        <div className="login-pitch">
          <h2>Every catalogue,<br />reconciled.</h2>
          <p>Match each client's master against what IPRS and PRS have registered, and see exactly what to amend or register next.</p>
          <ul>
            <li><GitCompareArrows size={16} />Master compared with every society report</li>
            <li><ListChecks size={16} />Clear list of works to amend and register</li>
            <li><CloudUpload size={16} />Uploaded files kept safe in Google Drive</li>
          </ul>
        </div>
        <div className="login-sample">
          {[['IPRS', 96, 'Done'], ['PRS', 80, 'Step 2/4']].map(([code, p, st]) => (
            <div key={code} className="login-sample-row">
              <span className="soc-code">{code}</span>
              <span className="login-sample-bar"><i style={{ width: `${p}%` }} /></span>
              <b>{p}%</b><em>{st}</em>
            </div>
          ))}
        </div>
      </aside>

      <main className="login-main">
        <form className="login-card" onSubmit={submit} noValidate>
          <div className="login-brand mobile-only">{logo}<div><strong>MRM</strong> <span className="logo-sub">Consolidator</span></div></div>
          <div>
            <h1>Welcome back</h1>
            <p className="muted">Sign in with the email and password your admin gave you.</p>
          </div>
          <label>Email
            <span className="login-field"><Mail size={16} />
              <input type="email" autoComplete="username" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
            </span>
          </label>
          <label>Password
            <span className="login-field password-field"><Lock size={16} />
              <input type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="••••••••" value={password}
                onChange={(e) => setPassword(e.target.value)} onKeyUp={(e) => setCaps(e.getModifierState('CapsLock'))} required />
              <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
            {caps && <span className="caps-hint">Caps Lock is on</span>}
          </label>
          {error && <div className="alert bad small" role="alert">{error}</div>}
          <button type="submit" className="btn primary block login-submit" disabled={busy || !email.trim() || !password}>
            {busy ? <span className="spinner small" /> : <LogIn size={16} />}{busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="muted small login-help">Forgot your password? Ask the super admin to reset it.</p>
        </form>
        <footer className="login-footer">MRM-Consolidator · v{versionFile.trim()}</footer>
      </main>
    </div>
  )
}
