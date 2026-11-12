import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createDefaultLayout } from '../web/studio-model.js';
import { MAX_TELEMETRY_ROWS, MAX_STORED_EVENTS, DEFAULT_TELEMETRY_THRESHOLDS, parseTelemetryCsv, telemetryToCsv, createSyntheticTelemetry, normalizeTelemetryThresholds, analyzeTelemetry, buildSignalSeries, hashTelemetrySource, analyzeIsaacDiagnostics } from '../web/studio-telemetry.js';

const header = 'timestamp,equipment_id,temperature_c,vibration_mm_s,current_a,cycle_s,state';
const row = (time = '2026-11-12T09:00:00+09:00', id = 'cnc-01', temperature = 40) => `${time},${id},${temperature},2,8,30,running`;
const csv = (...rows) => `${header}\n${rows.join('\n')}\n`;

test('CSV preserves quoted identifiers, explicit zones, zero counters, source and immutable content', () => {
  const source = `\ufeff${header}\r\n2026-11-12T09:00:00+09:00,"CNC, A",40,0,0,30,"ready, waiting"\r\n`;
  const data = parseTelemetryCsv(source, { filename: '입력.csv', sha256: 'a'.repeat(64) });
  assert.equal(data.rows[0].equipment_id, 'CNC, A'); assert.equal(data.rows[0].state, 'ready, waiting');
  assert.equal(data.rows[0].timestamp, '2026-11-12T00:00:00.000Z'); assert.equal(data.rows[0].current_a, 0);
  assert.equal(data.source.sha256, 'a'.repeat(64)); assert.equal(data.source.kind, 'uploaded-csv');
  assert.equal(data.source.measurementStatus, 'userprovided-unverified'); assert.equal(data.dataQuality.droppedRows, 0);
  assert.match(telemetryToCsv(data), /"CNC, A"/);
});

test('CSV rejects malformed quoting, columns, missing numbers and physically invalid signs', () => {
  for (const input of [csv(row().replace(',40,', ',Infinity,')), csv(row().replace(',40,', ',NaN,')), csv(row().replace(',40,', ',,')),
    csv(row().replace(',2,8,', ',-2,8,')), csv(row().replace(',30,', ',0,')), csv(row().replace(',40,', ',-300,')),
    csv(row().replace(',40,', ',0x10,')), csv(row().replace(',cnc-01,', ',"unclosed,')), `${header},unexpected\n${row()},x`,
    `timestamp,equipment_id,temperature_c,vibration_mm_s,current_a,cycle_s,cycle_s\n${row()}`, csv(row() + ',extra')]) assert.throws(() => parseTelemetryCsv(input));
});

test('timestamps must be real, zoned and globally ordered; duplicate equipment samples are rejected', () => {
  for (const input of [csv(row('2026-11-12T09:00:00')), csv(row('2026-02-30T09:00:00Z')), csv(row('2026-11-12T24:00:00Z')),
    csv(row('2026-11-12T09:01:00Z'), row('2026-11-12T09:00:00Z')), csv(row(), row())]) assert.throws(() => parseTelemetryCsv(input));
  assert.equal(parseTelemetryCsv(csv(row(undefined, 'A'), row(undefined, 'B'))).rows.length, 2);
});

test('CSV row and byte ceilings reject the complete file without silently dropping rows', () => {
  assert.throws(() => parseTelemetryCsv('x'.repeat(2_000_001)), /2MB/);
  assert.throws(() => parseTelemetryCsv(`${header}\n${'x,x,1,1,1,1,x\n'.repeat(MAX_TELEMETRY_ROWS + 1)}`), /20,000/);
  assert.throws(() => parseTelemetryCsv(header), /최소 한 행/);
});

test('synthetic data is deterministic, unmistakably marked and roundtrips through CSV', () => {
  const a = createSyntheticTelemetry({ equipmentIds: ['cnc-A', 'robot-B'], samples: 25 }), b = createSyntheticTelemetry({ equipmentIds: ['cnc-A', 'robot-B'], samples: 25 });
  assert.deepEqual(a, b); assert.equal(a.source.kind, 'synthetic-example'); assert.equal(a.source.measurementStatus, 'synthetic');
  assert.match(a.source.label, /현장 측정 데이터 아님/); assert.equal(a.rows.length, 50);
  const parsed = parseTelemetryCsv(telemetryToCsv(a)); assert.equal(parsed.rows.length, a.rows.length);
  assert.equal(parsed.rows[49].temperature_c, a.rows[49].temperature_c);
});

test('threshold equality is not an exceedance and changes have explicit rule evidence', () => {
  const data = parseTelemetryCsv(csv(...[40, 40, 40, 70, 80].map((value, i) => row(`2026-11-12T00:0${i}:00Z`, 'cnc-01', value))));
  const result = analyzeTelemetry(data, { thresholds: { baseline_samples: 3, baseline_percent: 100, temperature_c: 70 } });
  const temperatureEvents = result.anomalies.filter(event => event.signal === 'temperature_c');
  assert.equal(temperatureEvents.length, 1); assert.equal(temperatureEvents[0].value, 80);
  assert.deepEqual(temperatureEvents[0].rules.map(rule => rule.kind), ['threshold']);
  assert.equal(temperatureEvents[0].threshold, 70); assert.match(temperatureEvents[0].reason, /80°C > 입력 기준 70°C/);
  assert.equal(result.summary.affectedSampleCount, 1);
});

test('baseline is an initial per-equipment median; initial samples do not flag their own relative rule', () => {
  const data = parseTelemetryCsv(csv(...[30, 40, 50, 60, 65].map((value, i) => row(`2026-11-12T00:0${i}:00Z`, 'A', value))));
  const result = analyzeTelemetry(data, { thresholds: { baseline_samples: 3, baseline_percent: 35, temperature_c: 1000 } });
  assert.equal(result.equipment[0].baselines.temperature_c, 40);
  assert.equal(result.anomalies.length, 2); assert.equal(result.anomalies[0].rules[0].kind, 'baseline-change');
  assert.equal(result.anomalies[0].changePercent, 50); assert.equal(result.anomalies[0].timestamp, data.rows[3].timestamp);
  const short = analyzeTelemetry(parseTelemetryCsv(csv(row())), { thresholds: { baseline_samples: 3 } });
  assert.equal(short.equipment[0].baselineReady, false); assert.equal(short.equipment[0].baselines.temperature_c, null);
});

test('zero initial baselines never divide by zero and missing measurements cannot silently enter analysis', () => {
  const data = parseTelemetryCsv(csv(...Array.from({ length: 5 }, (_, i) => row(`2026-11-12T00:0${i}:00Z`).replace(',2,8,', `,${i === 4 ? 1 : 0},8,`))));
  const result = analyzeTelemetry(data, { thresholds: { baseline_samples: 3 } });
  assert.equal(result.anomalies.filter(event => event.signal === 'vibration_mm_s').length, 0);
  data.rows[0].current_a = NaN; assert.throws(() => analyzeTelemetry(data), /정상화된/);
});

test('bounded event storage retains full counts and explicitly reports omitted events', () => {
  const data = createSyntheticTelemetry({ equipmentIds: Array.from({ length: 8 }, (_, i) => `machine-${i}`), samples: 500 });
  const result = analyzeTelemetry(data, { thresholds: { temperature_c: 0, vibration_mm_s: .01, current_a: .01, cycle_s: .01 } });
  assert.equal(result.summary.eventCount, data.rows.length * 4); assert.equal(result.anomalies.length, MAX_STORED_EVENTS);
  assert.equal(result.summary.eventsTruncated, true); assert.equal(result.summary.affectedSampleCount, data.rows.length);
  assert.equal(result.equipment.reduce((sum, item) => sum + item.eventCount, 0), result.summary.eventCount);
});

test('downsampled charts preserve input extrema and contain no fabricated points', () => {
  const data = createSyntheticTelemetry({ equipmentIds: ['A'], samples: 500 }); data.rows[211].temperature_c = 999;
  const points = buildSignalSeries(data, 'A', 'temperature_c', 40);
  assert.ok(points.length <= 40); assert.ok(points.some(point => point.value === 999));
  assert.equal(points[0].at, data.rows[0].at); assert.equal(points.at(-1).at, data.rows.at(-1).at);
  for (const point of points) assert.ok(data.rows.some(row => row.at === point.at && row.temperature_c === point.value));
});

test('uploaded bytes get SHA-256 and unsupported crypto stays explicitly unavailable', async () => {
  assert.equal(await hashTelemetrySource('abc', webcrypto), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hashTelemetrySource('abc', {}), null);
});

test('thresholds remain bounded explicit assumptions and CSV text is spreadsheet-safe', () => {
  assert.deepEqual(normalizeTelemetryThresholds({}), DEFAULT_TELEMETRY_THRESHOLDS);
  for (const patch of [{ baseline_samples: 1 }, { baseline_samples: 3.5 }, { baseline_percent: Infinity }, { current_a: '' }, { vibration_mm_s: -1 }]) assert.throws(() => normalizeTelemetryThresholds(patch));
  const data = createSyntheticTelemetry({ equipmentIds: ['=HYPERLINK("x")'], samples: 20 });
  assert.match(telemetryToCsv(data), /'=HYPERLINK/);
});

test('real Isaac counters stay separate from sensor examples and contact records are not invented', () => {
  const layout = createDefaultLayout(), raw = { job_id: 'job-abc', request_snapshot: { job_id: 'job-abc', layout, last_sample_at: Date.parse('2026-11-12T00:00:00Z') },
    current_observation: { job_id: 'job-abc', run_id: 'job-abc', state: 'running', ik_timeouts: 2, grasp_fail: 1, good: 12, contact_count: 100 } };
  const result = analyzeIsaacDiagnostics(raw, layout);
  assert.equal(result.source.kind, 'isaac-run'); assert.equal(result.layoutMatches, true); assert.equal(result.identityMatches, true);
  assert.equal(result.anomalies.length, 2); assert.equal(result.counters.good, 12);
  assert.equal(result.anomalies[0].timeSemantics, 'snapshot-time-not-event-time'); assert.equal(result.anomalies[0].equipment_id, null);
  assert.equal('contact_count' in result.counters, false); assert.match(result.missingEvidence.join(' '), /접촉 이벤트 미수신/);
  assert.equal('temperature_c' in result.counters, false);
});

test('run identity mismatch suppresses counters; changed layouts are labeled rather than merged', () => {
  const layout = createDefaultLayout(), raw = { job_id: 'job-abc', request_snapshot: { job_id: 'job-abc', layout: structuredClone(layout) }, current_observation: { job_id: 'job-abc', run_id: 'other-job', ik_timeouts: 2 } };
  let result = analyzeIsaacDiagnostics(raw, layout); assert.equal(result.identityMatches, false); assert.deepEqual(result.counters, {}); assert.equal(result.anomalies.length, 0);
  raw.current_observation.run_id = 'job-abc'; layout.factory.width = 30; result = analyzeIsaacDiagnostics(raw, layout);
  assert.equal(result.layoutMatches, false); assert.equal(result.counters.ik_timeouts, 2); assert.match(result.note, /일치를 확인하지 못/);
  raw.request_snapshot.last_sample_at = Infinity; assert.equal(analyzeIsaacDiagnostics(raw, layout).dataQuality.observedAt, null);
});

test('zero failure counters are visible observations without a healthy or safe verdict', () => {
  const result = analyzeIsaacDiagnostics({ job_id: 'job-abc', current_observation: { job_id: 'job-abc', ik_timeouts: 0, grasp_fail: 0, good: 0 } }, createDefaultLayout());
  assert.equal(result.counters.ik_timeouts, 0); assert.equal(result.anomalies.length, 0);
  assert.equal('healthScore' in result, false); assert.equal('safe' in result, false); assert.equal('prediction' in result, false);
});
