import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { KeyRound, Shield, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Badge, Button, Card, ConfirmDialog, PageHeader } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { fmtDate } from '../lib/client'
import { useToast } from '../lib/toast'
import type { Role, User } from '../types'

const EMPTY: { email: string; name: string; password: string; role: Role } = { email: '', name: '', password: '', role: 'member' }

/** Admins: add team members, reset their passwords, disable or remove them. Only the super admin manages admins. */
export default function Users() {
  const toast = useToast()
  const { user: me } = useAuth()
  const isSuper = !!me?.is_super_admin
  // The super admin manages everyone else; an admin manages members only.
  const canManage = (u: User) => u.id !== me?.id && !u.is_super_admin && (isSuper || u.role === 'member')
  const [users, setUsers] = useState<User[] | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resetting, setResetting] = useState<User | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [resetError, setResetError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<User | null>(null)

  const load = () => api.users().then(setUsers).catch((e) => toast((e as Error).message, 'bad'))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  const add = async (e: FormEvent) => {
    e.preventDefault()
    setError(null); setBusy(true)
    try {
      const u = await api.createUser({ ...form, email: form.email.trim() })
      toast(`${u.email} can now sign in`, 'good')
      setForm(EMPTY)
      load()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  const toggle = async (u: User) => {
    try {
      await api.updateUser(u.id, { is_active: !u.is_active })
      toast(u.is_active ? `${u.email} disabled` : `${u.email} enabled`, 'good')
      load()
    } catch (err) { toast((err as Error).message, 'bad') }
  }

  const setRole = async (u: User, role: Role) => {
    try {
      await api.updateUser(u.id, { role })
      toast(role === 'admin' ? `${u.email} is now an admin` : `${u.email} is now a member`, 'good')
      load()
    } catch (err) { toast((err as Error).message, 'bad') }
  }

  const reset = async (e: FormEvent) => {
    e.preventDefault()
    setResetError(null)
    try {
      await api.updateUser(resetting!.id, { password: newPassword })
      toast(`New password set for ${resetting!.email}`, 'good')
      setResetting(null); setNewPassword('')
    } catch (err) { setResetError((err as Error).message) }
  }

  return (
    <AppShell trail={<span className="trail-name">Users</span>}>
      <PageHeader eyebrow={isSuper ? 'Super admin' : 'Admin'} title="Users"
        description={isSuper
          ? 'Add people and choose who is an admin. Admins can add and manage members too. Give each new user their email and password; they can change the password from their account menu.'
          : 'Add team members. Give each new user their email and password; they can change the password from their account menu. Only the super admin can manage admins.'} />

      <Card title="Add a user" description="At least 8 characters, not only numbers, and not a very common password.">
        <form onSubmit={add}>
          <div className="form-grid">
            <label>Email *<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" autoComplete="off" /></label>
            <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Priya" autoComplete="off" /></label>
            <label>Password *<input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></label>
            {isSuper && <label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="member">Member</option><option value="admin">Admin – can add people</option>
            </select></label>}
          </div>
          {error && <div className="alert bad small">{error}</div>}
          <div className="wizard-actions">
            <Button type="submit" variant="primary" icon={<UserPlus size={15} />} disabled={busy || !form.email.trim() || !form.password}>Add user</Button>
          </div>
        </form>
      </Card>

      <Card title="Everyone who can sign in" flush>
        <div className="table-wrap users-table">
          <table className="data">
            <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Added</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {users === null && <tr><td colSpan={6} className="muted">Loading…</td></tr>}
              {users?.map((u) => (
                <tr key={u.id} className={u.is_active ? '' : 'muted'}>
                  <td><b>{u.name || u.email}</b>{u.name && <div className="muted small">{u.email}</div>}</td>
                  <td>{u.is_super_admin
                    ? <Badge tone="info" icon={false}><ShieldCheck size={13} /> Super admin</Badge>
                    : isSuper
                      ? <select value={u.role} onChange={(e) => setRole(u, e.target.value as Role)} aria-label={`Role of ${u.email}`}>
                          <option value="member">Member</option><option value="admin">Admin</option>
                        </select>
                      : u.role === 'admin' ? <Badge tone="info" icon={false}><Shield size={13} /> Admin</Badge> : <span className="muted">Member</span>}</td>
                  <td><Badge tone={u.is_active ? 'good' : 'neutral'}>{u.is_active ? 'Active' : 'Disabled'}</Badge></td>
                  <td>{u.last_login ? fmtDate(u.last_login) : <span className="muted">never</span>}</td>
                  <td>{fmtDate(u.date_joined)}</td>
                  <td className="users-actions">
                    {canManage(u) && <>
                      <Button size="sm" icon={<KeyRound size={14} />} onClick={() => { setResetting(u); setNewPassword(''); setResetError(null) }}>Reset password</Button>
                      <Button size="sm" onClick={() => toggle(u)}>{u.is_active ? 'Disable' : 'Enable'}</Button>
                      <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => setRemoving(u)} aria-label={`Remove ${u.email}`} />
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {resetting && (
        <div className="modal-backdrop" onClick={() => setResetting(null)}>
          <form className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onSubmit={reset}>
            <h2>New password for {resetting.name || resetting.email}</h2>
            <div className="modal-body form-grid">
              <label>New password<input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus autoComplete="new-password" /></label>
              <span className="small">They are signed out everywhere and must use this password next time.</span>
            </div>
            {resetError && <div className="alert bad small">{resetError}</div>}
            <div className="modal-actions">
              <Button variant="ghost" onClick={() => setResetting(null)}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!newPassword}>Set password</Button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog open={!!removing} title={`Remove ${removing?.email}?`} confirmLabel="Remove user"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          try {
            await api.deleteUser(removing!.id)
            toast(`${removing!.email} removed`, 'good')
            setRemoving(null)
            load()
          } catch (err) { toast((err as Error).message, 'bad') }
        }}>
        <p>They will no longer be able to sign in. Clients and reports they worked on are kept. To block them only for now, use Disable instead.</p>
      </ConfirmDialog>
    </AppShell>
  )
}
