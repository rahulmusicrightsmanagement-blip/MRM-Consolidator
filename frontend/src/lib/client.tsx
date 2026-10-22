import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api'
import type { TaskPatch } from './api'
import { useToast } from './toast'
import type { ClientDetail, TaskT, WorkRow } from '../types'

interface ClientContextValue {
  clientId: number
  detail: ClientDetail | null
  tasks: TaskT[] | null
  works: WorkRow[] | null
  error: string | null
  refresh: () => Promise<void>
  updateTasks: (ids: number[], patch: TaskPatch) => Promise<void>
  saveClient: (patch: { owner?: string; due_date?: string | null; name?: string }) => Promise<void>
}

const ClientContext = createContext<ClientContextValue | null>(null)

/** Each client's last loaded data, shown at once when it is opened again while a fresh copy loads. */
const lastLoaded = new Map<number, { detail: ClientDetail | null; tasks: TaskT[] | null; works: WorkRow[] | null }>()

/** Everything about one client: detail + metrics, tasks and works. Pages read from here and call refresh() after changes. */
export function ClientProvider({ clientId, children }: { clientId: number; children: ReactNode }) {
  const [detail, setDetail] = useState<ClientDetail | null>(() => lastLoaded.get(clientId)?.detail ?? null)
  const [tasks, setTasks] = useState<TaskT[] | null>(() => lastLoaded.get(clientId)?.tasks ?? null)
  const [works, setWorks] = useState<WorkRow[] | null>(() => lastLoaded.get(clientId)?.works ?? null)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const refresh = useCallback(async () => {
    try {
      const [d, t, w] = await Promise.all([api.client(clientId), api.tasks(clientId), api.works(clientId)])
      setDetail(d); setTasks(t); setWorks(w); setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [clientId])

  useEffect(() => {
    const last = lastLoaded.get(clientId)
    setDetail(last?.detail ?? null); setTasks(last?.tasks ?? null); setWorks(last?.works ?? null)
    refresh()
  }, [clientId, refresh])
  useEffect(() => { if (detail) lastLoaded.set(clientId, { detail, tasks, works }) }, [clientId, detail, tasks, works])

  const updateTasks = useCallback(async (ids: number[], patch: TaskPatch) => {
    try {
      setTasks(await api.bulkTasks(clientId, ids, patch))
      const [d, w] = await Promise.all([api.client(clientId), api.works(clientId)])
      setDetail(d); setWorks(w)
      toast(ids.length > 1 ? `${ids.length} tasks updated` : 'Task updated', 'good')
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }, [clientId, toast])

  const saveClient = useCallback(async (patch: { owner?: string; due_date?: string | null; name?: string }) => {
    setDetail(await api.updateClient(clientId, patch))
    toast('Saved', 'good')
  }, [clientId, toast])

  return (
    <ClientContext.Provider value={{ clientId, detail, tasks, works, error, refresh, updateTasks, saveClient }}>
      {children}
    </ClientContext.Provider>
  )
}

export function useClient() {
  const ctx = useContext(ClientContext)
  if (!ctx) throw new Error('useClient must be used inside a client')
  return ctx
}

export function useOptionalClient() {
  return useContext(ClientContext)
}

/* ---------- shared labels ---------- */

export const TASK_TYPES: { id: string; label: string; short: string; tone: 'bad' | 'warn' | 'brand' | 'info' }[] = [
  { id: 'register', label: 'Register', short: 'Register', tone: 'bad' },
  { id: 'add_client_credit', label: 'Add client credit', short: 'Add credit', tone: 'bad' },
  { id: 'correct_credits', label: 'Correct writers / shares', short: 'Correct', tone: 'warn' },
  { id: 'merge_duplicates', label: 'Merge duplicate registrations', short: 'Merge', tone: 'info' },
  { id: 'fix_master', label: 'Fix our master', short: 'Fix master', tone: 'brand' },
]
export const TASK_TYPE = Object.fromEntries(TASK_TYPES.map((t) => [t.id, t]))

export const TASK_STATES: { id: TaskT['state']; label: string; closed: boolean }[] = [
  { id: 'open', label: 'Open', closed: false },
  { id: 'in_progress', label: 'In progress', closed: false },
  { id: 'submitted', label: 'Submitted', closed: false },
  { id: 'verified', label: 'Verified in report', closed: true },
  { id: 'done', label: 'Done', closed: true },
  { id: 'dismissed', label: 'Dismissed', closed: true },
]
export const isClosed = (s: TaskT['state']) => s === 'verified' || s === 'done' || s === 'dismissed'

export const REG_LABEL: Record<string, { label: string; tone: 'good' | 'bad' | 'warn' | 'info' }> = {
  registered: { label: 'Registered', tone: 'good' },
  not_registered: { label: 'Not registered', tone: 'bad' },
  needs_amend: { label: 'Needs amendment', tone: 'warn' },
  duplicate: { label: 'Duplicate', tone: 'info' },
}

export const today = () => new Date().toISOString().slice(0, 10)
export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)
