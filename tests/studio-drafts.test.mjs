import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout, createAsset } from '../web/studio-model.js';
import { createDraftStore, compareLayouts, DRAFT_STORE_KEY, MAX_DRAFTS, MAX_STORE_CHARS } from '../web/studio-drafts.js';

function fixture() {
  const values = new Map([['robocell-studio-layout-v1', 'original-current-draft']]);
  let next = 0, fail = false;
  const storage = { getItem: key => values.get(key) ?? null, setItem(key, value) { if (fail) throw new Error('quota'); values.set(key, value); } };
  const store = createDraftStore(storage, { now: () => '2026-11-12T00:00:00.000Z', makeId: () => `draft-${++next}` });
  return { values, store, storage, failWrites: () => { fail = true; } };
}

test('saved snapshots are independent, duplicate names never overwrite and current draft is untouched', () => {
  const { values, store } = fixture(); const current = createDefaultLayout();
  const saved = store.save('기준안', current); current.factory.width = 30; saved.layout.assets[0].x = 100;
  store.save('기준안', current);
  assert.equal(store.list().length, 2); assert.equal(store.list()[1].layout.factory.width, 24);
  assert.equal(store.list()[1].layout.assets[0].x, 12);
  const list = store.list(); list[0].layout.factory.width = 90; assert.equal(store.list()[0].layout.factory.width, 30);
  assert.equal(values.get('robocell-studio-layout-v1'), 'original-current-draft');
});
test('quota failures preserve existing snapshots and deletion undo data remains reusable', () => {
  const f = fixture(); const saved = f.store.save('A', createDefaultLayout()); const raw = f.values.get(DRAFT_STORE_KEY); f.failWrites();
  assert.throws(() => f.store.save('B', createDefaultLayout()), /저장하지/);
  assert.throws(() => f.store.rename(saved.id, 'B'), /저장하지/);
  assert.throws(() => f.store.remove(saved.id), /저장하지/);
  assert.equal(f.values.get(DRAFT_STORE_KEY), raw);
});
test('corrupt or oversized storage is never silently replaced on save', () => {
  for (const raw of ['{', JSON.stringify({version: 99, entries: []}), JSON.stringify({version:1,entries:[{id:'x'}]}), ' '.repeat(MAX_STORE_CHARS + 1)]) {
    const f = fixture(); f.values.set(DRAFT_STORE_KEY, raw);
    assert.ok(f.store.inspect().error); assert.equal(f.store.inspect().raw, raw);
    assert.throws(() => f.store.save('새 배치', createDefaultLayout())); assert.equal(f.values.get(DRAFT_STORE_KEY), raw);
  }
});
test('missing storage is an explicit error and normalization rejects invalid saved layouts', () => {
  assert.match(createDraftStore(null).inspect().error, /사용할 수 없/);
  const { store, values } = fixture(); const bad = createDefaultLayout(); bad.factory.width = 0;
  assert.throws(() => store.save('bad', bad)); assert.equal(values.has(DRAFT_STORE_KEY), false);
});
test('rename and reversible deletion retain immutable layout and respect newer stored entries', () => {
  const f = fixture(); const a = f.store.save('A', createDefaultLayout()); const b = f.store.save('B', createDefaultLayout());
  f.store.rename(a.id, '이름 수정'); assert.equal(f.store.list().find(x=>x.id===a.id).name, '이름 수정');
  const removed = f.store.remove(a.id); assert.equal(f.store.list().length, 1);
  const external = JSON.parse(f.values.get(DRAFT_STORE_KEY)); external.entries[0].name = '다른 창 변경'; f.values.set(DRAFT_STORE_KEY, JSON.stringify(external));
  f.store.restore(removed); assert.equal(f.store.list()[0].name, '다른 창 변경'); assert.equal(f.store.list()[1].name, '이름 수정');
  assert.deepEqual(f.store.list()[1].layout, a.layout); assert.throws(()=>f.store.restore(removed), /이미 복원/);
  assert.throws(()=>f.store.remove('missing')); assert.equal(f.store.list()[0].id, b.id);
});
test('snapshot limit does not evict entries; user can remove and restore', () => {
  const { store } = fixture(); for(let i=0;i<MAX_DRAFTS;i++) store.save(`안${i}`, createDefaultLayout());
  assert.throws(()=>store.save('초과',createDefaultLayout()), /최대/); assert.equal(store.list().length, MAX_DRAFTS);
  const removed = store.remove(store.list()[0].id); store.restore(removed); assert.equal(store.list().length, MAX_DRAFTS);
});
test('comparison reports geometry and asset changes separately without inferred productivity', () => {
  const baseline = createDefaultLayout(), current = structuredClone(baseline); current.factory.width = 30;
  current.assets[0].x = 13.75; current.assets[0].rotation = 90; current.assets[0].depth = 4;
  current.assets = current.assets.filter(a=>a.type!=='worker-zone'); current.assets.push({...createAsset('cnc'),id:'new-cnc'});
  current.target_units_per_hour = 120;
  const diff = compareLayouts(baseline,current);
  assert.equal(diff.metrics.find(m=>m.key==='area').delta,108);
  assert.deepEqual(diff.changes.map(x=>x.kind),['changed','added','removed']);
  assert.deepEqual(diff.changes[0].fields.map(x=>x.key),['x','rotation','depth']);
  assert.equal(diff.targetChanged,true); assert.equal('throughput' in diff,false);
  assert.equal(baseline.assets[0].x,12);
});
test('same-id type replacements are additions/removals and cosmetic ordering is not a move', () => {
  const baseline = createDefaultLayout(), reordered = structuredClone(baseline); reordered.assets.reverse();
  assert.deepEqual(compareLayouts(baseline,reordered).changes,[]);
  const replaced = structuredClone(baseline); replaced.assets[0] = {...createAsset('cnc'), id:baseline.assets[0].id};
  assert.deepEqual(compareLayouts(baseline,replaced).changes.map(x=>x.kind),['added','removed']);
});
test('duplicate IDs or unknown future schema block mutations without data loss', () => {
  const f = fixture(); const entry = f.store.save('A',createDefaultLayout());
  const raw = JSON.stringify({version:1,entries:[entry,entry]}); f.values.set(DRAFT_STORE_KEY, raw);
  assert.throws(()=>f.store.rename(entry.id,'B')); assert.equal(f.values.get(DRAFT_STORE_KEY),raw);
});
