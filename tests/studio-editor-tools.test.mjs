import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsset, createDefaultLayout, footprintCorners } from '../web/studio-model.js';
import { getSelectionGeometry, alignAsset, ALIGNMENTS } from '../web/studio-editor-tools.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-6, `${actual} ≠ ${expected}`);
function sample(rotation = 0) {
  const layout = createDefaultLayout();
  layout.assets = [{ ...createAsset('conveyor'), id: 'selected', x: 8, y: 7, width: 6, depth: 2, rotation }];
  return layout;
}

test('geometry reports signed wall distances, actual footprint area and separate rotated bounding area', () => {
  const layout = sample(0); const g = getSelectionGeometry(layout, 'selected');
  assert.deepEqual(g.bounds, { minX: 5, maxX: 11, minY: 6, maxY: 8, width: 6, depth: 2 });
  assert.deepEqual(g.clearances, { left: 5, right: 13, front: 6, back: 10 });
  assert.equal(g.area, 12); assert.equal(g.boundingArea, 12); assert.equal(g.inBounds, true); assert.equal(g.fitsFactory, true);
  const rotated = getSelectionGeometry(sample(45), 'selected');
  near(rotated.area, 12); near(rotated.boundingArea, 32);
  assert.equal(rotated.heightClearance, 6 - .85);
});
test('90-degree and oblique rotation use the shared model footprint convention', () => {
  const layout = sample(90); const g = getSelectionGeometry(layout, 'selected');
  near(g.bounds.width, 2); near(g.bounds.depth, 6);
  for (const angle of [15, 37, 135, 270, -45]) {
    const item = sample(angle); const geometry = getSelectionGeometry(item, 'selected');
    const expected = footprintCorners(item.assets[0]);
    geometry.corners.forEach((corner, i) => { near(corner.x, expected[i].x); near(corner.y, expected[i].y); });
  }
});
test('every edge alignment touches its intended rotated bound and stays in the hall', () => {
  for (const angle of [0, 15, 45, 90, 180, 270, 315]) {
    for (const anchor of ['left', 'right', 'front', 'back']) {
      const aligned = alignAsset(sample(angle), 'selected', anchor);
      const g = getSelectionGeometry(aligned, 'selected'); near(g.clearances[anchor], 0);
      assert.equal(g.inBounds, true); assert.equal(aligned.assets[0].rotation, angle);
    }
  }
});
test('central alignment preserves the other valid coordinate and clamps only actual overflow', () => {
  const original = sample(45);
  const x = alignAsset(original, 'selected', 'x-center'); near(x.assets[0].x, 12); near(x.assets[0].y, 7);
  const y = alignAsset(original, 'selected', 'y-center'); near(y.assets[0].x, 8); near(y.assets[0].y, 9);
  const center = alignAsset(original, 'selected', 'center'); near(center.assets[0].x, 12); near(center.assets[0].y, 9);
  const overflow = sample(45); overflow.assets[0].x = -100; overflow.assets[0].y = 500;
  assert.equal(getSelectionGeometry(overflow, 'selected').inBounds, false);
  assert.ok(getSelectionGeometry(overflow, 'selected').clearances.left < 0);
  const aligned = alignAsset(overflow, 'selected', 'left'); assert.equal(getSelectionGeometry(aligned, 'selected').inBounds, true);
});
test('oversized rotated assets fail before clamping and input remains untouched', () => {
  const oversized = sample(0); oversized.assets[0].width = 25; oversized.assets[0].x = 0;
  const original = structuredClone(oversized); assert.equal(getSelectionGeometry(oversized, 'selected').fitsFactory, false);
  for (const {id} of ALIGNMENTS) assert.throws(() => alignAsset(oversized,'selected',id), /공장보다 큽니다/);
  assert.deepEqual(oversized, original);
  const rotated = sample(90); rotated.assets[0].width = 20; // Width fits 24, rotated depth exceeds 18.
  assert.throws(() => alignAsset(rotated, 'selected', 'center'), RangeError);
});
test('exact-fit rectangles, including quarter-turns, align without reversed interval errors', () => {
  const layout = sample(0); layout.assets[0].width = 24; layout.assets[0].depth = 18;
  for(const {id} of ALIGNMENTS) {
    const aligned = alignAsset(layout, 'selected', id); const g = getSelectionGeometry(aligned,'selected');
    Object.values(g.clearances).forEach(value=>near(value,0)); assert.equal(g.inBounds,true);
  }
  layout.assets[0].width = 18; layout.assets[0].depth = 24; layout.assets[0].rotation = 90;
  assert.equal(getSelectionGeometry(alignAsset(layout,'selected','right'),'selected').inBounds,true);
});
test('selection and input errors are explicit; alignment returns a detached normalized copy', () => {
  const layout = sample(30); layout.assets.push({...createAsset('buffer'),id:'other',x:15,y:15});
  assert.equal(getSelectionGeometry(layout,null),null); assert.equal(getSelectionGeometry(layout,'gone'),null);
  assert.throws(()=>alignAsset(layout,'gone','center'), /먼저 선택/);
  assert.throws(()=>alignAsset(layout,'selected','bogus'), /지원하지/);
  const original = structuredClone(layout); const result = alignAsset(layout,'selected','left');
  assert.deepEqual(layout,original); assert.deepEqual(result.assets[1],layout.assets[1]);
  result.assets[1].x=100; assert.equal(layout.assets[1].x,15);
  const bad = sample(); bad.factory.width = 0; assert.throws(()=>getSelectionGeometry(bad,'selected')); assert.throws(()=>alignAsset(bad,'selected','center'));
});
