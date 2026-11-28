/** v1.6 – hints, what's new, add a song, the change log's words, the Excel lists, counts in step. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { CaseRecord, ReviewCase, Step1, TypedSong } from '../src/types'
import { HINT_MAX, hintFor, shorten } from '../src/lib/hints'
import { POINTS, releases } from '../src/lib/whatsNew'
import { blankSong, addItems, homeOf, picksFor, problems } from '../src/pages/client/addSongModel'
import { logContext, withLog } from '../src/pages/client/changeLog'
import { EACH, listCount, sheetOf, sheetsOf } from '../src/pages/client/lists'
import { NO_PENDING, checkedIn, chooseClass, classesNow, familiesOf, inFamilies, pendingItems, tickGroup, toCheck } from '../src/pages/client/Families'
import { isDeleted, isNewRow, itemsOf, draftOf } from '../src/pages/client/reviewModel'

const root = process.cwd()
const rec = (f: Record<string, string | string[]>, x: Partial<CaseRecord> = {}): CaseRecord => ({ src: 'Muso', ref: 'r', fields: f, ...x } as CaseRecord)
const row = (n: number, title: string, level: 'exact' | 'possible' = 'possible', via?: number): CaseRecord =>
  rec({ Title: title, ISRC: [`INH10051${String(1000 + n)}`] }, { src: 'LNV', row: n, check: { writers: 'same', publisher: 'same', level, via } })
let id = 0
const song = (title: string, key: string, family: string, lnv: CaseRecord[], over: Partial<ReviewCase> = {}): ReviewCase => ({
  id: key, kind: 'check', title, why: '', family, merge: null, lnv,
  // v1.8.0: an exact match holds the main version's ISRC
  muso: [rec({ Title: title, Singer: ['S'], ISRC: lnv.filter((l) => l.check?.level === 'exact').flatMap((l) => l.fields.ISRC as string[]) }, { id: ++id, in: true, part: 'original' })],
  answer: { song: key, choice: null, rows: [], by: null }, done: false, new_row: null, updates: [], ...over })
const step = (cases: ReviewCase[], typed: TypedSong[] = []) => ({ source: 'Muso', cases, picks: {}, titles: {}, lnv_only: [{ row: 99, title: 'Z', film: '', year: '', writers: ['A'] }], typed } as unknown as Step1)
const typedSong = (family: string): TypedSong => ({ key: 'song:1', family, to: 'A', to_title: 'Alpha', rows: [], add: null, record: rec({ Title: 'T', ISRC: ['X'] }),
  data: { ...blankSong('A', 'Alpha'), title: 'T', album: 'Al', isrc: 'INH100510220', links: ['https://x.y/z'] } })

test('every hint is short; the marks on a match say what they mean, right and wrong', () => {
  const h = (text: string, bad = false, x = {}) => hintFor({ text, bad, tag: 'SPAN', cls: '', ...x })
  assert.match(h('Other ISRC', true)!, /ISRC codes differ/)
  assert.match(h('Same recording')!, /agree/)
  assert.match(h('Same recording', true)!, /Not the same recording/)
  assert.match(h('Same work', true)!, /Not the same work/)
  assert.match(h('Exact match : 1')!, /agree with an LNV row/)
  assert.match(h('Possible 4')!, /please check/)
  assert.match(h('To check : 5')!, /tick/)
  assert.match(h('Keep: IPI List')!, /real name/)
  assert.match(h('Keep: Muso')!, /other sheet/)
  assert.match(h('Delete song', false, { tag: 'BUTTON' })!, /Leave this song out/)
  assert.match(h('Banjaara', false, { tag: 'BUTTON', title: 'Everything Muso holds for it' })!, /Everything Muso/)
  assert.match(h('', false, { tag: 'INPUT', placeholder: 'Search a client' })!, /Search a client/)
  assert.equal(h('Banjaara'), null)   // plain text has nothing to explain
  for (const t of ['Other ISRC', 'Same work', 'Not in the LNV', 'Map to another song…', 'Only LNV row 81 is not it', 'Mark as completed', 'v1.6.0']) assert.ok(h(t, true, { tag: 'BUTTON' })!.length <= HINT_MAX, t)
  assert.ok(shorten('A very long explanation that goes on, and on. And then there is more of it that nobody reads in two lines at all.').length <= HINT_MAX)
})

test("what's new: this version's points are short, every version of the changelog is listed", () => {
  const version = readFileSync(`${root}/../VERSION`, 'utf8').trim()
  const all = releases(readFileSync(`${root}/../CHANGELOG.md`, 'utf8'))
  assert.equal(all[0].version, version)
  assert.ok(POINTS[version]?.length, 'write the points of this version in lib/whatsNew.ts')
  assert.ok(all.length > 20 && all.every((r) => r.points.length))
  assert.ok(Object.values(POINTS).flat().every((t) => t.length <= 100))
})

test('counts in step: one tick is one less to check and one more checked, before and after the save', () => {
  const a = song('Alpha', 'A', 'alpha', [row(80, 'Alpha'), row(81, 'Alpha Gujarati')])
  const f = familiesOf([a])[0]
  assert.deepEqual([checkedIn(NO_PENDING, f), toCheck(NO_PENDING, f)], [0, 2])
  // v2.0: a match is checked when it is put in a section (Original here) – it is linked with it
  const p = chooseClass(NO_PENDING, step([a]), f.todo[0], 'exact')
  const f1 = familiesOf([a], [], [], classesNow(step([a]), p))[0]
  assert.deepEqual([checkedIn(p, f1), toCheck(p, f1)], [1, 1])
  const link = pendingItems(p, step([a])).find((x) => x.key === 'link:A')
  assert.deepEqual(link, { key: 'link:A', choice: 'same', data: { rows: [80], also: [81] } })
  // as the server sends it back
  const saved = { ...a, done: true, answer: { song: 'A', choice: 'same', rows: [80], also: [81], by: 'you' as const } }
  const f2 = familiesOf([saved], [], [], { 'class:80': 'exact' })[0]
  assert.deepEqual([checkedIn(NO_PENDING, f2), toCheck(NO_PENDING, f2), f2.groups.length], [1, 1, 2])
  // a tick alone (a value kept) links it, it does not check it: only a section does
  const both = tickGroup(NO_PENDING, f2.todo[0], true, {})
  assert.deepEqual(pendingItems(both, step([saved])).find((x) => x.key === 'link:A')!.data, { rows: [80, 81] })
  assert.equal(toCheck(both, f2), 1)
  // an answer from an earlier version keeps its one row
  assert.equal(familiesOf([{ ...saved, answer: { ...saved.answer, also: undefined } }])[0].groups.length, 1)
  assert.deepEqual(itemsOf(saved, { ...draftOf(saved), rows: [80] }).find((x) => x.key === 'link:A')!.data, { rows: [80], also: [81] })
})

test('a song chosen from the sheet joins: its match is to check under the song it joined', () => {
  const a = song('Alpha', 'A', 'alpha', [row(1, 'Alpha', 'exact')]), b = song('Beta', 'B', 'beta', [row(2, 'Beta')]), c = song('Gamma', 'C', 'gamma', [])
  const d = step([a, b, c])
  const fs = familiesOf(d.cases), f = fs.find((x) => x.title === 'Alpha')!
  const picks = picksFor(f, fs, [c], NO_PENDING)
  assert.deepEqual(picks.map((x) => [x.title, x.kind, x.rows]), [['Beta', 'possible', [2]], ['Gamma', 'new', []]])
  assert.equal(homeOf(f)!.id, 'A')
  const items = addItems(picks[0], f, d)
  assert.deepEqual(items.find((x) => x.key === 'family:B'), { key: 'family:B', choice: 'join', data: { to: 'A', title: 'Alpha', from: 'Beta' } })
  assert.deepEqual(items.find((x) => x.key === 'link:B'), { key: 'link:B', choice: 'same', data: { rows: [2] } })
  assert.deepEqual(addItems(picks[1], f, d).map((x) => [x.key, x.choice, x.data!.to]), [[`map:${c.muso[0].id}`, 'join', a.muso[0].id]])
  const tot = (xs: ReviewCase[]) => familiesOf(xs).reduce((t, x) => [t[0] + toCheck(NO_PENDING, x), t[1] + checkedIn(NO_PENDING, x)], [0, 0])
  const after = [a, { ...b, family: 'alpha', joined: { to: 'A', title: 'Alpha', from: 'Beta' }, done: true, answer: { song: 'B', choice: 'same', rows: [2], by: 'you' as const } }, c]
  assert.deepEqual([tot(d.cases), tot(after)], [[2, 0], [2, 0]])   // v2.0: to check there – Original or Other version
  const g = familiesOf(after)[0]
  assert.equal(g.main.fields.Title, 'Alpha')   // an added song never becomes the main version
  assert.equal(g.groups.length, 2)
  // a song of the name itself is never offered
  assert.equal(picksFor(g, familiesOf(after), [], NO_PENDING).length, 0)
})

test('a typed song is checked, and listed under New row', () => {
  const a = song('Alpha', 'A', 'alpha', [row(1, 'Alpha', 'exact')])
  const t = typedSong('alpha')
  const f = familiesOf([a], [t])[0]
  assert.deepEqual([checkedIn(NO_PENDING, f), toCheck(NO_PENDING, f)], [1, 1])
})

test('a song typed: what is required', () => {
  const t = blankSong('A', 'Alpha')
  assert.deepEqual(Object.keys(problems(t)).sort(), ['album', 'composers', 'isrc', 'links', 'title'])
  const ok = { ...t, title: 'T', album: 'A', isrc: 'in-h10-05-10220', links: ['https://open.spotify.com/track/1', ''], people: { ...t.people, composers: [{ name: 'X', ipi: '513185379' }] } }
  assert.deepEqual(problems(ok), {})
  assert.ok(problems({ ...ok, isrc: '12' }).isrc && problems({ ...ok, links: ['spotify'] }).links)
  assert.match(problems({ ...ok, people: { ...ok.people, authors: [{ name: 'Y', ipi: '' }] } }).authors, /CAE \/ IPI number is required/)
  assert.deepEqual(problems({ ...ok, people: { ...ok.people, singers: [{ name: 'Y', ipi: '' }] } }), {})
  assert.ok(problems({ ...ok, people: { ...ok.people, composers: [{ name: 'X', ipi: '513185379', perf: '120' }] } }).composers)
})

test('the change log says what was done, and to which songs', () => {
  const a = song('Alpha', 'A', 'alpha', [row(1, 'Alpha', 'exact'), row(5, 'Alpha 2')]), b = song('Beta', 'B', 'beta', [row(2, 'Beta')])
  const d = step([a, b], [typedSong('alpha')])
  const fams = familiesOf(d.cases, d.typed)
  const x = logContext(d, new Map(fams.flatMap((f) => f.cases.map((c) => [c.id, f] as const))))
  const log = (...items: Parameters<typeof withLog>[0]) => withLog(items, x).map((i) => i.log!)
  assert.deepEqual(log({ key: 'link:A', choice: 'same', data: { rows: [1] } })[0], { group: 'answer:A', songs: [{ key: 'f:alpha', title: 'Alpha' }], text: 'Same song as LNV row 1', minor: false })
  const del = log({ key: 'link:A', choice: 'none' }, { key: 'missing:A', choice: 'deleted' })
  assert.deepEqual(del.map((l) => [l.text, l.minor, l.group]), [['Not linked to an LNV row', true, 'answer:A'], ['Deleted', false, 'answer:A']])
  const move = log({ key: `map:${a.muso[0].id}`, choice: 'join', data: { to: b.muso[0].id!, title: 'Beta', from: 'Alpha' } })[0]
  assert.equal(move.text, '“Alpha” moved from “Alpha” to “Beta”')
  assert.deepEqual(move.songs!.map((s) => s.title), ['Alpha', 'Beta'])   // listed under both
  assert.equal(log({ key: 'family:B', choice: 'join', data: { to: 'A', title: 'Alpha' } })[0].text, '“Beta” added to “Alpha”')
  assert.equal(log({ key: 'off:A', choice: 'rows', data: { rows: [5] } })[0].text, 'LNV row 5 is not this song')
  assert.equal(log({ key: 'pick:1:Composer', choice: 'ipi', data: { value: ['Ram Krishna'] } })[0].text, 'Composer of LNV row 1: the IPI List’s “Ram Krishna”')
  assert.equal(log({ key: 'song:1', choice: null })[0].text, 'Typed song “T” removed')
  assert.equal(log({ key: 'name:a|b', choice: 'same', data: { a: 'A', b: 'B' } })[0].text, '“A” and “B”: one person')
})

test('the Excel lists hold exactly the rows their counts count', () => {
  const a = song('Alpha', 'A', 'alpha', [row(1, 'Alpha', 'exact'), row(5, 'Alpha 2')], { done: true, answer: { song: 'A', choice: 'same', rows: [1], also: [5], by: 'you' } })
  const n = song('New', 'N', 'new', [], { kind: 'missing' }), add = song('Add', 'D', 'add', [], { kind: 'missing', done: true, answer: { song: 'D', choice: 'add', by: 'you' } })
  const gone = song('Gone', 'G', 'gone', [], { done: true, answer: { song: 'G', choice: 'deleted', by: 'you' }, was: [row(7, 'Gone')] })
  const d = step([a, n, add, gone], [typedSong('alpha')])
  const x = { families: familiesOf(d.cases, d.typed), loose: d.cases.filter((c) => !inFamilies(c) && !isNewRow(c) && !isDeleted(c)), newRows: d.cases.filter(isNewRow), deleted: d.cases.filter(isDeleted), isDone: (c: ReviewCase) => c.done, d, p: NO_PENDING }
  // v1.7: song status first, not a match after the checked ones · v2.0: to check, Original, other versions, deleted matches
  assert.deepEqual(EACH.map((k) => listCount(x, k)), [1, 2, 0, 0, 0, 1, 0, 1, 1, 2, 1, 1])
  for (const k of EACH) { const s = sheetOf(x, k); assert.equal(s.rows.length, listCount(x, k), k); assert.ok(s.rows.every((r) => r.length === s.header.length), k) }
  assert.equal(sheetsOf(x, 'all').length, EACH.length)
  const s = sheetOf(x, 'deleted')
  assert.deepEqual(s.rows[0].slice(0, 2).concat(s.rows[0][s.header.indexOf('Was LNV row')]), ['Gone', 1, '7'])
})

test('remarks: kept by ISRC, one for all recordings of a song, shown mixed when they differ', async () => {
  const { remarkItems, remarkKey, remarkOf } = await import('../src/pages/client/remarkModel')
  const a = rec({ ISRC: ['INA'] }, { id: 1 }), b = rec({ ISRC: [] }, { id: 2 })
  assert.deepEqual([remarkKey(a), remarkKey(b)], ['INA', '#2'])
  const R = { id: 5, name: 'Adaptation', help: '' }
  assert.deepEqual(remarkItems([a, b, a], R), [{ key: 'remark:INA', choice: 'set', data: { remark: 5, value: 'Adaptation' } }, { key: 'remark:#2', choice: 'set', data: { remark: 5, value: 'Adaptation' } }])
  assert.deepEqual(remarkItems([a], null), [{ key: 'remark:INA', choice: null }])
  const d = { remarks: { INA: { id: 5, name: 'Adaptation' } } } as unknown as Step1
  assert.deepEqual([remarkOf(d, [a]), remarkOf(d, [a, b]), remarkOf(d, [b])], [{ id: 5, name: 'Adaptation' }, 'mixed', null])
})

test('map to an existing ISRC / song: both lists, exact and possible, never itself', async () => {
  const { mapItems, spotsFor } = await import('../src/pages/client/remarkModel')
  const a = song('Alpha', 'A', 'alpha', [row(1, 'Alpha LNV', 'exact')]), b = song('Beta', 'B', 'beta', [row(2, 'Beta')]), me = song('Mine', 'M', 'mine', [], { kind: 'missing' })
  a.muso.push(rec({ Title: 'Alpha Lofi', ISRC: ['INL'] }, { id: 900, in: true, part: 'version', version: 'Lofi' }))
  const fams = familiesOf([a, b, me])
  const s = spotsFor(me, fams, NO_PENDING)
  assert.deepEqual(s.map((x) => [x.title, x.from, x.match, x.row]), [['Alpha', 'muso', 'exact', 1], ['Alpha LNV', 'lnv', 'exact', 1], ['Alpha Lofi', 'muso', 'exact', 1], ['Beta', 'lnv', 'possible', 2], ['Beta', 'muso', 'possible', 2]])
  assert.ok(s.every((x) => x.to === a.muso[0].id || x.to === b.muso[0].id))
  assert.equal(spotsFor(b, fams, NO_PENDING).some((x) => x.c.id === 'B'), false)
  // the LNV row chosen is kept with its title: the new row names it as its original
  assert.deepEqual(mapItems(me, me.muso, s[0]), [{ key: `map:${me.muso[0].id}`, choice: 'join', data: { to: a.muso[0].id, row: 1, title: 'Alpha LNV', from: 'Mine' } }])
  const d = step([a, b, me])
  const x = logContext(d, new Map(fams.flatMap((f) => f.cases.map((c) => [c.id, f] as const))))
  const key = `remark:#${me.muso[0].id}`
  const logs = withLog([...mapItems(me, me.muso, s[0]), { key, choice: 'set', data: { value: 'Adaptation' } }], x).map((i) => i.log!)
  assert.equal(logs[0].group, logs[1].group)   // one change: mapped, with its remark
  assert.deepEqual(logs[1].songs!.map((y) => y.title), ['Mine', 'Alpha'])
  assert.equal(logs[1].text, 'Remark of “Mine”: Adaptation')
})
