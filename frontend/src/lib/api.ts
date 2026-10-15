import type {
  ClientDetail, ClientRef, Role, ClientRow, EditChoice, FileKind, PairResult, RunPayload, RunSummary, TaskState, TaskT, User, VerifyResult, WorkDetail, WorkRow,
} from '../types'

export class ApiError extends Error {
  checks?: { label: string; passed: boolean; detail: string }[]
  constructor(message: string, checks?: ApiError['checks']) {
    super(message)
    this.checks = checks
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
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, data.checks)
  return data as T
}

const send = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

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
  flagSongs: (id: number, keys: string[], on: boolean) => request<RunPayload>(`/api/runs/${id}/song-flags/`, send({ keys, on })),
  verify: (id: number) => request<VerifyResult>(`/api/runs/${id}/verify/`),
  pair: (id: number, work?: string | null, row?: number | null) =>
    request<PairResult>(`/api/runs/${id}/pair/?${new URLSearchParams({ work: work ?? '', row: row ? String(row) : '' })}`),
  exportUrl: (id: number, name: string) => `/api/runs/${id}/export/${name}/`,
}
