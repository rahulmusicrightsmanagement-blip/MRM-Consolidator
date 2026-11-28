// v1.8.0: the ISRC first, the singer and production shown, stage names as PA · v2.0.0: every match starts in To check
// against the main version; the reviewer puts it in Original (the first one put there is the song's ONE row in the LNV,
// the next ones its Alternative work name), Other version (a row of its own) or Deleted; checked through: completed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaseRecord, ReviewCase, Step1 } from '../src/types'
import { NO_PENDING, atNow, checkedIn, chooseClass, chooseSoloClass, classesNow, factsOfGroup, familiesOf, familyFacts, pendingItems, progressOf, toCheck } from '../src/pages/client/Families'
import { companyWords, defaultClass, factsOf, savedClass } from '../src/pages/client/matchModel'
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

const rows0 = (g: { rows: number[] }) => g.rows[0]

test('the ISRC suggests, it never decides: every match starts in To check', () => {
  assert.equal(defaultClass([MAIN], [MAIN], false), 'exact')
  assert.equal(defaultClass(['X'], [MAIN], false), null)
  assert.equal(defaultClass(['X'], [MAIN], true), 'version')
  assert.equal(defaultClass([MAIN], [MAIN], true), 'exact')   // a version row with the main version's ISRC: one recording
  assert.equal(savedClass('possible'), 'version')   // a v1.8 Possible match: a row of its own, as before
  const f = familiesOf([maula()])[0]
  assert.deepEqual([f.todo.map(rows0), f.todo.map((g) => g.def), f.exact.length, f.version.length, f.solos.map((x) => [x.r.fields.Title, x.cls])],
    [[3, 7, 9, 12], ['exact', 'exact', null, 'version'], 0, 0, [['Maula - Unplugged', null]]])
  // the singer is shown, never deciding: row 7 has another singer and is suggested as Original all the same
  assert.deepEqual(factsOfGroup(f, f.todo[1]), { isrc: true, singer: true, production: null })
  assert.deepEqual(factsOf(lnv(1, { Singer: ['Q'], ISRC: [MAIN] }), [f.main]), { isrc: true, singer: false, production: null })
  assert.deepEqual(factsOfGroup(f, f.todo[2]), { isrc: false, singer: false, production: false })
  assert.deepEqual(familyFacts(f), { isrc: true, singer: true, production: true })
  assert.ok(companyWords('Saregama India Ltd').has('saregama') && companyWords('T-Series').has('super') && companyWords('Super Cassettes Industries Ltd').has('super'))
})

test('Original starts empty: the first put there is the row, the next ones join it; Other version and Delete check too', () => {
  const a = maula(), d = step([a]), f = familiesOf([a])[0]
  assert.deepEqual(progressOf(NO_PENDING, f), { total: 5, left: 5, done: 0, status: 'todo' })   // 3 · 7 · 9 · 12 · the unplugged one
  // row 9 first – another ISRC, but the reviewer says it is the song – then row 3
  const p2 = chooseClass(chooseClass(NO_PENDING, d, f.todo[2], 'exact'), d, f.todo[0], 'exact')
  const f2 = familiesOf([a], [], [], classesNow(d, p2), atNow(d, p2))[0]
  assert.deepEqual([f2.exact.map(rows0), f2.todo.map(rows0), checkedIn(p2, f2), toCheck(p2, f2)], [[9, 3], [7, 12], 2, 3])
  const items = pendingItems(p2, d).filter((x) => x.key.startsWith('class:'))
  assert.deepEqual(items.map((x) => [x.key, x.choice]), [['class:9', 'exact'], ['class:3', 'exact']])
  assert.ok(items[0].data!.at! < items[1].data!.at!)
  assert.deepEqual(pendingItems(p2, d).find((x) => x.key === 'link:A')!.data!.rows, [3, 7, 9])   // ticked: the same song
  // saved: the server sends the times back – the same order
  const at = Object.fromEntries(items.map((x) => [x.key, x.data!.at!]))
  assert.deepEqual(familiesOf([a], [], [], { 'class:9': 'exact', 'class:3': 'exact' }, at)[0].exact.map(rows0), [9, 3])
  // row 7 another version, row 12 deleted, the unplugged one (beside no LNV row) another version: all checked
  const p5 = chooseSoloClass(chooseClass(chooseClass(p2, d, f2.todo[0], 'version'), d, f2.todo[1], 'deleted'), d, f2.solos[0], 'version')
  const f5 = familiesOf([a], [], [], classesNow(d, p5), atNow(d, p5))[0]
  assert.deepEqual([f5.todo.length, f5.version.map(rows0), f5.deleted.map(rows0), f5.solos[0].cls, progressOf(p5, f5).status], [0, [7], [12], 'version', 'done'])
  assert.equal(progressOf(p5, f5, ['maula']).status, 'complete')
  assert.deepEqual(pendingItems(chooseSoloClass(NO_PENDING, d, f.solos[0], 'deleted'), d).map((x) => [x.key, x.choice]), [[`class:m${f.solos[0].r.id}`, 'deleted']])
  // back to check: unchecked, its time gone
  const p6 = chooseClass(p5, d, f5.version[0], null)
  assert.deepEqual([classesNow(d, p6)['class:7'], atNow(d, p6)['class:7']], [undefined, undefined])
  // as saved by v1.8: a Possible match is an other version
  assert.deepEqual(familiesOf([a], [], [], classesNow(step([a], { classes: { 'class:9': 'possible' as never } }), NO_PENDING))[0].version.map(rows0), [9])
})

test('Original is one row: the values of every row in it offered, the other titles its alternative work name', () => {
  const f = familiesOf([maula()], [], [], { 'class:3': 'exact', 'class:7': 'exact' }, { 'class:3': 1, 'class:7': 2 })[0]
  const [keep, other] = f.exact
  assert.deepEqual([keep.rows[0], other.rows[0]], [3, 7])
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

test('the lists: To check, Original, Other versions, Deleted matches – every match says its section', () => {
  const a = maula(), d = step([a])
  const x = { families: familiesOf(d.cases), loose: [], newRows: [], deleted: [], isDone: () => true, d, p: NO_PENDING }
  for (const k of EACH) { const s = sheetOf(x, k); assert.equal(s.rows.length, listCount(x, k), k) }
  assert.deepEqual(['todo', 'exact', 'version', 'removed'].map((k) => listCount(x, k as 'exact')), [5, 0, 0, 0])
  assert.deepEqual(sheetOf(x, 'todo').rows.map((r) => [r[2], r[3], r[4]]), [[ 'To check', 'Left to check', 3 ], [ 'To check', 'Left to check', 7 ], [ 'To check', 'Left to check', 9 ],
    [ 'To check', 'Left to check', 12 ], [ 'To check', 'Left to check', 'new row' ]])
  const fs = familiesOf(d.cases, [], [], { 'class:3': 'exact', 'class:9': 'deleted', [f0(d).solos[0].key]: 'version' })
  const y = { ...x, families: fs }
  assert.deepEqual(['done', 'todo', 'exact', 'removed', 'version'].map((k) => listCount(y, k as 'exact')), [3, 2, 1, 1, 1])
  assert.deepEqual(sheetOf(y, 'removed').rows.map((r) => [r[2], r[3], r[4]]), [['Deleted', 'Checked', 9]])
  assert.deepEqual(sheetOf(y, 'version').rows.map((r) => [r[2], r[3], r[4], r[6]]), [['Other version', 'Checked', 'new row', 'Maula - Unplugged']])
  assert.deepEqual(sheetOf(y, 'status').rows.map((r) => r.slice(0, 9)), [['Maula', 'Partly checked', 5, 3, 0, 2, 1, 1, 1]])
})
