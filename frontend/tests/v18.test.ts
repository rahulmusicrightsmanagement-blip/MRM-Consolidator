// v1.8.0: the ISRC first – the main version's ISRC is the exact match, ONE row in the LNV; three sections (Exact match ·
// Possible match · Other version) the reviewer moves a match between; the singer and production shown; stage names as PA.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaseRecord, ReviewCase, Step1 } from '../src/types'
import { NO_PENDING, checkedIn, chooseClass, chooseSoloClass, classesNow, factsOfGroup, familiesOf, familyFacts, gChecked, pendingItems, progressOf, toCheck } from '../src/pages/client/Families'
import { companyWords, defaultClass, factsOf } from '../src/pages/client/matchModel'
import { fieldChoices } from '../src/pages/client/fieldModel'
import { autoAlternative } from '../src/pages/client/editModel'
import { EACH, listCount, sheetOf } from '../src/pages/client/lists'

const rec = (f: Record<string, string | string[]>, x: Partial<CaseRecord> = {}): CaseRecord => ({ src: 'Muso', ref: 'r', fields: f, ...x } as CaseRecord)
const lnv = (n: number, f: Record<string, string | string[]>, level: 'exact' | 'possible' = 'possible'): CaseRecord =>
  rec(f, { src: 'LNV', ref: `Row ${n}`, row: n, check: { writers: 'same', publisher: 'same', level } })
const MAIN = 'INAA10000001'
let id = 500
/** "Maula" (ISRC MAIN, singers S1, S2): the LNV has it as row 3 and – the same ISRC – as "Maula - Lofi" row 7 (singer S2);
 *  row 9 is another ISRC; the lofi version recording is in the LNV as row 12; an unplugged version has no LNV row. */
function maula(over: Partial<ReviewCase> = {}): ReviewCase {
  const main = rec({ Title: 'Maula', ISRC: [MAIN], Singer: ['S1', 'S2'], Label: 'Saregama' }, { id: ++id, in: true, part: 'original' })
  const unplugged = rec({ Title: 'Maula - Unplugged', ISRC: ['INAA10000003'] }, { id: ++id, in: true, part: 'version', version: 'Unplugged / Acoustic' })
  const lofi = rec({ Title: 'Maula - Lofi', ISRC: ['INAA10000002'] }, { id: ++id, in: true, part: 'version', version: 'Lofi', lnv_row: 12 })
  return {
    id: 'A', kind: 'check', title: 'Maula', why: '', family: 'maula', merge: null, muso: [main, lofi, unplugged],
    lnv: [lnv(3, { Title: 'Maula', ISRC: [MAIN], Singer: ['S1'], Label: 'Saregama India Ltd', 'Alternate title': 'Old' }, 'exact'),
      lnv(7, { Title: 'Maula - Lofi', ISRC: [MAIN], Singer: ['S2'], Publisher: ['Pub B'] }, 'exact'),
      lnv(9, { Title: 'Maula 2', ISRC: ['INXX99999999'], Singer: ['Z'], Label: 'T-Series' })],
    in_lnv: [{ key: 'version:L', type: 'Lofi', row: 12, muso: lofi, lnv: lnv(12, { Title: 'Maula Lofi', ISRC: ['INAA10000002'] }), isrc: true, album: true, year: true, answer: null }],
    answer: { song: 'A', choice: 'same', rows: [3, 7], by: 'app' }, done: true, auto: true, new_row: null, updates: [], ...over,
  } as ReviewCase
}
const f0 = (d: Step1) => familiesOf(d.cases)[0]
const step = (cases: ReviewCase[], over: Partial<Step1> = {}) => ({ source: 'Muso', cases, picks: {}, titles: {}, lnv_only: [], typed: [], ...over } as unknown as Step1)

test('the ISRC decides: the main version’s ISRC is an exact match – a lofi title or another singer too', () => {
  assert.equal(defaultClass([MAIN], [MAIN], false), 'exact')
  assert.equal(defaultClass(['X'], [MAIN], false), 'possible')
  assert.equal(defaultClass(['X'], [MAIN], true), 'version')
  assert.equal(defaultClass([MAIN], [MAIN], true), 'exact')   // a version row with the main version's ISRC: one recording
  const f = familiesOf([maula()])[0]
  assert.deepEqual([f.exact.map((g) => g.rows[0]), f.possible.map((g) => g.rows[0]), f.version.map((g) => g.rows[0]), f.solos.map((x) => x.r.fields.Title)],
    [[3, 7], [9], [12], ['Maula - Unplugged']])
  // the singer is shown, never deciding: row 7 has another singer and is exact all the same
  assert.deepEqual(factsOfGroup(f, f.exact[1]), { isrc: true, singer: true, production: null })
  assert.deepEqual(factsOf(lnv(1, { Singer: ['Q'], ISRC: [MAIN] }), [f.main]), { isrc: true, singer: false, production: null })
  assert.deepEqual(factsOfGroup(f, f.possible[0]), { isrc: false, singer: false, production: false })
  assert.deepEqual(familyFacts(f), { isrc: true, singer: true, production: true })
  assert.ok(companyWords('Saregama India Ltd').has('saregama') && companyWords('T-Series').has('super') && companyWords('Super Cassettes Industries Ltd').has('super'))
})

test('the app’s exact match waits for the reviewer: Exact match checks it, another button moves it – checked', () => {
  const a = maula(), d = step([a]), f = familiesOf([a])[0]
  assert.deepEqual(progressOf(NO_PENDING, f), { total: 5, left: 5, done: 0, status: 'todo' })   // 3 · 7 · 9 · 12 · the unplugged one
  // checked where it is
  const p1 = chooseClass(NO_PENDING, d, f.exact[0], 'exact')
  const f1 = familiesOf([a], [], [], classesNow(d, p1))[0]
  assert.ok(gChecked(p1, f1.exact[0]) && !gChecked(p1, f1.exact[1]))
  assert.deepEqual([checkedIn(p1, f1), toCheck(p1, f1)], [1, 4])
  // moved: row 7 is a version of the song after all – it leaves Exact match, checked
  const p2 = chooseClass(p1, d, f1.exact[1], 'version')
  const f2 = familiesOf([a], [], [], classesNow(d, p2))[0]
  assert.deepEqual([f2.exact.map((g) => g.rows[0]), f2.version.map((g) => g.rows[0])], [[3], [7, 12]])
  assert.ok(f2.version[0].chosen && f2.version[0].def === 'exact')
  // a possible match moved to Exact match: ticked (the same song) and checked
  const p3 = chooseClass(p2, d, f2.possible[0], 'exact')
  const items = pendingItems(p3, d)
  assert.deepEqual(items.filter((x) => x.key.startsWith('class:')), [{ key: 'class:3', choice: 'exact' }, { key: 'class:7', choice: 'version' }, { key: 'class:9', choice: 'exact' }])
  assert.deepEqual(items.find((x) => x.key === 'link:A')!.data!.rows, [3, 7, 9])
  // the version beside no LNV row: moved to Exact match – no row of its own (the server's export plan)
  const x = f2.solos[0]
  assert.deepEqual(pendingItems(chooseSoloClass(NO_PENDING, d, x, 'exact'), d), [{ key: `class:m${x.r.id}`, choice: 'exact' }])
  // saved: the server sends the classes back – the same sections, checked
  const f4 = familiesOf([a], [], [], { 'class:3': 'exact', 'class:7': 'version' })[0]
  assert.deepEqual([f4.exact.length, f4.version.length, checkedIn(NO_PENDING, f4)], [1, 2, 2])
  // unchecked: back to the app's section, to check again
  const p5 = chooseClass(NO_PENDING, step([a], { classes: { 'class:7': 'version' } }), f4.version[0], null)
  assert.deepEqual(p5.cls, { 'class:7': null })
})

test('the exact match is one row: the values of every exact row offered, the other titles its alternative work name', () => {
  const f = familiesOf([maula()])[0]
  const [keep, other] = f.exact
  const merged = { ...keep, recs: [f.main, ...keep.recs, ...other.recs], entries: [...keep.entries, ...other.entries] }
  const fc = fieldChoices('Publisher', merged, undefined, 'Muso', undefined, [other.lnv])
  assert.deepEqual(fc.rows, [{ row: 7, v: ['Pub B'] }])
  assert.deepEqual(fc.pickOf('l0'), ['Pub B'])
  assert.equal(fieldChoices('Publisher', merged, ['Pub B'], 'Muso', undefined, [other.lnv]).mode, 'l0')
  assert.equal(fieldChoices('Publisher', merged, ['Pub B'], 'Muso', undefined, [other.lnv]).keep, 'lnv')
  // S1 kept: the lofi title (and the old name) in the alternative work name, a pipe between them
  assert.equal(autoAlternative('Maula', keep.lnv, merged.recs, [other.lnv]), 'Old | Maula - Lofi')
  assert.equal(autoAlternative('Maula - Lofi', keep.lnv, merged.recs, [other.lnv]), 'Old | Maula')
})

test('the lists: Other versions has its own, and every match says its section', () => {
  const a = maula(), d = step([a])
  const x = { families: familiesOf(d.cases), loose: [], newRows: [], deleted: [], isDone: () => true, d, p: NO_PENDING }
  for (const k of EACH) { const s = sheetOf(x, k); assert.equal(s.rows.length, listCount(x, k), k) }
  // the version beside no LNV row is listed in its section too
  assert.deepEqual(['exact', 'possible', 'version'].map((k) => listCount(x, k as 'exact')), [2, 1, 2])
  assert.deepEqual(sheetOf(x, 'version').rows.map((r) => [r[2], r[3], r[4]]), [['Other version', 'Left to check', 12], ['Other version', 'Left to check', 'new row']])
  // checked: under Checked matches – every match and version checked is in the lists
  const fs = familiesOf(d.cases, [], [], { [f0(d).solos[0].key]: 'version' })
  const y = { ...x, families: fs }
  assert.deepEqual([listCount(y, 'done'), listCount(y, 'todo')], [1, 4])
  assert.deepEqual(sheetOf(y, 'done').rows.map((r) => [r[2], r[3], r[6]]), [['Other version', 'Checked', 'Maula - Unplugged']])
})
