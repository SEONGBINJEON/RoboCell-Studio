import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout } from '../web/studio-model.js';
import { getIsaacCompatibility } from '../web/studio-isaac.js';
import { isRunId, createStatusGate, fingerprintLayout, fingerprintIsaacPayload, classifyRuntime, getRuntimeDiagnostics, normalizeJobDetail, shouldRefreshJobDetail, normalizeStreamRate, getReceivedFps } from '../web/studio-runtime.js';

const sim = { running: true, state: 'running', job_id: 'run_123', run_id: 'run_123', sim_t: 42.5, good: 0, ng: 2, wip: 3, frame_id: 400, last_frame_age_s: 0.1 };
const options = { online: true, lastSuccessAt: 20_000, now: 21_000, streamLoaded: true, requestRunId: 'run_123', frameProgressAt: 20_000 };

test('stream request ceiling accepts only supported rates up to 24 and defaults to 24', () => {
  for (const rate of [4,8,12,24]) {
    assert.equal(normalizeStreamRate(rate),rate);
    assert.equal(normalizeStreamRate(String(rate)),rate);
  }
  for (const invalid of [0,25,30,60,-1,Infinity,NaN,undefined,null,{},[12],'unlimited']) {
    assert.equal(normalizeStreamRate(invalid),24);
  }
});

test('observed receive FPS counts delivered images, honors warmup and expires stalled samples', () => {
  const received = Array.from({length:24},(_,i)=>(i+1)*125);
  assert.equal(getReceivedFps(received,{startedAt:0,now:3000}),8);
  assert.equal(getReceivedFps(received,{startedAt:0,now:4500}),4);
  assert.equal(getReceivedFps(received,{startedAt:0,now:6001}),0);
  assert.equal(getReceivedFps(received,{startedAt:0,now:500}),null);
  assert.equal(getReceivedFps([100,600,NaN,'900',5000],{startedAt:0,now:1000}),2);
  assert.equal(getReceivedFps([],{startedAt:null,now:3000}),null);
  assert.equal(getReceivedFps(received,{startedAt:4000,now:3000}),null);
  // A selected 24/s ceiling cannot turn four actual deliveries into 24 FPS.
  assert.equal(getReceivedFps([250,500,750,1000],{startedAt:0,now:1000}),4);
});

test('a late pre-control status response cannot overwrite the newer paused state', async () => {
  const gate = createStatusGate(); let renderedState = 'running'; let completeOld;
  assert.equal(gate.isCurrent(null), false);
  const oldToken = gate.begin();
  const oldRequest = new Promise(resolve => { completeOld = resolve; }).then(state => {
    if (gate.isCurrent(oldToken)) renderedState = state;
  });
  gate.invalidate();
  const pauseToken = gate.begin();
  if (gate.isCurrent(pauseToken)) renderedState = 'paused';
  completeOld('running'); await oldRequest;
  assert.equal(renderedState, 'paused'); assert.equal(gate.isCurrent(oldToken), false);
  gate.invalidate(); assert.equal(gate.isCurrent(pauseToken), false);
  assert.ok(gate.begin() > pauseToken);
});

test('runtime uses strict job identity and usable ready states, never a truthy running string', () => {
  assert.equal(isRunId('a'), false); assert.equal(isRunId('abc/stop'), false); assert.equal(isRunId('x'.repeat(65)), false);
  assert.equal(isRunId('20261112_064346_abd1'), true);
  assert.equal(classifyRuntime(sim, options).isLive, true);
  assert.equal(classifyRuntime({ ...sim, state: 'failed' }, options).ready, false);
  assert.equal(classifyRuntime({ ...sim, running: 'true' }, options).ready, false);
  const loading = classifyRuntime({ ...sim, state: 'loading' }, options);
  assert.equal(loading.canStop, true); assert.equal(loading.controlsEnabled, false); assert.equal(loading.frameHealth, 'loading');
  for (const changed of [{ job_id: '../../stop' }, { run_id: 'other_run' }, { run_id: '' }]) {
    const result = classifyRuntime({ ...sim, ...changed }, options);
    assert.equal(result.controlsEnabled, false); assert.equal(result.canStop, false); assert.equal(result.isLive, false);
    assert.equal(result.metrics.sim_t, null);
  }
  assert.equal(classifyRuntime(sim, { ...options, requestRunId: 'new_run' }).frameHealth, 'identity-mismatch');
});

test('stale status and mismatched streams hide metrics and LIVE without inventing numbers', () => {
  const stale = classifyRuntime(sim, { ...options, now: 40_000 });
  assert.equal(stale.frameHealth, 'stale-status'); assert.equal(stale.canStop, false);
  assert.deepEqual(stale.metrics, { sim_t: null, good: null, ng: null, wip: null });
  assert.equal(classifyRuntime(sim, { ...options, online: false }).frameHealth, 'offline');
  assert.equal(classifyRuntime(sim, { ...options, lastSuccessAt: null }).statusFresh, false);
  const missing = classifyRuntime({ ...sim, sim_t: '42.5', good: null, ng: NaN, wip: -1 }, options);
  assert.deepEqual(missing.metrics, { sim_t: null, good: null, ng: null, wip: null });
  assert.equal(classifyRuntime(sim, options).metrics.good, 0);
});

test('a stopping process cannot be played, stopped again or advertised as LIVE', () => {
  const stopping = classifyRuntime({...sim,state:'stopping',message:'live'},options);
  assert.equal(stopping.frameHealth,'stopping'); assert.equal(stopping.isLive,false);
  assert.equal(stopping.ready,false); assert.equal(stopping.controlsEnabled,false);
  assert.equal(stopping.canStop,false); assert.equal(stopping.metrics.sim_t,null);
  assert.match(stopping.reason,/실행 프로세스/);
  assert.equal(classifyRuntime({...sim,state:'loading'},options).canStop,true);
});

test('frame freshness requires metadata, actual image load and progress even while paused', () => {
  assert.equal(classifyRuntime(sim, { ...options, streamLoaded: false }).frameHealth, 'connecting');
  assert.equal(classifyRuntime({ ...sim, last_frame_age_s: 9 }, options).frameHealth, 'stale-frame');
  assert.equal(classifyRuntime(sim, { ...options, frameProgressAt: 1_000 }).frameHealth, 'stale-frame');
  assert.equal(classifyRuntime({ ...sim, state: 'paused', paused: true }, { ...options, frameProgressAt: 1_000 }).isLive, false);
  assert.equal(classifyRuntime({ ...sim, state: 'paused', paused: true }, options).isLive, true);
  for (const missing of [{ run_id: undefined }, { frame_id: null }, { last_frame_age_s: null }, { last_frame_age_s: -1 }]) {
    assert.equal(classifyRuntime({ ...sim, ...missing }, options).isLive, false);
  }
  assert.equal(classifyRuntime(sim, { ...options, frameProgressAt: null }).frameHealth, 'missing-frame');
  const error = classifyRuntime({ ...sim, capture_error: 'renderer failed' }, options);
  assert.equal(error.frameHealth, 'capture-error'); assert.equal(error.controlsEnabled, true);
});

test('sampled frame age keeps advancing while status remains fresh and JPEG requests succeed', () => {
  const sampled = { ...sim, last_frame_age_s: 7 };
  const start = classifyRuntime(sampled, { ...options, now: 20_000 });
  assert.equal(start.isLive, true); assert.equal(start.frameAgeS, 7);
  const later = classifyRuntime(sampled, { ...options, now: 22_000 });
  assert.equal(later.statusFresh, true); assert.equal(later.frameAgeS, 9);
  assert.equal(later.frameHealth, 'stale-frame'); assert.equal(later.isLive, false);
  assert.equal(later.metrics.sim_t, 42.5); assert.equal(later.controlsEnabled, true);
  assert.equal(classifyRuntime(sampled, { ...options, now: 30_001 }).statusFresh, false);
});

test('current job detail refreshes after state changes or ten seconds without polling older selections', () => {
  const current = { selectedJob:'run_123', currentJobId:'run_123', currentState:'loading',
    lastObservedState:'loading', detail:{job_id:'run_123',fetched_at:new Date(20_000).toISOString()}, now:21_000 };
  assert.equal(shouldRefreshJobDetail(current), false);
  for (const state of ['running','paused','exited']) {
    assert.equal(shouldRefreshJobDetail({...current,currentState:state}), true);
    assert.equal(shouldRefreshJobDetail({...current,currentState:state,detailBusy:true}), false);
  }
  assert.equal(shouldRefreshJobDetail({...current,now:30_000}), false);
  assert.equal(shouldRefreshJobDetail({...current,now:30_001}), true);
  assert.equal(shouldRefreshJobDetail({...current,currentJobId:'new_run',currentState:'running',now:60_000}), false);
  assert.equal(shouldRefreshJobDetail({...current,detail:null}), true);
  assert.equal(shouldRefreshJobDetail({...current,detail:null,detailBusy:true}), false);
  assert.equal(shouldRefreshJobDetail({...current,selectedJob:''}), false);
});

test('diagnostics report actual failure counters without claiming a zero-count pass', () => {
  assert.deepEqual(getRuntimeDiagnostics({ ik_timeouts: 0, grasp_fail: 0 }), []);
  assert.deepEqual(getRuntimeDiagnostics({ ik_timeouts: '3', grasp_fail: null }), []);
  const d = getRuntimeDiagnostics({ ik_timeouts: 2, grasp_fail: 1, capture_error: 'bad image' });
  assert.deepEqual(d.map(x => x.code), ['ik_timeouts', 'grasp_fail', 'capture_error']);
  assert.match(d[0].message, /2건/);
});

test('draft identity detects planning changes while Isaac payload comparison excludes unapplied fields', () => {
  const layout = createDefaultLayout(); const other = structuredClone(layout);
  other.assets.reverse();
  assert.equal(fingerprintLayout(layout), fingerprintLayout(other));
  other.factory.height = 7;
  assert.notEqual(fingerprintLayout(layout), fingerprintLayout(other));
  assert.equal(fingerprintIsaacPayload(getIsaacCompatibility(layout).payload), fingerprintIsaacPayload(getIsaacCompatibility(other).payload));
  other.assets.find(x => x.id === 'cell-01').x += 1;
  assert.notEqual(fingerprintIsaacPayload(getIsaacCompatibility(layout).payload), fingerprintIsaacPayload(getIsaacCompatibility(other).payload));
  assert.throws(() => fingerprintLayout({})); assert.equal(fingerprintIsaacPayload(null), null);
});

test('job details reject identity mismatch and export only bounded known evidence', () => {
  assert.equal(normalizeJobDetail({ job_id: 'other' }, 'run_123').ok, false);
  assert.equal(normalizeJobDetail({ job_id: 'run_123', live_status: { run_id: 'other' } }, 'run_123').ok, false);
  const raw = {
    job_id: 'run_123', name: '<script>test</script>', state: 'exited', cmd: ['secret'], config_path: '/private',
    overall: 'pass', good: null, sim_t: 60, exit_code: 0,
    log_tail: 'x'.repeat(12_000), derived: { hall: [24,18], aisle: ['3',4], arbitrary: 'ignored' },
    live_status: { good: 0, ng: '1', ik_timeouts: 2, nested: { token: 'ignored' } },
  };
  const result = normalizeJobDetail(raw, 'run_123');
  assert.equal(result.ok, true); assert.equal(result.cmd, undefined); assert.equal(result.config_path, undefined);
  assert.equal(result.overall, undefined); assert.equal(result.validation.status, 'not_assessed');
  assert.equal(result.good, null); assert.equal(result.live_status.good, 0); assert.equal(result.live_status.ng, undefined);
  assert.equal(result.log_tail.length, 8000); assert.equal(result.derived.aisle, null);
  assert.equal(result.live_status.nested, undefined); assert.equal(result.diagnostics[0].count, 2);
  assert.equal(result.name, '<script>test</script>'); // Consumer must use textContent, not HTML.
});
