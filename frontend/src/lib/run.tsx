import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from './api'
import type { DecisionItem, MasterEditIn } from './api'
import { buildModel } from './model'
import { saveWorkList } from './worklist'
import type { RunModel } from './model'
import type { Check, EditChoice, FileKind, RunPayload } from '../types'
import { useToast } from './toast'

interface RunContextValue {
  runId: number
  payload: RunPayload | null
  model: RunModel | null
  loading: boolean
  error: string | null
  busy: string | null
  rejected: Partial<Record<FileKind, { message: string; checks?: Check[] }>>
  upload: (kind: FileKind | 'auto', file: File) => Promise<{ ok: true; kind: FileKind } | { ok: false; error: string; checks?: Check[] }>
  decide: (internalNo: string, action: 'link' | 'reject' | 'clear', row?: number | null) => Promise<void>
  /** Choose which value our master keeps for fields that differ (null clears the choice). */
  editMaster: (edits: { master_row: number; field: string; internal_no: string; choice: EditChoice | null }[]) => Promise<void>
  /** Save a batch of review decisions (and master edits such as the IPRS title as alternate title) in one go. */
  saveDecisions: (items: DecisionItem[], edits?: MasterEditIn[]) => Promise<boolean>
  /** Link many IPRS works at once to the master song suggested for each. */
  confirmAll: (items: { internal_no: string; master_row: number }[]) => Promise<void>
  /** Mark songs "Not our work" (on) or clear the mark. */
  flagSongs: (keys: string[], on: boolean) => Promise<void>
  updateRun: (patch: { name?: string; report_date?: string | null; confirmed_step?: number; completed?: boolean }) => Promise<void>
  openSong: (key: string | null, list?: string[], label?: string) => void
  exportUrl: (name: string) => string
}

const RunContext = createContext<RunContextValue | null>(null)

export function RunProvider({ runId, children, onChange }: { runId: number; children: ReactNode; onChange?: () => void }) {
  const [payload, setPayload] = useState<RunPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [rejected, setRejected] = useState<RunContextValue['rejected']>({})
  const navigate = useNavigate()
  const toast = useToast()

  useEffect(() => {
    setLoading(true)
    setRejected({})
    api.run(runId).then(setPayload).catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [runId])

  const model = useMemo(() => (payload ? buildModel(payload.result) : null), [payload])

  const upload = useCallback(async (kind: FileKind | 'auto', file: File) => {
    setBusy(kind)
    try {
      const res = await api.upload(runId, kind, file)
      setPayload(res)
      onChange?.()
      setRejected((r) => ({ ...r, [res.detected]: undefined }))
      toast(`${file.name} loaded`, 'good')
      return { ok: true as const, kind: res.detected }
    } catch (e) {
      const err = e as ApiError
      if (kind !== 'auto') setRejected((r) => ({ ...r, [kind]: { message: err.message, checks: err.checks } }))
      toast(`${file.name} was rejected`, 'bad')
      return { ok: false as const, error: err.message, checks: err.checks }
    } finally {
      setBusy(null)
    }
  }, [runId, toast, onChange])

  const decide = useCallback(async (internalNo: string, action: 'link' | 'reject' | 'clear', row?: number | null) => {
    setBusy('decision')
    try {
      setPayload(await api.decide(runId, internalNo, action, row))
      onChange?.()
      toast(action === 'link' ? 'Link confirmed' : action === 'reject' ? 'Suggestion rejected' : 'Back to automatic', 'good')
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(null)
    }
  }, [runId, toast, onChange])

  const editMaster = useCallback(async (edits: { master_row: number; field: string; internal_no: string; choice: EditChoice | null }[]) => {
    setBusy('edit')
    try {
      setPayload(await api.masterEdits(runId, edits))
      const c = edits[0]?.choice
      toast(edits.length > 1 ? `${edits.length} fields will be added to our master` : c === 'iprs' ? 'IPRS value will go into our master' : c === 'master' ? 'Keeping our master value' : 'Choice cleared', 'good')
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(null)
    }
  }, [runId, toast])

  const saveDecisions = useCallback(async (items: DecisionItem[], edits: MasterEditIn[] = []) => {
    if (!items.length && !edits.length) return true
    setBusy('decision')
    try {
      let next = items.length ? await api.decideMany(runId, items) : null
      if (edits.length) next = await api.masterEdits(runId, edits)
      if (next) setPayload(next)
      onChange?.()
      toast(`${items.length} decision${items.length === 1 ? '' : 's'} saved`, 'good')
      return true
    } catch (e) {
      toast((e as Error).message, 'bad')
      return false
    } finally {
      setBusy(null)
    }
  }, [runId, toast, onChange])

  const confirmAll = useCallback(async (items: { internal_no: string; master_row: number }[]) => {
    setBusy('decision')
    try {
      setPayload(await api.confirmAll(runId, items))
      onChange?.()
      toast(`${items.length} link${items.length === 1 ? '' : 's'} confirmed`, 'good')
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(null)
    }
  }, [runId, toast, onChange])

  const flagSongs = useCallback(async (keys: string[], on: boolean) => {
    setBusy('flag')
    try {
      setPayload(await api.flagSongs(runId, keys, on))
      toast(on ? `${keys.length} song${keys.length === 1 ? '' : 's'} marked Not our work` : 'Not our work removed', 'good')
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(null)
    }
  }, [runId, toast])

  const updateRun = useCallback(async (patch: { name?: string; report_date?: string | null; confirmed_step?: number; completed?: boolean }) => {
    setPayload(await api.updateRun(runId, patch))
    onChange?.()
  }, [runId, onChange])

  /** Open the permanent work page for a song of this report. */
  const openSong = useCallback((key: string | null, list?: string[], label?: string) => {
    const id = key ? payload?.work_ids[key] : undefined
    if (!id || !payload?.run.client) return
    // Remember the list the work was opened from so the work page can show Previous / Next.
    const ids = (list ?? [key!]).map((k) => payload.work_ids[k]).filter((x): x is number => !!x)
    saveWorkList({ ids: [...new Set(ids)], label: label ?? 'List', back: window.location.pathname + window.location.search })
    navigate(`/clients/${payload.run.client.id}/works/${id}`)
  }, [payload, navigate])

  const value: RunContextValue = {
    runId, payload, model, loading, error, busy, rejected, upload, decide, editMaster, saveDecisions, confirmAll, flagSongs, updateRun, openSong,
    exportUrl: (name) => api.exportUrl(runId, name),
  }
  return <RunContext.Provider value={value}>{children}</RunContext.Provider>
}

export function useRun() {
  const ctx = useContext(RunContext)
  if (!ctx) throw new Error('useRun must be used inside a run')
  return ctx
}

export function useOptionalRun() {
  return useContext(RunContext)
}
