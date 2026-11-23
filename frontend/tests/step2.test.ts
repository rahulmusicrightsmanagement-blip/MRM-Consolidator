/** v1.5 – step 2's answers: deleted songs and new rows (what they save, the rows they turn down), the IPI / CAE list's
 *  names (what each field keeps, and the decision each choice saves). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CaseRecord, ReviewCase, Step1 } from '../src/types'
import { draftOf, isDeleted, isNewRow, itemsOf, pickItem, shownOf } from '../src/pages/client/reviewModel'
import { fieldChoices, ipiChoices, variantsOf } from '../src/pages/client/fieldModel'
import { NO_PENDING, familiesOf, inFamilies, outOfMatch, pendingItems } from '../src/pages/client/Families'
import type { Group } from '../src/pages/client/Families'

const rec = (fields: Record<string, string | string[]>, extra: Partial<CaseRecord> = {}): CaseRecord =>
  ({ src: 'Muso', ref: 'Row 2', fields, ...extra } as CaseRecord)
const lnvRow = (row: number, fields: Record<string, string | string[]>, extra: Partial<CaseRecord> = {}): CaseRecord =>
  rec(fields, { src: 'LNV', ref: `Row ${row}`, row, ...extra })
function song(over: Partial<ReviewCase> = {}): ReviewCase {
  return {
    id: 'c1', kind: 'check', title: 'Woh Lamhe', why: '', family: 'wohlamhe', merge: null,
    muso: [rec({ Title: 'Woh Lamhe', Singer: ['RK'] }, { id: 11, in: true, part: 'original' })],
    lnv: [lnvRow(4, { Title: 'Woh Lamhe', Singer: ['Ram Krishna'] }, { check: { writers: 'same', publisher: 'same', level: 'exact' } })],
    answer: { song: 'ISRC1', choice: 'same', rows: [4], by: 'app' }, done: false, new_row: null, updates: [], ...over,
  }
}

test('a deleted song turns down every LNV row it was matched to, and the rows it was turned down from before', () => {
  const c = song({ was: [lnvRow(9, { Title: 'Old' })] })
  const items = itemsOf(c, { ...draftOf(c), choice: 'deleted', rows: [] })
  assert.deepEqual(items.find((x) => x.key === 'link:ISRC1'), { key: 'link:ISRC1', choice: 'none', data: { rows: [4, 9] } })
  assert.deepEqual(items.find((x) => x.key === 'missing:ISRC1'), { key: 'missing:ISRC1', choice: 'deleted' })
  // its values from Muso are cleared
  assert.ok(items.filter((x) => x.key.startsWith('pick:4:')).every((x) => x.choice === null))
  // taken back: everything cleared – the app's match returns
  const undo = itemsOf(c, null)
  assert.deepEqual(undo.filter((x) => x.key.startsWith('link:') || x.key.startsWith('missing:')).map((x) => x.choice), [null, null])
})

test('a new row keeps the rows turned down before; a song never matched sends none', () => {
  const sent = song({ lnv: [], was: [lnvRow(4, { Title: 'Woh Lamhe' })], answer: { song: 'ISRC1', choice: 'add', rows: [], by: 'you' } })
  assert.deepEqual(itemsOf(sent, { ...draftOf(sent), choice: 'add', rows: [] }).find((x) => x.key === 'link:ISRC1'),
    { key: 'link:ISRC1', choice: 'none', data: { rows: [4] } })
  const fresh = song({ lnv: [], answer: { song: 'ISRC1', choice: null, rows: [], by: null } })
  assert.deepEqual(itemsOf(fresh, { ...draftOf(fresh), choice: 'add', rows: [] }).find((x) => x.key === 'link:ISRC1'), { key: 'link:ISRC1', choice: 'none' })
})

test('New row and Deleted songs: which list a song is in', () => {
  const added = song({ answer: { song: 'S', choice: 'add', rows: [], by: 'you' } })
  const byApp = song({ answer: { song: 'S', choice: 'add', rows: [], by: 'app' } })
  const gone = song({ answer: { song: 'S', choice: 'deleted', rows: [], by: 'you' }, done: true })
  assert.equal(isNewRow(added), true)
  assert.equal(isNewRow(byApp), false)   // the app's own proposal stays under Not in the LNV until confirmed
  assert.equal(isDeleted(gone), true)
  assert.equal(outOfMatch(gone), true)
  assert.equal(inFamilies(gone), false)
  assert.equal(isDeleted(song({ kind: 'names', answer: { choice: 'deleted', by: 'you' } })), false)
  const fams = familiesOf([song(), gone, added])
  assert.equal(fams.length, 1)
  assert.deepEqual(fams[0].cases.map((c) => c.id), ['c1'])
})

test('the IPI / CAE list: what screens show and compare', () => {
  const r = rec({ Singer: ['RK'] }, { ipi: { Singer: { names: ['Ram Krishna'], ids: ['00111111111'] } } })
  assert.deepEqual(shownOf(r, 'Singer'), ['Ram Krishna'])
  assert.deepEqual(shownOf(r, 'Composer'), [])
  assert.deepEqual(variantsOf('Singer', [r, rec({ Singer: ['rk'] })]), [{ v: ['RK'], res: ['Ram Krishna'], ids: ['00111111111'] }])
})

const group = (lnv: CaseRecord, recs: CaseRecord[]): Group =>
  ({ key: 'exact:4', rows: [4], entries: [], lnv, match: 'exact', recs, trs: recs } as unknown as Group)

test('a field keeps the IPI List name by default where the LNV spells the member otherwise', () => {
  const lnv = lnvRow(4, { Composer: ['Mithun Sharma (Mithoon)'] }, { ipi: { Composer: { names: ['Mithun Naresh Sharma'], ids: ['00513185379'] } } })
  const muso = rec({ Composer: ['Mithoon'] }, { ipi: { Composer: { names: ['Mithun Naresh Sharma'], ids: ['00513185379'] } } })
  const other = rec({ Composer: ['Pritam'] })   // another writer: Muso's value differs
  const g = group(lnv, [muso, other])
  const fc = fieldChoices('Composer', g, undefined, 'Muso')
  assert.equal(fc.def, 'i0')
  assert.equal(fc.keep, 'ipi')
  assert.deepEqual(fc.now, ['Mithun Naresh Sharma'])
  assert.deepEqual(fc.ipis.map((x) => x.from), ['the LNV'])   // Muso's resolves to the same member: offered once
  assert.equal(fc.pickOf('i0'), null)                          // the default: nothing to save
  assert.deepEqual(fc.pickOf('lnv'), ['Mithun Sharma (Mithoon)'])   // keeping the LNV's spelling is an answer
  // "Mithoon" is the LNV's own person (no choice of its own); "Pritam" is Muso's other value
  assert.deepEqual(fc.opts, [['Pritam']])
  assert.deepEqual(fc.pickOf('m0'), ['Pritam'])
  // an answer saved: the LNV's own / Muso's / typed
  assert.equal(fieldChoices('Composer', g, ['Mithun Sharma (Mithoon)'], 'Muso').keep, 'lnv')
  assert.equal(fieldChoices('Composer', g, 'Pritam', 'Muso').keep, 'muso')
  assert.equal(fieldChoices('Composer', g, ['Somebody Else'], 'Muso').keep, 'custom')
})

test('with no list, a field keeps the LNV value; a blank one takes Muso’s – as the list has it', () => {
  const plain = fieldChoices('Singer', group(lnvRow(4, { Singer: ['Atif Aslam'] }), [rec({ Singer: ['Atif'] })]), undefined, 'Muso')
  assert.equal(plain.def, 'lnv')
  assert.equal(plain.ipis.length, 0)
  assert.equal(plain.pickOf('lnv'), null)
  const blank = group(lnvRow(4, { Singer: [] }), [rec({ Singer: ['RK'] }, { ipi: { Singer: { names: ['Ram Krishna'], ids: ['001'] } } })])
  const fc = fieldChoices('Singer', blank, undefined, 'Muso')
  assert.equal(fc.def, 'i0')
  assert.deepEqual(fc.now, ['Ram Krishna'])
  assert.deepEqual(fc.pickOf('m0'), ['RK'])   // Muso's as written: an answer
  assert.deepEqual(ipiChoices('Singer', blank.lnv, blank.recs, 'Muso')[0], { v: ['Ram Krishna'], ids: ['001'], from: 'Muso', raw: ['RK'] })
  // a name the list spells the same as the LNV is no choice of its own
  assert.equal(fieldChoices('Singer', group(lnvRow(4, { Singer: ['Ram Krishna'] }), blank.recs), undefined, 'Muso').ipis.length, 0)
})

test('each choice saves the decision the export reads: lnv · ipi (with its IPIs) · muso · custom', () => {
  const lnv = lnvRow(4, { Singer: ['RAM KRISHNA'] })
  const muso = rec({ Singer: ['RK'] }, { ipi: { Singer: { names: ['Ram Krishna'], ids: ['00111111111'] } } })
  assert.equal(pickItem('pick:4:Singer', ['RAM KRISHNA'], [muso], lnv).choice, 'lnv')
  assert.deepEqual(pickItem('pick:4:Singer', ['Ram Krishna'], [muso], lnv), { key: 'pick:4:Singer', choice: 'ipi', data: { value: ['Ram Krishna'], ipis: ['00111111111'] } })
  assert.equal(pickItem('pick:4:Singer', 'RK', [muso], lnv).choice, 'muso')
  assert.equal(pickItem('pick:4:Singer', ['Typed Name'], [muso], lnv).choice, 'custom')
})

test('the queue saves an IPI List name on its song with the IPIs', () => {
  const c = song({ lnv: [lnvRow(4, { Singer: ['R K'] }, { check: { writers: 'same', publisher: 'same', level: 'exact' }, ipi: { Singer: { names: ['Ram Krishna'], ids: ['00111111111'] } } })],
    answer: { song: 'ISRC1', choice: 'same', rows: [4], by: 'you' }, done: true })
  const d = { source: 'Muso', cases: [c], picks: {}, titles: {} } as unknown as Step1
  const items = pendingItems({ ...NO_PENDING, picks: { 'pick:4:Singer': ['Ram Krishna'] } }, d)
  assert.deepEqual(items.find((x) => x.key === 'pick:4:Singer'), { key: 'pick:4:Singer', choice: 'ipi', data: { value: ['Ram Krishna'], ipis: ['00111111111'] } })
  assert.deepEqual(items.find((x) => x.key === 'link:ISRC1'), { key: 'link:ISRC1', choice: 'same', data: { rows: [4] } })
})
