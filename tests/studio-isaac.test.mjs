import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout, createAsset } from '../web/studio-model.js';
import { getIsaacCompatibility, validateIsaacResponse } from '../web/studio-isaac.js';

const hasError = (result, text) => {
  assert.equal(result.payload, null);
  assert.ok(result.errors.some(message => message.includes(text)), JSON.stringify(result.errors));
};

test('default layout maps centred assets to the actual legacy robot anchor and corner rectangles', () => {
  const layout = createDefaultLayout();
  const original = JSON.stringify(layout);
  const result = getIsaacCompatibility(layout);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.payload, {
    name: layout.name,
    hall: { length_m: 24, width_m: 18 },
    cell: { x: 15.8, y: 10.6, rotation_deg: 0 },
    aisle: { y0: 3.75, y1: 5.25 },
    worker_zone: { x0: 16.5, x1: 19.5, y0: 5.5, y1: 7.5 },
  });
  assert.equal(JSON.stringify(layout), original);
});

test('unimplemented height, target and process timing remain warnings and never leak into payload', () => {
  const layout = createDefaultLayout();
  layout.factory.height = 9;
  layout.target_units_per_hour = 180;
  layout.assets[0].height = 3;
  layout.assets[0].processTime = 28;
  const result = getIsaacCompatibility(layout);
  assert.deepEqual(result.errors, []);
  for (const phrase of ['높이', '목표 생산량', '작업시간']) assert.ok(result.warnings.some(w => w.includes(phrase)));
  assert.deepEqual(Object.keys(result.payload).sort(), ['aisle', 'cell', 'hall', 'name', 'worker_zone']);
  assert.equal(JSON.stringify(result.payload).includes('processTime'), false);
  assert.equal(JSON.stringify(result.payload).includes('target_units_per_hour'), false);
});

test('invalid geometry yields structured errors rather than exceptions or NaN payloads', () => {
  for (const raw of [undefined, null, [], {}, { factory: {} }]) {
    const result = getIsaacCompatibility(raw);
    assert.equal(result.payload, null);
    assert.ok(result.errors.length > 0);
  }
  for (const bad of [NaN, Infinity, null, '', true]) {
    const layout = createDefaultLayout(); layout.assets[0].x = bad;
    assert.equal(getIsaacCompatibility(layout).payload, null);
  }
});

test('legacy hall limits prevent both server clamping and the 12m anchor-range bug', () => {
  for (const bad of [12, 12.799, 80.001]) {
    const layout = createDefaultLayout(); layout.factory.width = bad;
    hasError(getIsaacCompatibility(layout), '공장 가로');
  }
  for (const bad of [7.999, 40.001]) {
    const layout = createDefaultLayout(); layout.factory.depth = bad;
    hasError(getIsaacCompatibility(layout), '공장 세로');
  }
});

test('minimum hall dimensions are supported without implicit server correction', () => {
  const layout = createDefaultLayout();
  layout.factory.width = 12.8; layout.factory.depth = 8;
  Object.assign(layout.assets[0], { x: 6.4, y: 5.7 });
  Object.assign(layout.assets[1], { x: 6.4, y: 1, width: 12.8, depth: 1 });
  Object.assign(layout.assets[2], { x: 3, y: 2.7, width: 2, depth: 1 });
  const result = getIsaacCompatibility(layout);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.payload.cell, { x: 10.2, y: 6.3, rotation_deg: 0 });
});

test('each supported object must be present exactly once; free equipment is rejected', () => {
  for (const type of ['robot-cell', 'walkway', 'worker-zone']) {
    const missing = createDefaultLayout(); missing.assets = missing.assets.filter(a => a.type !== type);
    hasError(getIsaacCompatibility(missing), '정확히 1개');
    const doubled = createDefaultLayout();
    doubled.assets.push({ ...doubled.assets.find(a => a.type === type), id: 'second' });
    hasError(getIsaacCompatibility(doubled), '정확히 1개');
  }
  const layout = createDefaultLayout(); layout.assets.push({ ...createAsset('robot'), x: 3, y: 14 });
  hasError(getIsaacCompatibility(layout), '자유 배치');
});

test('rotation never silently becomes an unrotated Isaac scene', () => {
  for (const index of [0, 1, 2]) {
    const layout = createDefaultLayout(); layout.assets[index].rotation = 180;
    hasError(getIsaacCompatibility(layout), '회전 0°');
  }
  const fullTurn = createDefaultLayout(); fullTurn.assets[0].rotation = -360;
  assert.deepEqual(getIsaacCompatibility(fullTurn).errors, []);
});

test('fixed cell footprint and whole-cell boundary clearance are enforced', () => {
  for (const [key, value] of [['width', 10], ['depth', 4]]) {
    const resized = createDefaultLayout(); resized.assets[0][key] = value;
    hasError(getIsaacCompatibility(resized), '11.6 × 3.4');
  }
  const nearWall = createDefaultLayout(); nearWall.assets[0].x = 6.39;
  hasError(getIsaacCompatibility(nearWall), '0.6 m');
  nearWall.assets[0].x = 6.4;
  assert.deepEqual(getIsaacCompatibility(nearWall).errors, []);
  const outside = createDefaultLayout(); outside.assets[2].x = -1;
  hasError(getIsaacCompatibility(outside), '경계 밖');
});

test('walkway must cover the full length and satisfy the backend aisle limits', () => {
  for (const change of [{ width: 20 }, { x: 11 }]) {
    const layout = createDefaultLayout(); Object.assign(layout.assets[1], change);
    hasError(getIsaacCompatibility(layout), '공장 가로 전체');
  }
  for (const change of [{ depth: 0.9 }, { y: 0.75, depth: 1 }, { y: 17.25, depth: 1 }]) {
    const layout = createDefaultLayout(); Object.assign(layout.assets[1], change);
    hasError(getIsaacCompatibility(layout), '통로 폭');
  }
});

test('cell-zone overlap holds export; touching rectangles do not count as overlap', () => {
  const layout = createDefaultLayout(); layout.assets[2].x = 12; layout.assets[2].y = 8;
  hasError(getIsaacCompatibility(layout), '바닥 영역이 겹칩니다');
  layout.assets[2].y = 7.3; // zone maxY=8.3, cell minY=8.3
  assert.deepEqual(getIsaacCompatibility(layout).errors, []);
});

test('zone-zone overlap is explicit warning rather than an unsupported safety verdict', () => {
  const layout = createDefaultLayout(); layout.assets[2].y = 4.5;
  const result = getIsaacCompatibility(layout);
  assert.deepEqual(result.errors, []);
  assert.ok(result.payload);
  assert.ok(result.warnings.some(w => w.includes('작업자 구역과 이동 통로가 겹칩니다')));
});

test('unknown fields cannot be forwarded to the legacy server', () => {
  const layout = createDefaultLayout();
  layout.cmd = 'stop'; layout.url = 'https://example.invalid'; layout.assets[0].command = 'exec';
  const result = getIsaacCompatibility(layout);
  assert.deepEqual(result.errors, []);
  assert.equal(result.payload.cmd, undefined);
  assert.equal(result.payload.url, undefined);
  assert.equal(result.payload.cell.command, undefined);
});

const responseFor = payload => ({
  job_id: '20261108_212719_2f2a', scene_version: '2026-11-08.web.20261108_212719_2f2a', warnings: [],
  derived: {
    hall: [payload.hall.length_m, payload.hall.width_m],
    robot_base_expected: [payload.cell.x, payload.cell.y].map(value => Number(value.toFixed(3))),
    aisle: [payload.aisle.y0, payload.aisle.y1],
    lathe_row_S: { x_start: -16.5856, y: 9.4002 }, removed_lathes: ['S12'],
  },
});

test('factory response verifies echoed layout and states the worker-zone verification limit', () => {
  const payload = getIsaacCompatibility(createDefaultLayout()).payload;
  const response = responseFor(payload);
  const original = JSON.stringify({ payload, response });
  const result = validateIsaacResponse(payload, response);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some(w => w.includes('작업자 구역') && w.includes('자동 대조하지 못했습니다')));
  assert.ok(result.warnings.some(w => w.includes('가공설비 1개')));
  assert.equal(JSON.stringify({ payload, response }), original);
});

test('cached legacy input B response is accepted without inferring physical validation', () => {
  const payload = { hall: { length_m: 50, width_m: 24 }, cell: { x: 40, y: 9, rotation_deg: 0 }, aisle: { y0: 12, y1: 15 } };
  const response = responseFor(payload);
  response.derived.lathe_row_S = { x_start: 7.6144, y: 7.8002 };
  assert.deepEqual(validateIsaacResponse(payload, response).errors, []);
});

test('three-decimal robot echo accepts rounding but rejects actual coordinate correction', () => {
  const payload = getIsaacCompatibility(createDefaultLayout()).payload;
  payload.cell.x = 15.800499; payload.cell.y = 10.6005;
  const response = responseFor(payload);
  assert.deepEqual(validateIsaacResponse(payload, response).errors, []);
  response.derived.robot_base_expected[0] = 15.799;
  assert.ok(validateIsaacResponse(payload, response).errors.some(e => e.includes('로봇 셀 기준점') && e.includes('입력과 다르게')));
});

test('factory response holds execution if hall or aisle has been clamped', () => {
  const payload = getIsaacCompatibility(createDefaultLayout()).payload;
  for (const key of ['hall', 'aisle']) {
    const response = responseFor(payload); response.derived[key][1] += 0.01;
    assert.ok(validateIsaacResponse(payload, response).errors.some(e => e.includes('입력과 다르게')));
  }
});

test('missing or nonnumeric configuration echoes hold execution rather than imply application', () => {
  const payload = getIsaacCompatibility(createDefaultLayout()).payload;
  for (const response of [undefined, null, [], {}, { ...responseFor(payload), derived: null }]) {
    assert.ok(validateIsaacResponse(payload, response).errors.length > 0);
  }
  for (const key of ['hall', 'robot_base_expected', 'aisle']) {
    for (const value of [undefined, null, [], [24], ['24', 18], [NaN, 18], [24, Infinity], [24, 18, 2]]) {
      const response = responseFor(payload); response.derived[key] = value;
      assert.ok(validateIsaacResponse(payload, response).errors.length > 0);
    }
  }
});

test('invalid request, job identity, scene version or malformed server warnings hold execution', () => {
  const payload = getIsaacCompatibility(createDefaultLayout()).payload;
  for (const bad of [null, {}, { ...payload, cell: { ...payload.cell, rotation_deg: 180 } }]) {
    assert.ok(validateIsaacResponse(bad, responseFor(payload)).errors.length > 0);
  }
  for (const change of [{ job_id: '../stop' }, { job_id: '' }, { scene_version: '' }, { warnings: null }, { warnings: [42] }]) {
    assert.ok(validateIsaacResponse(payload, { ...responseFor(payload), ...change }).errors.length > 0);
  }
});

test('server warnings survive validation and do not get relabelled as successful checks', () => {
  const payload = getIsaacCompatibility(createDefaultLayout()).payload;
  const response = responseFor(payload); response.warnings = ['template warning', 'template warning', ''];
  const result = validateIsaacResponse(payload, response);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.filter(w => w === 'Isaac 서버: template warning').length, 1);
});
