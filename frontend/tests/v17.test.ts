/** v1.7 – alternative work name, ISRCs with pipes, release dates, links and Muso data edited, matches kept until all are
 *  answered, status of songs and matches, last updated. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaseRecord, MovedOut, ReviewCase, Step1 } from '../src/types'
import { autoAlternative, dateOf, editItem, isLink, isrcsOf, otherNames, pipe, rawOf, sameName, typedText, typedValue } from '../src/pages/client/editModel'
import { fieldChoices, keepText } from '../src/pages/client/fieldModel'
import { NO_PENDING, STATUS, checkedIn, familiesOf, newRowItems, pendingItems, progressOf, putBackItems, restOf, tickGroup, toCheck, turnDownItems } from '../src/pages/client/Families'
import type { Group } from '../src/pages/client/Families'
import { describe as describeChange, logContext, withLog } from '../src/pages/client/changeLog'
import { draftOf, itemsOf, pickItem } from '../src/pages/client/reviewModel'
import { remarkKey } from '../src/pages/client/remarkModel'
import { EACH, listCount, sheetOf } from '../src/pages/client/lists'
import { whenText } from '../src/pages/client/when'
import { HINT_MAX, hintFor } from '../src/lib/hints'

const rec = (f: Record<string, string | string[]>, x: Partial<CaseRecord> = {}): CaseRecord => ({ src: 'Muso', ref: 'r', fields: f, ...x } as CaseRecord)
const lnv = (n: number, f: Record<string, string | string[]>, x: Partial<CaseRecord> = {}): CaseRecord => rec(f, { src: 'LNV', ref: `Row ${n}`, row: n, check: { writers: 'same', publisher: 'same', level: 'possible' }, ...x })
let id = 100
const song = (title: string, key: string, rows: CaseRecord[], over: Partial<ReviewCase> = {}): ReviewCase => ({
  id: key, kind: 'check', title, why: '', family: title.toLowerCase(), merge: null, muso: [rec({ Title: title, ISRC: ['INAA19000001'] }, { id: ++id, in: true, part: 'original' })], lnv: rows,
  answer: { song: key, choice: null, rows: [], by: null }, done: false, new_row: null, updates: [], ...over })
const step = (cases: ReviewCase[], over: Partial<Step1> = {}) => ({ source: 'Muso', cases, picks: {}, titles: {}, lnv_only: [], typed: [], ...over } as unknown as Step1)
const group = (l: CaseRecord, recs: CaseRecord[]): Group => ({ key: 'exact:4', rows: [l.row!], entries: [], lnv: l, match: 'exact', recs, trs: recs } as unknown as Group)

// ---------- typed values

test('ISRCs: several in one text, each once, whatever stands between them', () => {
  for (const t of ['INAA19000001 | INAA19000002', 'inaa19000001,INAA19000002', 'IN-AA1-90-00001; INAA19000002', 'INAA19000001 INAA19000002 | INAA19000001'])
    assert.deepEqual(isrcsOf(t), { isrcs: ['INAA19000001', 'INAA19000002'], wrong: [] }, t)
  assert.deepEqual(isrcsOf('IN AA1 90 00001'), { isrcs: ['INAA19000001'], wrong: [] })
  assert.deepEqual(isrcsOf('INAA19000001 | nope').wrong, ['nope'])
  assert.equal(pipe(['A', 'B', 'A', '']), 'A | B')
  assert.equal(typedText('ISRC', ['A', 'B']), 'A | B')
  assert.equal(typedText('Singer', ['A', 'B']), 'A, B')
})

test('dates are day first, complete, and real', () => {
  for (const t of ['2013-05-08', '08-05-2013', '8/5/2013', '8 May 2013', 'May 8, 2013']) assert.equal(dateOf(t), '08-05-2013', t)
  for (const t of ['', '2013', '31-02-2013', '13-13-2013', 'soon', '05-2013']) assert.equal(dateOf(t), '', t)
  assert.equal(dateOf('05/28/2013'), '28-05-2013')
})

test('only web links: nothing that runs', () => {
  for (const t of ['https://youtu.be/x', 'http://a.b', 'https://open.spotify.com/track/1?si=2']) assert.ok(isLink(t), t)
  for (const t of ['javascript:alert(1)', 'data:text/html,x', 'ftp://a.b', '//a.b', 'https://a', 'https://a.b/ c', 'https://a.b/<x>', 'vbscript:x', 'www.a.b', '']) assert.ok(!isLink(t), t)
})

test('a typed value is tidied, or says what is wrong', () => {
  assert.deepEqual(typedValue('Lyricist', ' A,  B ; A '), { v: ['A', 'B'] })
  assert.deepEqual(typedValue('ISRC', 'inaa19000001|INAA19000001'), { v: ['INAA19000001'] })
  assert.ok(typedValue('ISRC', 'INAA1').error)
  assert.deepEqual(typedValue('Release date', '8 May 2013'), { v: ['08-05-2013'] })
  assert.ok(typedValue('Release date', '2013').error)
  assert.ok(typedValue('Year', '13').error)
  assert.ok(typedValue('Link', 'javascript:alert(1)').error)
  assert.deepEqual(typedValue('Title', '  A   B '), { v: ['A B'] })
  assert.deepEqual(typedValue('Title', '   '), { v: [] })
})

// ---------- 5 the alternative work name

test('5 the work name that is not kept is the alternative', () => {
  const l = lnv(4, { Title: 'Dil Ki Baat', 'Alternate title': 'Old Name' }), m = rec({ Title: 'Dil Ki Baat (From "Film")' })
  assert.equal(autoAlternative('Dil Ki Baat', l, [m]), 'Old Name; Dil Ki Baat (From "Film")')            // the LNV's name kept
  assert.equal(autoAlternative('Dil Ki Baat (From "Film")', l, [m]), 'Old Name; Dil Ki Baat')             // Muso's kept
  assert.equal(autoAlternative('Typed', l, [m]), 'Old Name; Dil Ki Baat; Dil Ki Baat (From "Film")')      // typed: both
  assert.equal(autoAlternative('Pyaar', lnv(1, { Title: 'Pyaar' }), [rec({ Title: 'PYAAR' })]), '')       // one name on both sides
  assert.equal(autoAlternative('A', lnv(1, { Title: 'A', 'Alternate title': 'B' }), [rec({ Title: 'b' })]), 'B')   // it has it already
  assert.ok(sameName('दिल', 'दिल') && !sameName('दिल', 'प्यार') && sameName('Veer - Zaara', 'veer-zaara'))
  assert.deepEqual(otherNames('A', 'a', 'B', 'b', '', 'C'), ['B', 'C'])
  const fc = fieldChoices('Alternate title', group(l, [m]), undefined, 'Muso', autoAlternative('Dil Ki Baat', l, [m]))
  assert.deepEqual([fc.def, fc.keep, keepText(fc.keep, 'Muso'), fc.now], ['auto', 'auto', 'Automatic', ['Old Name; Dil Ki Baat (From "Film")']])
  assert.equal(fc.pickOf('auto'), null)                        // nothing to save
  assert.deepEqual(fc.pickOf('lnv'), ['Old Name'])             // keep only the LNV's: an answer
  assert.equal(fieldChoices('Alternate title', group(l, [m]), 'Mine', 'Muso', 'x').keep, 'custom')
  const blank = fieldChoices('Alternate title', group(lnv(1, { Title: 'A' }), [rec({ Title: 'B' })]), [], 'Muso', 'B')
  assert.deepEqual([blank.mode, blank.now], ['blank', []])      // left blank on purpose
})

// ---------- 6 ISRCs

test('6 an ISRC cell gets every ISRC, each once – as the server says', () => {
  const l = lnv(4, { ISRC: ['INAA19000001'] }, { isrc_add: ['INAA19000002'] }), m = rec({ ISRC: ['INAA19000001'] })
  const fc = fieldChoices('ISRC', group(l, [m]), undefined, 'Muso')
  assert.deepEqual([fc.def, fc.keep, typedText('ISRC', fc.now)], ['all', 'all', 'INAA19000001 | INAA19000002'])
  assert.deepEqual([fc.pickOf('all'), fc.pickOf('lnv')], [null, ['INAA19000001']])
  // nothing to add: the LNV's · blank with one: Muso's · blank, but its ISRC is on another LNV row: stays blank
  assert.equal(fieldChoices('ISRC', group(lnv(4, { ISRC: ['X'] }, { isrc_add: [] }), [m]), undefined, 'Muso').def, 'lnv')
  assert.equal(fieldChoices('ISRC', group(lnv(4, { ISRC: [] }, { isrc_add: ['INAA19000001'] }), [m]), undefined, 'Muso').def, 'm0')
  assert.equal(fieldChoices('ISRC', group(lnv(4, { ISRC: [] }, { isrc_add: [] }), [m]), undefined, 'Muso').def, 'blank')
  assert.equal(fieldChoices('ISRC', group(lnv(4, { ISRC: [] }, { isrc_add: ['INAA19000001', 'INAA19000009'] }), [m]), undefined, 'Muso').def, 'all')
  // a cell with other text is never written over by itself
  assert.equal(fieldChoices('ISRC', group(lnv(4, { ISRC: [] }, { isrc_add: ['INAA19000001'], isrc_text: 'TITLE TRACK' }), [m]), undefined, 'Muso').def, 'blank')
  assert.equal(fieldChoices('ISRC', group(l, [m]), ['INAA19000001', 'INAA19000002'], 'Muso').mode, 'all')
  assert.equal(fieldChoices('ISRC', group(l, [m]), ['INAA19000007'], 'Muso').mode, 'custom')
})

// ---------- 7 release date · 9 link

test('7 a blank release date takes Muso’s in the LNV’s year; a year kept from an earlier version still fits', () => {
  const l = lnv(4, { Year: '1990', 'Release date': '' }, { date_add: '01-05-1990' }), a = rec({ Year: '2011', 'Release date': '09-07-2011' }), b = rec({ Year: '1990', 'Release date': '01-05-1990' })
  const fc = fieldChoices('Release date', group(l, [a, b]), undefined, 'Muso')
  assert.deepEqual([fc.def, fc.now], ['m1', ['01-05-1990']])
  assert.equal(fieldChoices('Release date', group(lnv(4, { 'Release date': '02-02-1990' }, { date_add: '' }), [a]), undefined, 'Muso').def, 'lnv')
  assert.deepEqual(fc.pickOf('blank'), [])
  assert.equal(fieldChoices('Year', group(lnv(4, { Year: '1985' }), [rec({ Year: '1990' })]), '1990-05-01', 'Muso').mode, 'm0')
})

test('9 the link: kept, Muso’s, another one typed, or left blank', () => {
  const l = lnv(4, { Link: 'https://open.spotify.com/track/AbC' }, { link_add: '' }), m = rec({ Link: 'https://open.spotify.com/track/abc' })
  const fc = fieldChoices('Link', group(l, [m]), undefined, 'Muso')
  assert.deepEqual([fc.def, fc.opts], ['lnv', [['https://open.spotify.com/track/abc']]])   // capital letters count in a track's id
  assert.equal(fieldChoices('Link', group(l, [m]), 'https://youtu.be/x', 'Muso').keep, 'custom')
  assert.equal(fieldChoices('Link', group(lnv(4, { Link: '' }, { link_add: 'https://open.spotify.com/track/abc' }), [m]), undefined, 'Muso').def, 'm0')
  assert.deepEqual(pickItem('pick:4:Link', 'https://youtu.be/x', [m], l), { key: 'pick:4:Link', choice: 'custom', data: { value: 'https://youtu.be/x' } })
  assert.deepEqual(pickItem('pick:4:Link', 'https://open.spotify.com/track/abc', [m], l).choice, 'muso')
  assert.deepEqual(pickItem('pick:4:Release date', [], [m], l), { key: 'pick:4:Release date', choice: 'lnv', data: { value: [] } })
})

// ---------- 8 the Muso data

test('8 a correction is saved, the file’s value stays known, and it can be taken back', () => {
  const r = rec({ Title: 'A', Lyricist: ['X'], ISRC: ['INAA19000001'], Link: 'https://a.b' }, { id: 7 })
  assert.deepEqual(editItem(r, 'Title', ['B']), { key: 'muso:7:Title', choice: 'set', data: { value: 'B' } })
  assert.deepEqual(editItem(r, 'Lyricist', ['X', 'Y']), { key: 'muso:7:Lyricist', choice: 'set', data: { value: ['X', 'Y'] } })
  assert.deepEqual(editItem(r, 'Title', ['A']), { key: 'muso:7:Title', choice: null })   // the sheet's own value
  assert.deepEqual(editItem(r, 'Title', null), { key: 'muso:7:Title', choice: null })
  const e = rec({ Title: 'B', ISRC: ['INAA19000009'], 'Release date': '01-01-2020' }, { id: 7, edited: { Title: 'A', ISRC: ['INAA19000001'], 'Release date': '05-05-1990' } })
  assert.deepEqual([rawOf(e, 'Title'), rawOf(e, 'Singer')], [['A'], []])
  assert.deepEqual(editItem(e, 'Title', ['A']), { key: 'muso:7:Title', choice: null })
  assert.equal(remarkKey(e), 'INAA19000001')   // its remark stays with it
})

test('8 a correction never changes the main version or the song name', () => {
  const a = song('Alpha', 'A', [lnv(1, { Title: 'Alpha' })])
  a.muso = [rec({ Title: 'Alpha', Year: '1990', 'Release date': '01-05-1990' }, { id: 1, in: true, part: 'original' }), rec({ Title: 'Alpha', Year: '2011', 'Release date': '09-07-2011' }, { id: 2, in: true, part: 'version' })]
  assert.equal(familiesOf([a])[0].main.id, 1)
  a.muso[0] = { ...a.muso[0], fields: { Title: 'Alpha - Remix', Year: '2030', 'Release date': '01-01-2030' }, edited: { Title: 'Alpha', Year: '1990', 'Release date': '01-05-1990' } }
  const f = familiesOf([a])[0]
  assert.deepEqual([f.main.id, f.id], [1, 'f:alpha'])
})

test('8 the change log says what was corrected, from what', () => {
  const a = song('Alpha', 'A', [lnv(1, { Title: 'Alpha' })])
  const d = step([a]), x = logContext(d, new Map(familiesOf([a]).flatMap((f) => f.cases.map((c) => [c.id, f] as const))))
  const it = editItem(a.muso[0], 'Title', ['Beta'])
  const log = describeChange(it, [it], x)
  assert.match(log.text, /Muso title of “Alpha” corrected: “Beta” \(file: “Alpha”\)/)
  assert.deepEqual(log.songs, [{ key: 'f:alpha', title: 'Alpha' }])
  assert.match(withLog([{ key: 'pick:1:Link', choice: 'custom', data: { value: 'https://youtu.be/x' } }], x)[0].log!.text, /Link of LNV row 1: typed “https/)
  assert.match(withLog([{ key: 'pick:1:Release date', choice: 'lnv', data: { value: [] } }], x)[0].log!.text, /left blank/)
  assert.match(withLog([{ key: 'off:A', choice: 'rows', data: { rows: [1], then: 'add' } }], x)[0].log!.text, /not this song – a new row if no other match is it/)
})

// ---------- 10 matches kept · 14 status

const six = () => {
  const ex = [1, 2, 3, 4].map((n) => lnv(n, { Title: 'Alpha', Year: String(1990 + n) }, { check: { writers: 'same', publisher: 'same', level: 'exact' } }))
  const po = [5, 6].map((n) => lnv(n, { Title: 'Alpha', Year: String(1990 + n) }))
  return song('Alpha', 'A', [...ex, ...po])
}

test('10 four exact and two possible: all six stay until the last is answered', () => {
  const a = six(), f = familiesOf([a])[0]
  assert.deepEqual([f.exact.length, f.possible.length, progressOf(NO_PENDING, f)], [4, 2, { total: 6, left: 6, done: 0, status: 'todo' }])
  // one ticked: five left, the link names the others as still to check
  const p = tickGroup(NO_PENDING, f.exact[0], true, {})
  assert.deepEqual([toCheck(p, f), progressOf(p, f).status], [5, 'part'])
  assert.deepEqual(pendingItems(p, step([a])).find((x) => x.key === 'link:A'), { key: 'link:A', choice: 'same', data: { rows: [1], also: [2, 3, 4, 5, 6] } })
  // as the server sends it back, with one of them turned down
  const b = { ...a, lnv: a.lnv.filter((r) => r.row !== 5), off: [5], off_lnv: [a.lnv[4]], done: true, answer: { song: 'A', choice: 'same', rows: [1], also: [2, 3, 4, 6], by: 'you' as const } }
  const g = familiesOf([b])[0]
  assert.deepEqual([g.exact.length, g.possible.length, g.out.map((o) => [o.rows[0], o.why, o.match])], [4, 1, [[5, 'off', 'possible']]])
  assert.deepEqual(progressOf(NO_PENDING, g), { total: 6, left: 4, done: 2, status: 'part' })
  // every one answered: still six on screen, and the song is done
  const all = { ...b, lnv: a.lnv.slice(0, 4), off: [5, 6], off_lnv: a.lnv.slice(4), answer: { ...b.answer, rows: [1, 2, 3, 4], also: undefined } }
  assert.deepEqual(progressOf(NO_PENDING, familiesOf([all])[0]), { total: 6, left: 0, done: 6, status: 'done' })
  assert.deepEqual(STATUS, { todo: 'Left to check', part: 'Partly checked', done: 'All checked' })
})

test('10 “Not a match – new row” answers one match; the song is a new row only after its last one', () => {
  const a = six(), f = familiesOf([a])[0], d = step([a])
  const one = newRowItems(f.possible[0], d)
  assert.deepEqual([one.waiting, one.items], [[1, 2, 3, 4, 6], [{ key: 'off:A', choice: 'rows', data: { rows: [5], then: 'add' } }]])
  assert.deepEqual(restOf(a, f.possible[0]), [1, 2, 3, 4, 6])
  // the last one: the whole song, with every row it was matched to
  const last = { ...a, lnv: [a.lnv[5]], off: [1, 2, 3, 4, 5], off_then: 'add' }
  const g = familiesOf([last])[0]
  const r = newRowItems(g.possible[0], step([last]))
  assert.deepEqual(r.waiting, [])
  assert.deepEqual(r.items.find((x) => x.key === 'link:A'), { key: 'link:A', choice: 'none', data: { rows: [6, 1, 2, 3, 4, 5] } })
  assert.deepEqual(r.items.filter((x) => ['missing:A', 'off:A'].includes(x.key)).map((x) => x.choice), ['add', null])
  // a linked row turned down is unlinked, the other stays
  const linked = { ...a, done: true, answer: { song: 'A', choice: 'same', rows: [1, 2], also: [3, 4, 5, 6], by: 'you' as const } }
  const h = familiesOf([linked])[0]
  const t = turnDownItems(linked, h.exact[0], null, step([linked]))
  assert.deepEqual(t.find((x) => x.key === 'off:A')!.data, { rows: [1] })
  assert.deepEqual(t.find((x) => x.key === 'link:A')!.data, { rows: [2], also: [3, 4, 5, 6] })
})

test('10 put back: the match is to check again', () => {
  const a = { ...six(), off: [5, 6], off_then: 'add' } as ReviewCase
  a.off_lnv = a.lnv.slice(4); a.lnv = a.lnv.slice(0, 4)
  const o = familiesOf([a])[0].out
  assert.deepEqual(putBackItems(o[0], step([a])), [{ key: 'off:A', choice: 'rows', data: { rows: [6], then: 'add' } }])
  assert.deepEqual(putBackItems(o[0], step([{ ...a, off: [5] }])).length, 1)
  const b = { ...a, done: true, answer: { song: 'A', choice: 'same', rows: [1], also: [2], by: 'you' as const } }
  assert.deepEqual(putBackItems(familiesOf([b])[0].out[1], step([b])).find((x) => x.key === 'link:A')!.data, { rows: [1], also: [2, 6] })
})

test('10 a song sent to a new row, deleted or mapped away stays shown under its name while the name has others', () => {
  const a = song('Alpha', 'A', [lnv(1, { Title: 'Alpha' })]), b = song('Alpha', 'B', [lnv(2, { Title: 'Alpha' })])
  const sent = { ...b, lnv: [], was: [lnv(2, { Title: 'Alpha' })], done: true, answer: { song: 'B', choice: 'add', rows: [], by: 'you' as const } }
  const f = familiesOf([a, sent])
  assert.deepEqual(f.map((x) => [x.id, x.cases.length, x.out.map((o) => [o.why, o.rows[0]])]), [['f:alpha', 1, [['new', 2]]]])
  assert.deepEqual(putBackItems(f[0].out[0], step([a, sent])).filter((x) => /^(link|missing):B$/.test(x.key)).map((x) => x.choice), [null, null])
  assert.deepEqual(familiesOf([a, { ...sent, answer: { ...sent.answer, choice: 'deleted' } }])[0].out.map((o) => o.why), ['deleted'])
  assert.deepEqual(familiesOf([a, { ...sent, answer: { ...sent.answer, by: 'app' as const } }])[0].out, [])   // the app's own proposal is no answer
  // the name's last song gone: nothing is pending, the name leaves the list
  assert.deepEqual(familiesOf([sent]), [])
  const moved: MovedOut[] = [{ id: 9, family: 'alpha', title: 'Alpha', to_title: 'Other', row: 7, muso: rec({ Title: 'Alpha' }, { id: 9 }), lnv: [lnv(3, { Title: 'Alpha' })] }]
  const m = familiesOf([a], [], moved)[0]
  assert.deepEqual(m.out.map((o) => [o.why, o.rows[0], o.text]), [['mapped', 3, 'Mapped to “Other” (LNV row 7)']])
  assert.deepEqual(putBackItems(m.out[0], step([a])), [{ key: 'map:9', choice: null }])
  assert.deepEqual(familiesOf([a], [], [{ ...moved[0], family: 'elsewhere' }])[0].out, [])
})

test('10 a match that lost its row to another recording is still to check', () => {
  const v = { key: 'version:X', type: 'Lofi', row: 8, muso: rec({ Title: 'Alpha Lofi' }, { id: 50 }), lnv: lnv(8, { Title: 'Alpha Lofi' }), isrc: false, album: false, year: false, answer: null, taken: '‘Beta’' }
  const f = familiesOf([song('Alpha', 'A', [lnv(1, { Title: 'Alpha' })], { in_lnv: [v] })])[0]
  assert.deepEqual([f.possible.map((g) => g.rows[0]), toCheck(NO_PENDING, f)], [[1, 8], 2])
  const none = familiesOf([song('Alpha', 'A', [lnv(1, { Title: 'Alpha' })], { in_lnv: [{ ...v, answer: 'none', taken: undefined }] })])[0]
  assert.deepEqual([none.possible.length, none.out.map((o) => [o.rows[0], o.version])], [1, [[8, 'version:X']]])
  assert.deepEqual(putBackItems(none.out[0], step([])), [{ key: 'version:X', choice: null }])
})

test('10 a song deleted or sent out keeps the rows turned down one by one, and they come back with it', () => {
  const a = { ...six(), off: [5] } as ReviewCase
  const del = itemsOf(a, { ...draftOf(a), choice: 'deleted', rows: [] })
  assert.deepEqual(del.find((x) => x.key === 'link:A')!.data!.rows, [1, 2, 3, 4, 5, 6])
  assert.deepEqual(del.find((x) => x.key === 'off:A'), { key: 'off:A', choice: null })
})

test('14 the lists count what they hold – status of every song and every match', () => {
  const a = { ...six(), lnv: six().lnv.filter((r) => r.row !== 5), off: [5], off_lnv: [six().lnv[4]], done: true, answer: { song: 'A', choice: 'same', rows: [1], also: [2, 3, 4, 6], by: 'you' as const } } as ReviewCase
  const b = song('Beta', 'B', [lnv(9, { Title: 'Beta' })])
  const c = song('Gamma', 'C', [lnv(10, { Title: 'Gamma' })], { done: true, answer: { song: 'C', choice: 'same', rows: [10], by: 'you' } })
  const d = step([a, b, c], { updates: { last: [], songs: { 'f:alpha': '2026-11-25T09:30:00+00:00' } } })
  const x = { families: familiesOf(d.cases), loose: [], newRows: [], deleted: [], isDone: () => false, d, p: NO_PENDING }
  for (const k of EACH) { const s = sheetOf(x, k); assert.equal(s.rows.length, listCount(x, k), k); assert.ok(s.rows.every((r) => r.length === s.header.length), k) }
  const st = sheetOf(x, 'status').rows
  assert.deepEqual(st.map((r) => r.slice(0, 6)), [['Alpha', 'Partly checked', 6, 1, 1, 4], ['Beta', 'Left to check', 1, 0, 0, 1], ['Gamma', 'All checked', 1, 1, 0, 0]])
  assert.match(String(st[0][8]), /2026/)
  assert.deepEqual(sheetOf(x, 'out').rows.map((r) => [r[0], r[3], r[4]]), [['Alpha', 'Not a match', 5]])
  const todo = sheetOf(x, 'todo')
  assert.ok(todo.rows.every((r) => r[todo.header.indexOf('Status')] === 'Left to check') && todo.rows.length === 5)
  assert.ok(todo.header.includes('Alternative work name – LNV keeps') && todo.header.includes('Release date – LNV keeps') && todo.header.includes('Link – LNV keeps'))
  assert.deepEqual([checkedIn(NO_PENDING, x.families[0])], [1])   // a match turned down is no checked match
})

test('11 when a song was saved, in words', () => {
  const now = new Date()
  assert.match(whenText(now.toISOString()), /^today, /)
  assert.match(whenText(new Date(now.getTime() - 24 * 3600 * 1000).toISOString()), /^yesterday, /)
  assert.match(whenText('2020-01-02T03:04:05Z'), /2020/)
  assert.equal(whenText('nonsense'), '')
})

test('every new label has a short hint of its own', () => {
  const h = (text: string, tag = 'BUTTON') => hintFor({ text, tag, cls: '' })
  for (const [t, re] of [['Left to check 0/6', /need your tick/], ['Partly checked 2/6', /still to check/], ['Not a match', /until all is checked/], ['Not a match : 1', /until all is checked/], ['Put back', /back/], ['Continue from here', /go on/],
    ['Last updated song', /last/], ['Still to answer', /answer it too/], ['New row, if no other match is it', /no other one/], ['Keep: All ISRCs', /None twice/], ['Keep: Automatic', /by itself/], ['Release date', /date/], ['Alternative work name', /other name/],
    ['Not a possible match', /wrong match/]] as const) {
    const x = h(t, t === 'Release date' || t === 'Alternative work name' ? 'TH' : 'BUTTON')
    assert.match(x ?? '', re, t)
    assert.ok(x!.length <= HINT_MAX, t)
  }
})
