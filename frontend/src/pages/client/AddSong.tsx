import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, Plus, Search, Trash2 } from 'lucide-react'
import { Drawer } from '../../components/ui'
import { ApiError, api } from '../../lib/api'
import type { CleanDecisionIn } from '../../lib/api'
import { useClient } from '../../lib/client'
import type { RemarkChoice, ReviewCase, SongForm, Step1, TypedData, TypedSong } from '../../types'
import { n, norm } from './Block'
import { GROUPS, addItems, blankPerson, blankSong, homeOf, isrcOf, picksFor, problems } from './addSongModel'
import type { Pick } from './addSongModel'
import type { Family, Pending } from './Families'
import { RemarkPick } from './MapTo'
import { remarkItems, remarkOf } from './remarkModel'

/** Add a song to the song on screen: chosen from the sheets – an exact or possible match of another song, or a song
 *  not in the LNV – or typed, with every field the client's LNV has. edit: a song typed earlier, to correct. */
export function AddSong({ f, families, loose, d, p, edit, commit, act, close, done }: {
  f: Family; families: Family[]; loose: ReviewCase[]; d: Step1; p: Pending; edit?: TypedSong
  commit: (items: CleanDecisionIn[]) => Promise<boolean>; act: (work: () => Promise<unknown>) => Promise<boolean>
  close: () => void; done: (text: string) => void
}) {
  const [tab, setTab] = useState<'sheet' | 'type'>(edit ? 'type' : 'sheet')
  return (
    <Drawer open onClose={close} title={edit ? <>Edit “{edit.data.title}”</> : <>Add a song to “{f.title}”</>}
      subtitle={<span className="muted">{edit ? 'A song you typed: it goes into the LNV as a new row.' : 'Choose it from the uploaded sheets, or type all its details.'}</span>}>
      {!edit && (
        <div className="rv-tabs as-tabs" role="tablist" aria-label="How to add the song">
          <button type="button" role="tab" aria-selected={tab === 'sheet'} className={tab === 'sheet' ? 'on' : ''} onClick={() => setTab('sheet')}>Choose from the sheet</button>
          <button type="button" role="tab" aria-selected={tab === 'type'} className={tab === 'type' ? 'on' : ''} onClick={() => setTab('type')}>Type all details</button>
        </div>
      )}
      {tab === 'sheet' ? <FromSheet f={f} families={families} loose={loose} d={d} p={p} commit={commit} close={close} done={done} />
        : <TypeSong f={f} edit={edit} commit={commit} act={act} close={close} done={done} />}
    </Drawer>
  )
}

const KINDS = [['all', 'All'], ['exact', 'Exact match'], ['possible', 'Possible match'], ['new', 'Not in the LNV']] as const

function FromSheet({ f, families, loose, d, p, commit, close, done }: {
  f: Family; families: Family[]; loose: ReviewCase[]; d: Step1; p: Pending
  commit: (items: CleanDecisionIn[]) => Promise<boolean>; close: () => void; done: (text: string) => void
}) {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>('all')
  const [picked, setPicked] = useState<Pick | null>(null)
  const [remark, setRemark] = useState<RemarkChoice | null | undefined>(undefined)   // a song not in the LNV: why it is mapped
  const [busy, setBusy] = useState(false)
  const all = useMemo(() => picksFor(f, families, loose, p), [f, families, loose, p])
  const found = useMemo(() => {
    const s = norm(q)
    return all.filter((x) => (kind === 'all' || x.kind === kind) && (!s || norm(`${x.title} ${x.from} ${x.c.title} ${x.film} ${x.writers} ${x.isrcs.join(' ')} ${x.rows.join(' ')}`).includes(s)))
  }, [all, q, kind])
  const add = async () => {
    if (!picked) return
    setBusy(true)
    const recs = picked.c.muso.filter((r) => r.in)
    const ok = await commit([...addItems(picked, f, d), ...(picked.kind === 'new' && remark !== undefined ? remarkItems(recs, remark) : [])])
    setBusy(false)
    if (ok) { done(`“${picked.title}” is added to “${f.title}”${picked.kind === 'new' ? '' : ' and checked'}`); close() }
  }
  const tag = (x: Pick) => <span className={`mp-match ${x.kind}`}>{x.kind === 'exact' ? 'Exact' : x.kind === 'possible' ? 'Possible' : 'Not in the LNV'}</span>
  if (picked) return (
    <div className="mp mp-ask">
      <button type="button" className="rv-text-btn" onClick={() => setPicked(null)}>← Back to the list</button>
      <div className="mp-target">{tag(picked)}{picked.rows.length > 0 && <span className="cv-badge lnv">LNV row{picked.rows.length > 1 ? 's' : ''} {picked.rows.join(', ')}</span>}
        <b>{picked.title}</b><small className="muted">{[picked.film, picked.writers, picked.isrcs[0] && `ISRC ${picked.isrcs.join(', ')}`].filter(Boolean).join(' · ')}</small></div>
      <h3>Add it to “{f.title}”?</h3>
      <ul className="as-what">
        {picked.kind === 'new'
          ? <><li>{picked.c.muso.filter((r) => r.in).length > 1 ? `Its ${picked.c.muso.filter((r) => r.in).length} recordings become versions` : 'It becomes a version'} of “{f.title}”, each with a new LNV row.</li><li>It leaves “Not in the LNV”.</li></>
          : <><li>It moves from “{picked.from}” to “{f.title}” and keeps its LNV row.</li>
            <li>{picked.checked ? 'It is checked already and stays checked.' : 'It is marked checked: one less to check, one more checked.'}</li></>}
        <li>Undo takes it back any time.</li>
      </ul>
      {picked.kind === 'new' && <div className="rm-line"><b>Remark</b><RemarkPick d={d} now={remark === undefined ? remarkOf(d, picked.c.muso.filter((r) => r.in)) : remark} pick={setRemark} /></div>}
      <div className="as-foot"><button type="button" className="btn primary" disabled={busy || !homeOf(f)} onClick={add}>{busy ? <span className="spinner small" /> : <Check size={15} />}Add to this song</button>
        <button type="button" className="btn ghost" onClick={() => setPicked(null)}>Choose another</button></div>
      {!homeOf(f) && <p className="cv-none">No song can be added here: every recording of this name was mapped from another song.</p>}
    </div>
  )
  return (
    <div className="mp">
      <label className="cs-search mp-search"><Search size={17} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a title, film, writer, ISRC or LNV row…" /></label>
      <div className="as-kinds" role="group" aria-label="From where">{KINDS.map(([id, label]) => (
        <button key={id} type="button" className={kind === id ? 'on' : ''} aria-pressed={kind === id} onClick={() => setKind(id)}>{label}<b>{n(id === 'all' ? all.length : all.filter((x) => x.kind === id).length)}</b></button>))}</div>
      <p className="muted mp-count">{n(found.length)} song{found.length === 1 ? '' : 's'}{found.length > 100 ? ' (first 100 – type to narrow)' : ''}</p>
      <div className="mp-list">
        {!found.length && <p className="cv-none">Nothing matches. Try fewer words – or type the song’s details.</p>}
        {found.slice(0, 100).map((x) => (
          <button key={x.key} type="button" className="mp-item" onClick={() => { setPicked(x); setRemark(undefined) }}>
            {tag(x)}{x.rows.length > 0 && <span className="cv-badge lnv">LNV row {x.rows.join(', ')}</span>}
            <span className="grow mp-text"><b>{x.title}</b><small className="muted">{[norm(x.from) !== norm(x.title) && `In “${x.from}”`, x.film, x.writers].filter(Boolean).join(' · ')}</small>
              {x.isrcs[0] && <small className="mp-isrc mono">ISRC {x.isrcs[0]}{x.isrcs.length > 1 ? ` +${x.isrcs.length - 1}` : ''}</small>}</span>
            {x.checked && <span className="as-checked"><Check size={13} />Checked</span>}<ChevronRight size={16} />
          </button>
        ))}
      </div>
    </div>
  )
}

function TypeSong({ f, edit, commit, act, close, done }: {
  f: Family; edit?: TypedSong; commit: (items: CleanDecisionIn[]) => Promise<boolean>; act: (work: () => Promise<unknown>) => Promise<boolean>
  close: () => void; done: (text: string) => void
}) {
  const { clientId } = useClient()
  const [form, setForm] = useState<SongForm | null>(null)
  const [failed, setFailed] = useState('')
  const [t, setT] = useState<TypedData>(() => {
    if (!edit) return blankSong(homeOf(f)?.answer.song ?? '', f.title)
    const b = blankSong(edit.data.to, edit.data.to_title)
    return { ...b, ...edit.data, links: edit.data.links.length ? edit.data.links : [''],
      people: Object.fromEntries(GROUPS.map((g) => [g.id, edit.data.people[g.id]?.length ? edit.data.people[g.id] : [blankPerson()]])) as TypedData['people'] }
  })
  const [tried, setTried] = useState(false)
  const [server, setServer] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.songForm(clientId).then(setForm).catch((e) => setFailed((e as Error).message)) }, [clientId])
  const wrong = { ...(tried ? problems(t) : {}), ...server }
  const put = (patch: Partial<TypedData>) => { setServer({}); setT((x) => ({ ...x, ...patch })) }
  const person = (g: keyof TypedData['people'], i: number, patch: object) => put({ people: { ...t.people, [g]: t.people[g].map((x, j) => (j === i ? { ...x, ...patch } : x)) } })
  /** A name the IPI / CAE list knows brings its number. */
  const lookup = async (g: keyof TypedData['people'], i: number) => {
    const x = t.people[g][i]
    if (!x.name.trim() || x.ipi.trim()) return
    const hit = await api.ipiLookup(x.name.trim()).catch(() => null)
    if (hit?.ipi) setT((y) => ({ ...y, people: { ...y.people, [g]: y.people[g].map((z, j) => (j === i && !z.ipi.trim() && z.name.trim() === x.name.trim() ? { ...z, ipi: hit.ipi } : z)) } }))
  }
  const save = async () => {
    setTried(true)
    if (Object.keys(problems(t)).length) { window.setTimeout(() => document.querySelector('.as-form .bad')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0); return }
    setBusy(true)
    let fields: Record<string, string> | undefined
    const ok = await commit([]) && await act(() => api.saveSong(clientId, { ...t, isrc: isrcOf(t.isrc) },
      { songs: [{ key: f.id, title: f.title }], text: edit ? `Typed song “${t.title}” corrected` : `Song typed and added: “${t.title}”` }, edit?.key)
      .catch((e) => { if (e instanceof ApiError && e.fields) fields = e.fields; throw e }))
    setBusy(false)
    if (ok) { done(edit ? `“${t.title}” is corrected` : `“${t.title}” is added to “${f.title}” – a new LNV row`); close() } else if (fields) setServer(fields)
  }
  const field = (k: 'title' | 'album' | 'isrc', label: string, ph: string) => (
    <label className={`as-f ${wrong[k] ? 'bad' : ''}`}><span>{label} <i className="as-req">required</i></span>
      <input value={t[k]} onChange={(e) => put({ [k]: e.target.value })} placeholder={ph} aria-label={label} aria-invalid={!!wrong[k]} />{wrong[k] && <small>{wrong[k]}</small>}</label>
  )
  if (failed) return <div className="alert bad">{failed}</div>
  if (!form) return <div className="loading"><span className="spinner" />Reading the LNV’s fields…</div>
  return (
    <form className="as-form" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
      <div className="as-grid">{field('title', 'Title', 'Song title')}{field('album', 'Album', 'Film / album')}{field('isrc', 'ISRC', 'e.g. INH100510220')}</div>
      <fieldset className={`as-set ${wrong.links ? 'bad' : ''}`}>
        <legend>Song links <i className="as-req">required</i></legend>
        {t.links.map((u, i) => (
          <div key={i} className="as-line"><input value={u} onChange={(e) => put({ links: t.links.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="https://open.spotify.com/… or any other platform" aria-label={`Song link ${i + 1}`} />
            {t.links.length > 1 && <button type="button" className="icon-btn" onClick={() => put({ links: t.links.filter((_, j) => j !== i) })} aria-label={`Remove link ${i + 1}`}><Trash2 size={15} /></button>}</div>
        ))}
        {wrong.links && <small>{wrong.links}</small>}
        <button type="button" className="rv-text-btn" onClick={() => put({ links: [...t.links, ''] })}><Plus size={14} />Add another link</button>
      </fieldset>
      {GROUPS.map((g) => (
        <fieldset key={g.id} className={`as-set ${wrong[g.id] ? 'bad' : ''}`}>
          <legend>{g.label}s {g.must ? <i className="as-req">CAE / IPI required</i> : <i className="as-opt">optional</i>}</legend>
          {t.people[g.id].map((x, i) => (
            <div key={i} className="as-line as-person">
              <input className="as-name" value={x.name} onChange={(e) => person(g.id, i, { name: e.target.value })} onBlur={() => void lookup(g.id, i)} placeholder={`${g.label} name`} aria-label={`${g.label} ${i + 1} name`} />
              <input className="mono" value={x.ipi} onChange={(e) => person(g.id, i, { ipi: e.target.value })} placeholder="CAE / IPI" aria-label={`${g.label} ${i + 1} CAE / IPI`} />
              <input value={x.joshua ?? ''} onChange={(e) => person(g.id, i, { joshua: e.target.value })} placeholder="Joshua ID" aria-label={`${g.label} ${i + 1} Joshua ID`} />
              <input value={x.perf ?? ''} onChange={(e) => person(g.id, i, { perf: e.target.value })} placeholder="Perf. %" aria-label={`${g.label} ${i + 1} performance share`} inputMode="decimal" />
              <input value={x.mech ?? ''} onChange={(e) => person(g.id, i, { mech: e.target.value })} placeholder="Mech. %" aria-label={`${g.label} ${i + 1} mechanical share`} inputMode="decimal" />
              <button type="button" className="icon-btn" disabled={t.people[g.id].length < 2} onClick={() => put({ people: { ...t.people, [g.id]: t.people[g.id].filter((_, j) => j !== i) } })} aria-label={`Remove ${g.label.toLowerCase()} ${i + 1}`}><Trash2 size={15} /></button>
            </div>
          ))}
          {wrong[g.id] && <small>{wrong[g.id]}</small>}
          {t.people[g.id].length < (form.slots[g.id] ?? 1) && <button type="button" className="rv-text-btn" onClick={() => put({ people: { ...t.people, [g.id]: [...t.people[g.id], blankPerson()] } })}><Plus size={14} />Add another {g.label.toLowerCase()}</button>}
        </fieldset>
      ))}
      <details className="as-more"><summary>Every other LNV field ({n(form.more.length)})</summary>
        <div className="as-grid">{form.more.map((m) => (
          <label key={m.key} className="as-f"><span>{m.label}</span><input value={t.more[m.key] ?? ''} onChange={(e) => put({ more: { ...t.more, [m.key]: e.target.value } })} aria-label={m.label} /></label>))}</div>
      </details>
      {Object.keys(wrong).length > 0 && <p className="as-wrong" role="alert">{n(Object.keys(wrong).length)} field{Object.keys(wrong).length > 1 ? 's need' : ' needs'} a look: {Object.values(wrong).join(' · ')}</p>}
      <div className="as-foot"><button type="submit" className="btn primary" disabled={busy}>{busy ? <span className="spinner small" /> : <Check size={15} />}{edit ? 'Save' : 'Add to this song'}</button>
        <button type="button" className="btn ghost" onClick={close}>Cancel</button></div>
    </form>
  )
}
