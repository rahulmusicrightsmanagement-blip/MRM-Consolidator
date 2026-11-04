// Shapes returned by the Django API (catalogue/engine).

export type FileKind = 'iprs' | 'master' | 'prs'
export type Status = 'Match' | 'Amend' | 'Registration'

export interface ClientRef { id: number; name: string; ipi: string; owner: string; due_date: string | null; home_society: string }

export interface RunStats {
  stage?: number
  works?: number
  contributor_rows?: number
  errors?: number
  warnings?: number
  master_songs?: number
  master_issues?: number
  linked?: number
  matched?: number
  with_differences?: number
  review?: number
  iprs_only?: number
  master_only?: number
  final_total?: number
  added?: number
  societies?: Record<string, Record<Status, number>>
  master_updates?: number
  actions_open?: number
  actions_done?: number
  actions_started?: number
  work?: Record<string, Record<string, { open: number; done: number }>>
  track?: { index: number; label: string }
}

export interface RunSummary {
  id: number
  name: string
  client: ClientRef | null
  summary: RunStats
  report_date: string | null
  society: string
  confirmed_step: number
  completed_at: string | null
  steps: string[]
  client_name: string
  client_ipi: string
  created_at: string
  updated_at: string
  files: Record<FileKind, { name: string; uploaded_at: string } | null>
}

export interface Check { label: string; passed: boolean; detail: string }

export interface Contributor {
  source_row: number
  set_no: string
  name_type: string
  role: string
  name: string
  ipi: string
  society: string
  per_own: number | null
  per_collect: number | null
  mec_own: number | null
  mec_collect: number | null
  sync_own: number | null
  sync_collect: number | null
  wrapped_rows?: number[]
}

export interface IprsWork {
  internal_no: string
  title: string
  alt_title: string
  iswc: string
  isrc: string
  duration: string
  language: string
  category: string
  status: string
  performer: string
  production: string
  source_rows: number[]
  contributors: Contributor[]
  authors: Contributor[]
  composers: Contributor[]
  publishers: Contributor[]
  issue_codes: string[]
}

export interface Issue {
  internal_no?: string
  row?: number
  title: string
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
}

export interface CleanupEntry { row: number; column: string; original: string; cleaned: string; action: string }

export interface IprsResult {
  client: { internal_no: string; name: string; ipi_name_no: string; ipi_base_no: string }
  checks: Check[]
  works: IprsWork[]
  cleanup: CleanupEntry[]
  issues: Issue[]
  stats: {
    works: number
    contributor_rows: number
    footer_count: number | null
    rows_per_work: Record<string, number>
    languages: Record<string, number>
    categories: Record<string, number>
    client_roles: Record<string, number>
  }
}

export interface MasterPerson { slot: number; name: string; ipi: string; role: string; perf: number | null; mech: number | null }
export interface Registration { society: string; slot: number; code: string; isrc: string; iswc: string; client_status?: string; general_status?: string }

export interface MasterSong {
  row: number
  sn: string
  title: string
  alt_title?: string
  movie?: string
  duration?: string
  singers: MasterPerson[]
  composers: MasterPerson[]
  authors: MasterPerson[]
  publishers: MasterPerson[]
  registrations: Registration[]
  isrcs: string[]
  iswcs: string[]
  has_credits: boolean
}

export interface MasterResult {
  songs: MasterSong[]
  issues: Issue[]
  stats: { songs: number; columns: number; blocks: number; societies: string[]; multiline_cells: number; with_credits: number }
}

export interface FieldCompare {
  field: string
  iprs: string
  master: string
  result: 'same' | 'different' | 'missing_master' | 'missing_iprs' | 'ipi_mismatch' | 'fill'
  note: string
}

export interface Candidate { row: number; title: string; methods: string[]; title_score: number; shared_contributors: number; alt_title?: string; match?: MatchEvidence }

export interface Link {
  internal_no: string
  title: string
  candidates: Candidate[]
  master_row: number | null
  master_title?: string
  method: string
  state: 'linked' | 'review' | 'unmatched'
  reason: string
  needs_code_fill?: boolean
  comparison?: { fields: FieldCompare[]; differences: number; status: 'matched' | 'differences' }
  match?: MatchEvidence
  /** Further master rows the reviewer marked as the same song. */
  also_rows?: number[]
}

export interface MappingResult {
  links: Link[]
  master_only: { row: number; title: string; iprs_codes: string[] }[]
  summary: Record<string, number>
}

export interface FinalRow {
  key: string
  origin: 'master' | 'iprs'
  master_row: number | null
  title: string
  iprs_works: string[]
  fills: { field: string; value: string; reason: string }[]
  iswc?: string
  isrc?: string
  language?: string
  category?: string
}

export interface FinalResult {
  rows: FinalRow[]
  added: FinalRow[]
  pending: string[]
  summary: Record<string, number>
}

export interface SocietyStatus {
  society: string
  status: Status
  codes: string[]
  method: string
  reasons: string[]
  notes?: string[]
  issues?: { code: string; text: string }[]
  master_updates: string[]
}

export interface TunecodeRow {
  key: string
  origin: 'master' | 'iprs'
  master_row: number | null
  title: string
  societies: Record<string, SocietyStatus>
  master_updates: string[]
}

export interface TunecodeResult {
  rows: TunecodeRow[]
  summary: Record<string, Record<Status, number> | number>
  prs_not_in_report: { code: string; title: string; writers: string[] }[]
}

export interface PipelineResult {
  iprs: IprsResult | null
  master: MasterResult | null
  prs: { works: PrsWork[]; writer_columns: number; checks: Check[]; stats: { works: number } } | null
  mapping: MappingResult | null
  final: FinalResult | null
  tunecodes: TunecodeResult | null
  /** What goes into the master's IPRS columns (IPRS reports only). */
  fill?: FillResult | null
  errors: Partial<Record<FileKind, { message: string; checks?: Check[] }>>
}

export interface FillBlock {
  slot: number
  internal_no: string
  title: string
  isrc: string
  iswc: string
  client_status: string
  general_status: string
  client_reasons: string[]
  general_reasons: string[]
  purpose: string
  already_in_master: boolean
  /** first: written into this block now · kept: an earlier amendment round, left as it is · new: next block after it */
  round: 'first' | 'kept' | 'new'
  earlier: number[]
  date?: string
}
export type FillState = 'uploaded' | 'amend' | 'not_registered' | 'not_our_work' | 'pending'
export interface FillRow {
  key: string
  origin: 'master' | 'iprs'
  master_row: number | null
  title: string
  state: FillState
  blocks: FillBlock[]
  overflow: string[]
  not_our_work: boolean
  marked_in_master: boolean
  /** Where a "Not registered" / "Not our work" status is written: the first empty IPRS block; null = already marked. */
  status_slot: number | null
}
export interface FillResult {
  rows: FillRow[]
  slots: number
  summary: Record<FillState, number> & { blocks: number; multi: number; overflow: number; client_amend: number; general_amend: number; new_rounds: number; kept: number }
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info'
export interface VerifyItem { row?: number | null; code?: string; title?: string; detail: string }
export interface VerifyCheck { step: number; id: string; label: string; status: CheckStatus; detail: string; items: VerifyItem[] }
/** [column index, before, after, state, why] */
export type PreviewCell = [number, string, string, 'same' | 'changed' | 'added' | 'unexpected', string]
export interface PreviewRow { row: number; title: string; kind: 'master' | 'added'; changed: number; unexpected: number; amend: boolean; cells: PreviewCell[] }
export interface PreviewColumn { col: number; letter: string; header: string; group: string }
export interface VerifyResult {
  checks: VerifyCheck[]
  summary: { pass: number; warn: number; fail: number; info: number; cells_changed: number; cells_unexplained: number; rows: number; added: number }
  preview: { columns: PreviewColumn[]; rows: PreviewRow[] }
}

export interface PrsWork {
  row: number
  title: string
  code: string
  iswc: string
  iswc_valid: string
  writers: string[]
  publishers: string[]
  work_status: string
  distributed: string
  other_info: string
}

/** The reviewer's pick for one field of one master song: write the IPRS value into our master, or keep ours. */
export type EditChoice = 'iprs' | 'master'
export interface MasterEdit { master_row: number; field: string; internal_no: string; choice: EditChoice }

export interface RunPayload { run: RunSummary; result: PipelineResult; latest: boolean; work_ids: Record<string, number>; master_edits: MasterEdit[] }

/* ---------------- persistent catalogue ---------------- */

export type TaskState = 'open' | 'in_progress' | 'submitted' | 'verified' | 'done' | 'dismissed'
export type TaskType = 'register' | 'add_client_credit' | 'correct_credits' | 'merge_duplicates' | 'fix_master'
export type RegStatus = 'registered' | 'not_registered' | 'needs_amend' | 'duplicate'

export interface TaskEventT { kind: string; text: string; at: string }
export interface TaskT {
  id: number
  work: { id: number; mrm_id: string; title: string }
  society: string
  type: TaskType
  type_label: string
  state: TaskState
  state_label: string
  detail: string[]
  owner: string
  due_date: string | null
  note: string
  created_at: string
  updated_at: string
  opened_report: string | null
  closed_report: string | null
  codes: string[]
  events?: TaskEventT[]
}

export interface Coverage { total: number; registered: number; clean: number; statuses: Partial<Record<RegStatus, number>> }
export interface SocietyMeta { code: string; name: string; country: string; kind: string; file: string; available: boolean }
export interface SocietySummary {
  code: string
  meta: SocietyMeta
  status: 'not_started' | 'in_progress' | 'completed'
  steps: string[]
  report: RunSummary | null
  report_count: number
  coverage: Coverage | null
  open_tasks: number
  tasks: number
  review: number
}
export interface MasterInfo { id: number; name: string; uploaded_at: string; stats: { songs?: number; columns?: number; societies?: string[]; with_credits?: number; issues?: number; issue_counts?: Record<string, number> } }

export interface ClientMetrics {
  master: MasterInfo | null
  societies: SocietySummary[]
  works: number
  with_iswc: number
  credited: number
  coverage: Record<string, Coverage>
  tasks: { open: number; closed: number; total: number; overdue: number; verified: number; by_type: Record<string, { open: number; closed: number }> }
  stage: { index: number; label: string }
  /** Where the client is in the consolidate flow: 1 files · 2 Muso & LNV · 3 LNV vs IPRS · 4 final LNV */
  journey: { step: number; label: string; steps: string[]; files: { lnv: boolean; dsp: boolean; iprs: boolean }
    needs: { '2': number | null; '3': number | null }; source: string }
  review: number
  latest_report: RunSummary | null
}
export interface ClientRow extends ClientRef, ClientMetrics { report_count: number }
export interface ClientDetail extends ClientMetrics {
  client: ClientRef
  reports: RunSummary[]
  clean: DspInfo | null
  available_societies: (SocietyMeta & { added: boolean })[]
  changes: {
    new_works: number
    new_tasks: number
    status_changes: { work: string; title: string; society: string; from: RegStatus; to: RegStatus }[]
    verified: { id: number; title: string; label: string }[]
    reopened: { id: number; title: string; label: string }[]
  }
}

export interface WorkRow {
  id: number
  mrm_id: string
  title: string
  origin: 'master' | 'iprs'
  identifiers: Partial<Record<'IPRS' | 'PRS' | 'ISWC' | 'ISRC', string[]>>
  registrations: Record<string, { status: RegStatus; label: string; codes: string[] }>
  open_tasks: number
  task_types: TaskType[]
  credited: boolean
  in_latest: boolean
  writers: string[]
}

export interface Credit { name: string; role: string; ipi: string; share: number | null; master_share?: number | null; society: string; sources: string[] }
export interface MatchEvidence { score: number; evidence: { field: string; points: number; note: string }[] }

export interface WorkDetail extends WorkRow {
  client: ClientRef
  alt_titles: string[]
  language: string
  category: string
  duration: string
  master_row: number | null
  credits: Credit[]
  sources: {
    iprs: IprsWork[]
    master: MasterSong | null
    prs: PrsWork[]
    links: Link[]
    fills: { field: string; value: string; reason: string }[]
    tunecode: TunecodeRow
  }
  first_report: string | null
  last_report: string | null
  registration_detail: { society: string; status: RegStatus; label: string; codes: string[]; found_by: string; issues: { code: string; text: string }[] }[]
  tasks: TaskT[]
  events: TaskEventT[]
  latest_run: number | null
}

/* Every column of one IPRS work next to every column of its master row (GET /api/runs/<id>/pair/). */
export type PairStatus = 'same' | 'different' | 'only_iprs' | 'only_master' | 'one_side'
export interface PairRow { label: string; iprs: string; iprs_col: string; master: string; master_col: string; letter: string; status: PairStatus; note: string }
export interface PairPerson {
  group: 'authors' | 'composers' | 'publishers' | 'others'
  iprs: { row: number; name: string; role: string; ipi: string; society: string; name_type: string; set_no: string
    per_own: number | null; per_collect: number | null; mec_own: number | null; mec_collect: number | null; sync_own: number | null; sync_collect: number | null } | null
  master: { slot: string; col: string; name: string; role: string; ipi: string; joshua: string; perf: number | null; mech: number | null } | null
  diffs: ('ipi' | 'role' | 'perf' | 'mech')[]
}
export interface PairResult {
  internal_no: string | null
  master_row: number | null
  sections: { id: string; title: string; note?: string; rows: PairRow[] }[]
  people: PairPerson[]
  iprs_raw: { columns: { letter: string; header: string }[]; rows: { row: number; cells: string[] }[] } | null
  master_raw: { row: number; columns: { letter: string; header: string; value: string }[] } | null
  counts: Partial<Record<PairStatus, number>>
  master_filled: number
}

export type Role = 'super_admin' | 'admin' | 'member'

export interface User {
  id: number
  email: string
  name: string
  is_active: boolean
  role: Role
  is_super_admin: boolean
  /** Admin or super admin: may open the Users page. */
  is_admin: boolean
  last_login: string | null
  date_joined: string
}

/* ---------- data clean (step 1: today's LNV against one DSP sheet) ---------- */

export type CleanChoice = 'ignore' | 'keep' | 'duplicate' | 'different' | 'owner' | 'neither' | 'same' | 'fix' | 'ok' | 'add' | 'not_ours' | 'accept' | 'reject' | 'none' | 'accepted' | 'rejected' | 'pending' | 'set' | 'muso'
export interface CleanDecisionT { choice: CleanChoice; data?: { keep?: number | string; row?: number; rows?: number[] }; auto?: boolean; why?: string }
export type CreditKind = 'writer' | 'shared' | 'medley' | 'performer'

export interface DspSong {
  key: string; title: string; album: string; isrcs: string[]; isrc_count: number
  lyricists: string[]; composers: string[]; singers: string[]; year: string; popularity: number
  versions: Record<string, number>; recordings: number; link: string; client_writer: boolean; other_composers: string[]; credit: CreditKind
}
export interface LnvBrief {
  row: number; title: string; movie: string; isrcs: string[]; writers: string[]; year: string; codes: Record<string, number>; has_writers: boolean
  lyricists?: string[]; composers?: string[]; singers?: string[]; alt_title?: string; label?: string; duration?: string; language?: string
}
export interface CleanLink { row: number; score: number; points: number; evidence: string[]; flags: string[]; confirmed?: boolean; lnv: LnvBrief }
interface Decided { key: string; decision?: CleanDecisionT; auto?: Omit<CleanDecisionT, 'auto'> }
export interface MatchedItem extends Omit<Decided, 'auto'> { song: DspSong; confirmed: boolean; links: CleanLink[]; auto: string | null; notes: string[] }
export interface CheckItem extends Decided { song: DspSong; candidates: CleanLink[]; flagged: boolean }
export interface MissingItem extends Omit<DspSong, 'key'>, Decided { song_key: string; rejected: boolean }
export interface DupCase extends Decided { kind: 'duplicate' | 'wrong_isrc'; title: string; keeper: number | null; reasons: string[]; rows: LnvBrief[] }
export interface NameSide { spelling: string; spellings: string[]; lnv: number; dsp: number; songs: string[] }
export interface SpellingItem extends Decided { kind: 'spelling'; a_key: string; b_key: string; similarity: number; a: NameSide; b: NameSide; client: boolean; info: boolean }
export interface JunkItem extends Decided { kind: 'junk'; name: string; count: number; songs: string[]; info?: undefined }
export type NameItem = SpellingItem | JunkItem
export interface FillItem extends Decided { row: number; title: string; field: string; value: string; song: string; song_key: string; score: number; more: number }
export type CleanQueue = 'duplicates' | 'names' | 'missing' | 'fills' | 'check' | 'matched'

export interface CleanSummary {
  songs: number; matched: number; check: number; unmatched: number; missing_writer: number; missing_credit: Partial<Record<CreditKind, number>>
  lnv_rows_matched: number; lnv_not_on_dsp: number; duplicates: number; duplicate_rows: number; names: number; fills: number; writers_differ: number
}
export interface CleanResult {
  source: { name: string; sheet: string; sheets: { name: string; songs: number }[]; rows: number; recordings: number; songs: number; versions: Record<string, number> }
  lnv: { songs: number; with_writers: number; with_isrc: number }
  client_names: string[]
  summary: CleanSummary
  matched: MatchedItem[]; check: CheckItem[]; missing: MissingItem[]; duplicates: DupCase[]; names: NameItem[]; fills: FillItem[]
  open: Record<CleanQueue, number>
  auto: Record<CleanQueue, number>
  decided: number
}
export interface DspInfo {
  id: number; name: string; uploaded_at: string; source: string; sheet: string
  stats: { rows?: number; with_isrc?: number; sheets?: { name: string; songs: number }[] }
  summary: Partial<CleanSummary> & { open?: Record<CleanQueue, number>; source?: string }
}
export interface CleanPayload { master: MasterInfo | null; dsp: DspInfo | null; result: CleanResult | null }

/* ---------- the consolidate flow: 1 clean the DSP sheet · 2 DSP vs LNV · 3 LNV vs IPRS ---------- */

/** One source's record of a song; a block shows several one below another. */
export interface SongRecord {
  src: string; ref: string; row?: number; sheet_row?: number; key?: string; code?: string; link?: string
  fields: Record<string, string | string[]>
  version?: string; why?: string | { text: string; good: boolean }[] | null; score?: number | null; popularity?: number
}
/** Step 1: the DSP export and the LNV in one pass, one case per song (a block of records one below another). */
export type CaseKind = 'names' | 'versions' | 'isrc' | 'check' | 'missing' | 'left_out' | 'twice'
export interface CaseRecord extends SongRecord {
  id?: number; sheet_rows?: number[]; in?: boolean
  /** Where this DSP recording goes in the LNV: the song's own row (original), or a version's row – lnv_row when the LNV has it */
  part?: 'original' | 'version'; lnv_row?: number | null
  /** The same-song rule on this LNV row: writers same · differ · blank; publisher same · differ · unchecked */
  check?: {
    writers: 'same' | 'close' | 'differ' | 'blank'; publisher: 'same' | 'differ' | 'unchecked'
    /** a shared ISRC · title likeness 0-100 · writers on the DSP side only, on the LNV side only */
    isrc?: boolean; title?: number; odd?: [number, number]
    /** writers on both sides besides the client */
    shared?: number
    /** the user's rule against the DSP recording that fits best (its first sheet row: via): exact – the same
     *  credits (title, version, album, writers, publisher) and ISRC · possible – one of the two · null – neither */
    level?: 'exact' | 'possible' | 'isrc_only' | null; via?: number
    /** the user's two stages: 1 the recording (title, album, ISRC, year) · 2 the work (title, album, writers, publisher) */
    stage1?: boolean; stage2?: boolean
  } | null
}
export interface CaseAnswer {
  /** Song cases: the DSP song's key; choice same (rows) · add · not_ours */
  song?: string
  /** LNV-twice cases: the decision key; choice duplicate/owner (keep) · different/neither */
  key?: string
  choice: string | null; rows?: number[]; keep?: number | null; by: 'app' | 'you' | null; why?: string
}
export interface ReviewCase {
  id: string; kind: CaseKind; title: string; why: string; tone?: string | null; isrc?: boolean; popularity?: number
  /** step 1's merge items this song is made of: each one's recordings (ids) and answer */
  merge: { key: string; status: 'pending' | 'accepted' | 'rejected'; by: 'app' | 'you'; items: { key: string; ids: number[]; status: string }[] } | null
  muso: CaseRecord[]; lnv: CaseRecord[]; answer: CaseAnswer; done: boolean
  /** Linked surely by the app, never asked: listed only under the match tabs */
  auto?: boolean
  /** Song cases: the LNV row an added song becomes */
  new_row: Record<string, string | string[]> | null
  /** Blank fields of the chosen LNV rows the DSP song fills in */
  updates: { key: string; row: number; field: string; value: string; more: number; accept: boolean; by: 'app' | 'you' }[]
  /** The song's versions the LNV already has, each beside its LNV row; answer: same (right) · none (not this
   *  version – added as a new row) · null (the app's match) */
  in_lnv?: { key: string; type: string; row: number; muso: CaseRecord; lnv: CaseRecord; isrc: boolean; album: boolean; year: boolean; answer: 'same' | 'none' | null }[]
  /** "Same person?" cases: the two spellings and songs they keep apart */
  names?: { a: string; b: string; songs: string[] }
  /** A song not in the LNV that is a new recording of an LNV work: that row (named as its original in the new row);
   *  sure – the same writers, else only a shared writer */
  origin?: (CaseRecord & { sure: boolean }) | null
}
export interface Step1 {
  source: string
  counts: {
    rows: number; recordings: number; songs: number; in_lnv: number; adding: number; not_ours: number; undecided: number
    lnv: number; lnv_only: number; cases: number; open: number; needs: number; kinds: Record<CaseKind, number>; fills: number; filled_rows: number
    /** versions getting a row of their own · LNV version rows getting their original named */
    versions_new: number; versions_named: number
    /** values taken from the DSP over the LNV's own */
    picks: number
  }
  /** "pick:<row>:<field>" -> the DSP value the reviewer chose over the LNV's */
  picks: Record<string, string | string[]>
  cases: ReviewCase[]
  lnv_only: { row: number; title: string; film: string; year: string; writers: string[] }[]
  /** One answer that settles many songs: a name under two spellings, a DSP name that is no writer, one company under two names */
  wins: { key: string; kind: 'name' | 'writer' | 'publisher'; songs: number; examples: string[]; a?: string; b?: string; name?: string }[]
}
export interface StepDecision { choice: string; data: { keep?: number | string; row?: number; rows?: number[] }; by?: 'app' | 'you' }
export interface Step3Line { row: number; title: string; film: string; codes: string[]; why: string[] }
export interface Step3 {
  counts: { works: number; matched: number; review: number; review_open: number; amend: number; register: number; on_screen_amend: number; on_screen_register: number; waiting: number; iprs_only: number }
  review: { key: string; title: string; reason: string; records: SongRecord[]; decision: { row?: number; none?: boolean } | null }[]
  amend: (Step3Line & { detail: string[]; records: SongRecord[] })[]
  register: (Step3Line & { record: SongRecord })[]
  iprs_only: { key: string; title: string; record: SongRecord; not_ours: boolean }[]
  matched: Step3Line[]
}
export interface StepsPayload {
  files: {
    lnv: MasterInfo | null; dsp: DspInfo | null
    iprs: { name: string; uploaded_at: string; run: number; report_date: string | null; works: number | null } | null
  }
  run: number | null; source: string
  counts: { '1': Step1['counts'] | null; '3': Step3['counts'] | null }
  step: Step1 | Step3 | null
}
