import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout, createAsset, normalizeLayout, validateLayout, computeLayoutMetrics, footprintCorners } from '../web/studio-model.js';

test('default layout remains valid and derives metrics from actual dimensions', () => {
  const layout = createDefaultLayout();
  assert.deepEqual(validateLayout(layout), []);
  assert.equal(computeLayoutMetrics(layout).area, 432);
  assert.equal(computeLayoutMetrics(layout).assetCount, 1);
  layout.factory.width = 30;
  assert.equal(computeLayoutMetrics(layout).area, 540);
});
test('rejects invalid geometry, duplicate IDs and unsupported types', () => {
  for (const invalid of [0, -1, NaN, Infinity, null, '', true]) {
    const layout = createDefaultLayout(); layout.factory.width = invalid;
    assert.throws(() => normalizeLayout(layout));
  }
  const duplicate = createDefaultLayout(); duplicate.assets.push({ ...duplicate.assets[0] });
  assert.throws(() => normalizeLayout(duplicate), /중복/);
  const unsupported = createDefaultLayout(); unsupported.assets[0].type = 'script';
  assert.throws(() => normalizeLayout(unsupported));
});
test('normalization is a whitelist and does not retain unknown fields', () => {
  const raw = createDefaultLayout(); raw.secret = 'not retained'; raw.assets[0].script = '<script>';
  raw.assets[0].rotation = -90;
  const normalized = normalizeLayout(raw);
  assert.equal(normalized.assets[0].rotation, 270);
  assert.equal(normalized.secret, undefined);
  assert.equal(normalized.assets[0].script, undefined);
});
test('rotation correctly changes border clearance', () => {
  const layout = createDefaultLayout();
  layout.assets = [{ ...createAsset('conveyor'), x: 2, y: 1, rotation: 0 }];
  assert.deepEqual(validateLayout(layout), []);
  layout.assets[0].rotation = 90;
  assert.equal(validateLayout(layout)[0].level, 'error');
  assert.ok(footprintCorners(layout.assets[0]).some(p => p.y < 0));
});
test('rotated footprints distinguish touching, overlapping and separated assets', () => {
  const layout = createDefaultLayout();
  const a = { ...createAsset('buffer'), id: 'a', x: 5, y: 5, width: 2, depth: 2 };
  const b = { ...a, id: 'b', x: 7 };
  layout.assets = [a, b];
  assert.equal(validateLayout(layout).length, 0);
  b.x = 6.9;
  assert.equal(validateLayout(layout)[0].level, 'warning');
  b.x = 7.3; b.rotation = 45;
  assert.equal(validateLayout(layout)[0].level, 'warning');
  b.x = 8;
  assert.equal(validateLayout(layout).length, 0);
});
test('overlapping zones are allowed but a machine in a walkway produces a warning', () => {
  const layout = createDefaultLayout();
  layout.assets = [{ ...createAsset('walkway'), x: 12, y: 9 }, { ...createAsset('worker-zone'), x: 12, y: 9 }];
  assert.equal(validateLayout(layout).length, 0);
  layout.assets.push({ ...createAsset('buffer'), x: 12, y: 9 });
  assert.equal(validateLayout(layout).filter(i => i.level === 'warning').length, 2);
});
