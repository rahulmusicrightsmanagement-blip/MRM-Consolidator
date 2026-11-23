import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowDown, ArrowUp, Check, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { AppShell } from '../components/AppShell'
import { Button, Card, PageHeader } from '../components/ui'
import { api } from '../lib/api'
import { fmtDate } from '../lib/client'
import { useToast } from '../lib/toast'
import type { RemarkT } from '../types'

/** Settings, shared by every user: the Remark dropdown's list – why a song that is not in the LNV is mapped. A name
 *  edited here is the name everywhere, the LNV's Remark column too. */
export default function Settings() {
  const toast = useToast()
  const [rows, setRows] = useState<RemarkT[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [add, setAdd] = useState({ name: '', help: '' })
  const [edit, setEdit] = useState<{ id: number; name: string; help: string } | null>(null)
  useEffect(() => { api.remarks().then(setRows).catch((e) => setError((e as Error).message)) }, [])
  const act = useCallback(async (work: () => Promise<RemarkT[]>, done: string) => {
    setBusy(true)
    try { setRows(await work()); if (done) toast(done, 'good'); return true } catch (e) { toast((e as Error).message, 'bad'); return false } finally { setBusy(false) }
  }, [toast])
  const create = async (e: FormEvent) => { e.preventDefault(); if (await act(() => api.addRemark(add.name, add.help), `“${add.name.trim()}” is added for everyone`)) setAdd({ name: '', help: '' }) }
  const save = async (e: FormEvent) => { e.preventDefault(); if (edit && await act(() => api.updateRemark(edit.id, { name: edit.name, help: edit.help }), 'Saved for everyone')) setEdit(null) }
  const on = (rows ?? []).filter((r) => r.active), off = (rows ?? []).filter((r) => !r.active)
  return (
    <AppShell trail={<span className="trail-name">Settings</span>}>
      <PageHeader eyebrow="Every user, every client" title="Settings" description="What is set here is the same for everyone." />
      {error && <div className="alert bad">{error}</div>}
      <Card title="Remarks" description="The Remark dropdown in Not in the LNV: why a song is mapped to an exact or possible match. The LNV’s Remark column shows these names, word for word.">
        <form className="st-add" onSubmit={create}>
          <input value={add.name} maxLength={120} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="Type a remark" aria-label="Type a remark" />
          <input value={add.help} maxLength={400} onChange={(e) => setAdd({ ...add, help: e.target.value })} placeholder="What it means (optional)" aria-label="What it means" />
          <Button type="submit" variant="primary" icon={<Plus size={15} />} disabled={busy || !add.name.trim()}>Add remark</Button>
        </form>
        {!rows && !error ? <div className="loading"><span className="spinner" />Reading the list…</div> : (
          <ul className="st-list">{on.map((r, i) => (
            <li key={r.id}>{edit?.id === r.id ? (
              <form className="st-edit" onSubmit={save}>
                <input autoFocus value={edit.name} maxLength={120} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="Remark name" />
                <input value={edit.help} maxLength={400} onChange={(e) => setEdit({ ...edit, help: e.target.value })} aria-label="Remark meaning" placeholder="What it means (optional)" />
                <Button type="submit" size="sm" variant="primary" icon={<Check size={14} />} disabled={busy || !edit.name.trim()}>Save</Button>
                <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => setEdit(null)}>Cancel</Button>
              </form>
            ) : <>
              <div className="grow"><b>{r.name}</b>{r.help && <p>{r.help}</p>}{r.by && <small className="muted">Edited by {r.by} · {fmtDate(r.at)}</small>}</div>
              <button type="button" className="icon-btn" disabled={busy || i === 0} onClick={() => void act(() => api.updateRemark(r.id, { move: -1 }), '')} aria-label={`Move ${r.name} up`} title="Move up in the dropdown."><ArrowUp size={15} /></button>
              <button type="button" className="icon-btn" disabled={busy || i === on.length - 1} onClick={() => void act(() => api.updateRemark(r.id, { move: 1 }), '')} aria-label={`Move ${r.name} down`} title="Move down in the dropdown."><ArrowDown size={15} /></button>
              <Button size="sm" icon={<Pencil size={13} />} disabled={busy} onClick={() => setEdit({ id: r.id, name: r.name, help: r.help })} title="Change this remark for everyone.">Edit</Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={13} />} disabled={busy} onClick={() => void act(() => api.removeRemark(r.id), `“${r.name}” is not offered any more – songs that have it keep it`)} title="Take it out of the dropdown. Songs that have it keep it.">Remove</Button>
            </>}</li>))}</ul>)}
        {off.length > 0 && (
          <details className="st-off"><summary>Removed ({off.length})</summary><ul className="st-list">{off.map((r) => (
            <li key={r.id}><div className="grow"><b>{r.name}</b></div><Button size="sm" icon={<RotateCcw size={13} />} disabled={busy} onClick={() => void act(() => api.updateRemark(r.id, { active: true }), `“${r.name}” is offered again`)} title="Offer it in the dropdown again.">Put back</Button></li>))}</ul></details>)}
      </Card>
    </AppShell>
  )
}
