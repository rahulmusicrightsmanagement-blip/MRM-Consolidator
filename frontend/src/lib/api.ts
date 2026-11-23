import type {
  ChangeT, CleanChoice, CleanPayload, ClientDetail, IpiPayload, RemarkT, SongForm, TypedData, SongRecord, StepsPayload, ClientRef, Role, ClientRow, EditChoice, FileKind, PairResult, RunPayload, RunSummary, TaskState, TaskT, User, VerifyResult, WorkDetail, WorkRow,
} from '../types'

export class ApiError extends Error {
  checks?: { label: string; passed: boolean; detail: string }[]
  /** what is wrong, per field of the form that was sent */
  fields?: Record<string, string>
  constructor(message: string, checks?: ApiError['checks'], fields?: ApiError['fields']) {
    super(message)
    this.checks = checks
    this.fields = fields
  }
}

/** Fired when the server says the session has ended, so the app can show the login page. */
export const SIGNED_OUT_EVENT = 'mrm:signed-out'

function csrfToken() {
  return document.cookie.split('; ').find((c) => c.startsWith('csrftoken='))?.slice('csrftoken='.length) ?? ''
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-CSRFToken', decodeURIComponent(csrfToken()))
  let res: Response
  try {
    res = await fetch(url, { ...init, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiError('Cannot reach the server. Start it with ./start.sh')
  }
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && data.auth === 'required') window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
  if (res.status === 403 && !data.error) throw new ApiError('This page was open too long – reload it and try again.')
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, data.checks, data.fields)
  return data as T
}

const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export type DecisionItem = { internal_no: string; master_row: number; also_rows?: number[] } | { internal_no: string; action: 'new'; rejected_rows: number[] }
export type MasterEditIn = { master_row: number; field: string; internal_no: string; choice: EditChoice | null }

export type CleanDecisionIn = {
  key: string; choice: CleanChoice | null
  data?: { keep?: number | string; row?: number; rows?: number[]; excluded?: number[]; type?: string; cover?: string; a?: string; b?: string; songs?: string[]; name?: string; value?: string | string[]; to?: number | string; title?: string; from?: string; ipis?: string[]; also?: number[]; remark?: number | null }
  /** for the Undo section: the songs it concerns, what it did in plain words; items with one group are one change */
  log?: ChangeLog
}
export type ChangeLog = { group?: string; songs?: { key: string; title: string }[]; text: string; minor?: boolean }
export type ListSheet = { name: string; header: string[]; rows: (string | number)[][] }

export interface TaskPatch { state?: TaskState; owner?: string; due_date?: string | null; note?: string }

export const api = {
  me: () => request<{ user: User | null }>('/api/auth/me/').then((d) => d.user),
  login: (email: string, password: string) => request<{ user: User }>('/api/auth/login/', send({ email, password })).then((d) => d.user),
  logout: () => request('/api/auth/logout/', send({})),
  changePassword: (current: string, next: string) => request<{ user: User }>('/api/auth/password/', send({ current, new: next })),
  users: () => request<{ users: User[] }>('/api/users/').then((d) => d.users),
  createUser: (body: { email: string; name: string; password: string; role?: Role }) => request<User>('/api/users/', send(body)),
  updateUser: (id: number, patch: { name?: string; is_active?: boolean; password?: string; role?: Role }) => request<User>(`/api/users/${id}/`, send(patch, 'PATCH')),
  deleteUser: (id: number) => request(`/api/users/${id}/`, { method: 'DELETE' }),
  clients: () => request<{ clients: ClientRow[]; stages: string[] }>('/api/clients/'),
  client: (id: number) => request<ClientDetail>(`/api/clients/${id}/`),
  updateClient: (id: number, patch: Partial<Pick<ClientRef, 'name' | 'owner' | 'due_date'>>) =>
    request<ClientDetail>(`/api/clients/${id}/`, send(patch, 'PATCH')),
  createClient: (body: { name: string; ipi?: string; owner?: string; due_date?: string | null; home_society?: string }) =>
    request<ClientRef>('/api/clients/', send(body)),
  uploadMaster: (id: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<ClientDetail>(`/api/clients/${id}/master/`, { method: 'POST', body: form })
  },
  deleteMaster: (id: number) => request<ClientDetail>(`/api/clients/${id}/master/`, { method: 'DELETE' }),
  addSocieties: (id: number, societies: string[]) => request<ClientDetail>(`/api/clients/${id}/societies/`, send({ societies })),
  removeSociety: (id: number, society: string) => request<ClientDetail>(`/api/clients/${id}/societies/${society}/`, { method: 'DELETE' }),
  startReport: (id: number, society: string, report_date?: string) =>
    request<RunSummary>(`/api/clients/${id}/societies/${society}/`, send({ report_date })),
  deleteClient: (id: number) => request<{ deleted: number; runs_deleted: number }>(`/api/clients/${id}/`, { method: 'DELETE' }),
  tasks: (clientId: number) => request<{ tasks: TaskT[] }>(`/api/clients/${clientId}/tasks/`).then((d) => d.tasks),
  bulkTasks: (clientId: number, ids: number[], patch: TaskPatch) =>
    request<{ tasks: TaskT[] }>(`/api/clients/${clientId}/tasks/bulk/`, send({ ids, ...patch })).then((d) => d.tasks),
  task: (id: number) => request<TaskT>(`/api/tasks/${id}/`),
  updateTask: (id: number, patch: TaskPatch) => request<TaskT>(`/api/tasks/${id}/`, send(patch, 'PATCH')),
  works: (clientId: number) => request<{ works: WorkRow[] }>(`/api/clients/${clientId}/works/`).then((d) => d.works),
  work: (id: number) => request<WorkDetail>(`/api/works/${id}/`),
  clientExportUrl: (clientId: number, name: 'tasks' | 'catalogue') => `/api/clients/${clientId}/export/${name}/`,
  createRun: (body: { name?: string; client_id?: number | null; report_date?: string }) => request<RunSummary>('/api/runs/', send(body)),
  run: (id: number) => request<RunPayload>(`/api/runs/${id}/`),
  updateRun: (id: number, patch: { name?: string; report_date?: string | null; confirmed_step?: number; completed?: boolean }) => request<RunPayload>(`/api/runs/${id}/`, send(patch, 'PATCH')),
  deleteRun: (id: number) => request(`/api/runs/${id}/`, { method: 'DELETE' }),
  upload: (id: number, kind: FileKind | 'auto', file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<RunPayload & { detected: FileKind }>(`/api/runs/${id}/files/${kind}/`, { method: 'POST', body: form })
  },
  decide: (id: number, internal_no: string, action: 'link' | 'reject' | 'clear', master_row?: number | null) =>
    request<RunPayload>(`/api/runs/${id}/decisions/`, send({ internal_no, action, master_row })),
  masterEdits: (id: number, edits: { master_row: number; field: string; internal_no: string; choice: EditChoice | null }[]) =>
    request<RunPayload>(`/api/runs/${id}/master-edits/`, send({ edits })),
  confirmAll: (id: number, items: { internal_no: string; master_row: number }[]) =>
    request<RunPayload>(`/api/runs/${id}/decisions/`, send({ items })),
  /** Many review decisions in one request: links, and "new song" (every suggestion rejected). */
  decideMany: (id: number, items: DecisionItem[]) => request<RunPayload>(`/api/runs/${id}/decisions/`, send({ items })),
  flagSongs: (id: number, keys: string[], on: boolean) => request<RunPayload>(`/api/runs/${id}/song-flags/`, send({ keys, on })),
  verify: (id: number) => request<VerifyResult>(`/api/runs/${id}/verify/`),
  pair: (id: number, work?: string | null, row?: number | null) =>
    request<PairResult>(`/api/runs/${id}/pair/?${new URLSearchParams({ work: work ?? '', row: row ? String(row) : '' })}`),
  exportUrl: (id: number, name: string) => `/api/runs/${id}/export/${name}/`,
  /** The consolidate flow: each step's comparison blocks (step 1–3) and every step's counts. */
  steps: (clientId: number, step: number) => request<StepsPayload>(`/api/clients/${clientId}/steps/?step=${step}`),
  /** What the three files hold for one LNV row. */
  stepRow: (clientId: number, row: number) => request<{ records: SongRecord[] }>(`/api/clients/${clientId}/steps/?row=${row}`).then((d) => d.records),
  clean: (clientId: number) => request<CleanPayload>(`/api/clients/${clientId}/clean/`),
  uploadDsp: (clientId: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<CleanPayload>(`/api/clients/${clientId}/clean/`, { method: 'POST', body: form })
  },
  chooseDspSheet: (clientId: number, sheet: string) => request<CleanPayload>(`/api/clients/${clientId}/clean/`, send({ sheet })),
  deleteDsp: (clientId: number) => request<CleanPayload>(`/api/clients/${clientId}/clean/`, { method: 'DELETE' }),
  /** Many Data clean decisions in one request; choice null clears one. */
  cleanDecide: (clientId: number, items: CleanDecisionIn[]) => request<CleanPayload>(`/api/clients/${clientId}/clean/decisions/`, send({ items })),
  /** Every filled column of these DSP sheet rows. */
  cleanRows: (clientId: number, rows: number[]) => request<{ rows: { row: number; fields: { name: string; value: string }[] }[] }>(`/api/clients/${clientId}/clean/rows/?rows=${rows.join(',')}`),
  cleanExportUrl: (clientId: number) => `/api/clients/${clientId}/clean/export/`,
  /** Save step 1 decisions without rebuilding the result (step 1 keeps its own state while the reviewer works). */
  mergeSave: (clientId: number, items: CleanDecisionIn[]) => request<{ saved: number }>(`/api/clients/${clientId}/clean/decisions/`, send({ items, quiet: true })),
  mergeExportUrl: (clientId: number) => `/api/clients/${clientId}/steps/merged/`,
  /** The final LNV: the stage 2 LNV with step 3's (IPRS) answers. */
  lnvUpdateUrl: (clientId: number) => `/api/clients/${clientId}/steps/lnv/`,
  /** The stage 1 LNV: the LNV with step 2's answers, A–Z by song or by album. */
  stage1Url: (clientId: number, order: LnvOrder = 'song') => `/api/clients/${clientId}/steps/lnv/?stage=1${order === 'album' ? '&order=album' : ''}`,
  /** Mark Muso vs LNV completed (its result is kept as the stage 2 LNV), or open it again. */
  completeStage1: (clientId: number, done: boolean) => request<ClientDetail>(`/api/clients/${clientId}/stage1/`, send({ done })),
  stage2Url: (clientId: number) => `/api/clients/${clientId}/stage2/`,
  /** A corrected stage 2 LNV, in place of the one step 2 made. */
  uploadStage2: (clientId: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<ClientDetail>(`/api/clients/${clientId}/stage2/`, { method: 'POST', body: form })
  },
  /** The Undo section: every change made to a song in Muso vs LNV; undone (with the later ones on the same decisions), or made again. */
  changes: (clientId: number) => request<{ changes: ChangeT[] }>(`/api/clients/${clientId}/changes/`).then((d) => d.changes),
  undo: (clientId: number, ids: number[]) => request<{ undone: number[]; changes: ChangeT[] }>(`/api/clients/${clientId}/changes/`, send({ undo: ids })),
  redo: (clientId: number, id: number) => request<{ changes: ChangeT[] }>(`/api/clients/${clientId}/changes/`, send({ redo: id })),
  /** Add a song by typing it: the LNV's fields, and the song saved (key: an earlier one corrected). */
  songForm: (clientId: number) => request<SongForm>(`/api/clients/${clientId}/songs/`),
  saveSong: (clientId: number, data: TypedData, log: ChangeLog, key?: string) => request<{ key: string }>(`/api/clients/${clientId}/songs/`, send({ data, log, key })),
  /** How the IPI / CAE list has a name. */
  ipiLookup: (name: string) => request<{ found: { name: string; ipi: string } | null }>(`/api/ipi/lookup/?${new URLSearchParams({ name })}`).then((d) => d.found),
  /** The Remark dropdown's list (Settings), one for every user and client. */
  remarks: () => request<{ remarks: RemarkT[] }>('/api/remarks/').then((d) => d.remarks),
  addRemark: (name: string, help: string) => request<{ remarks: RemarkT[] }>('/api/remarks/', send({ name, help })).then((d) => d.remarks),
  updateRemark: (id: number, patch: { name?: string; help?: string; active?: boolean; move?: -1 | 1 }) => request<{ remarks: RemarkT[] }>(`/api/remarks/${id}/`, send(patch, 'PATCH')).then((d) => d.remarks),
  removeRemark: (id: number) => request<{ remarks: RemarkT[] }>(`/api/remarks/${id}/`, { method: 'DELETE' }).then((d) => d.remarks),
  /** A list of the review screen as Excel. */
  listFile: async (clientId: number, name: string, sheets: ListSheet[]) => {
    const res = await fetch(`/api/clients/${clientId}/lists/`, { ...send({ name, sheets }), credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(csrfToken()) } })
    if (!res.ok) throw new ApiError((await res.json().catch(() => null))?.error ?? 'The file could not be prepared.')
    return { name: /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `${name}.xlsx`, blob: await res.blob() }
  },
  /** The IPI / CAE list: its summary and uploads, and one page of members (search, filter). */
  ipi: (q = '', show: IpiShow = 'all', page = 1) => request<IpiPayload>(`/api/ipi/?${new URLSearchParams({ q, show, page: String(page) })}`),
  /** A member list uploaded: new names added, changed ones updated – replace also removes the names it does not have. */
  uploadIpi: (file: File, replace = false) => {
    const form = new FormData()
    form.append('file', file)
    if (replace) form.append('replace', '1')
    return request<IpiPayload>('/api/ipi/', { method: 'POST', body: form })
  },
  clearIpi: () => request<IpiPayload>('/api/ipi/', { method: 'DELETE' }),
  /** The IPRS report, added in LNV vs IPRS: the society is added and its report opened when needed. */
  uploadIprs: async (clientId: number, file: File, run?: number | null) => {
    if (!run) {
      await request<ClientDetail>(`/api/clients/${clientId}/societies/`, send({ societies: ['IPRS'] }))
      run = (await request<RunSummary>(`/api/clients/${clientId}/societies/IPRS/`, send({ report_date: new Date().toISOString().slice(0, 10) }))).id
    }
    const form = new FormData()
    form.append('file', file)
    return request<RunPayload & { detected: FileKind }>(`/api/runs/${run}/files/iprs/`, { method: 'POST', body: form })
  },
}

export type LnvOrder = 'song' | 'album'
export type IpiShow = 'all' | 'new' | 'updated'
