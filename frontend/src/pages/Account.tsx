import { useState } from 'react'
import type { FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, Card, PageHeader } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'

/** The signed-in user's own account: who they are and a password change. */
export default function Account() {
  const { user } = useAuth()
  const toast = useToast()
  const [form, setForm] = useState({ current: '', next: '', again: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (form.next !== form.again) { setError('The new passwords do not match.'); return }
    setError(null); setBusy(true)
    try {
      await api.changePassword(form.current, form.next)
      toast('Password changed', 'good')
      setForm({ current: '', next: '', again: '' })
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <AppShell trail={<span className="trail-name">My account</span>}>
      <PageHeader eyebrow="Account" title={user?.name || user?.email} description={user?.name ? user.email : undefined} />
      <Card title="Change password" className="narrow">
        <form onSubmit={submit}>
          <div className="form-grid">
            <label>Current password<input type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} /></label>
            <label>New password<input type="password" autoComplete="new-password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} /></label>
            <label>New password again<input type="password" autoComplete="new-password" value={form.again} onChange={(e) => setForm({ ...form, again: e.target.value })} /></label>
          </div>
          {error && <div className="alert bad small">{error}</div>}
          <div className="wizard-actions">
            <Button type="submit" variant="primary" icon={<KeyRound size={15} />} disabled={busy || !form.current || !form.next}>Change password</Button>
          </div>
        </form>
      </Card>
    </AppShell>
  )
}
