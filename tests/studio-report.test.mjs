import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout } from '../web/studio-model.js';
import { createProjectEvidence, confirmEvidenceField } from '../web/studio-project-model.js';
import { buildReviewReport, assessReportRun } from '../web/studio-report.js';

const generatedAt = '2026-11-12T00:00:00.000Z';
const report = input => buildReviewReport({ generatedAt, ...input });
const runFixture = layout => ({ job_id: 'job-123', observed_at: generatedAt,
  request_snapshot: { job_id: 'job-123', layout: structuredClone(layout), requested_at: generatedAt },
  current_observation: { job_id: 'job-123', run_id: 'job-123', state: 'running', sim_t: 123.5, good: 17, ng: 0, wip: 2 },
});

test('a report without evidence provides geometry and missing facts without fabricated results', () => {
  const layout = createDefaultLayout(), result = report({ layout });
  assert.equal(result.summary.aiConnected, false); assert.equal(result.summary.safetyStatus, 'not_assessed');
  assert.equal(result.summary.productivityStatus, 'not_assessed'); assert.equal(result.summary.confirmedEvidenceCount, 0);
  assert.equal(result.summary.equipmentCount, 1); assert.equal(result.summary.zoneCount, 2); assert.equal(result.summary.totalObjectCount, 3);
  assert.equal(result.run.included, false); assert.equal(result.run.metrics.good, null);
  assert.match(result.text, /AI 미연결/); assert.match(result.text, /작업 번호가 없습니다/);
  assert.match(result.html, /<html lang="ko">/); assert.match(result.html, /@media print/);
  assert.equal('throughput' in result.summary, false); assert.equal('confidence' in result.summary, false);
});

test('all user supplied text is escaped in standalone HTML and remains readable in text export', () => {
  const layout = createDefaultLayout(), attack = '<img src=x onerror="alert(1)">';
  layout.name = attack; layout.assets[0].name = '<script>alert(2)</script>';
  const evidence = confirmEvidenceField(layout, createProjectEvidence(layout), 'dimensions', { reference: attack, note: '& " quoted' });
  const result = report({ layout, projectEvidence: evidence, planningReview: { radius: 3, source: 'userprovided', reference: attack, issues: [attack], envelopes: [{ name: attack, overlaps: [{ name: attack }] }] } });
  assert.doesNotMatch(result.html, /<img\b|<script\b/);
  assert.match(result.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(result.html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(result.text, /<img src=x/);
  assert.match(result.html, /Content-Security-Policy/);
});

test('matching job and full request snapshot include observed counters without calculating productivity', () => {
  const layout = createDefaultLayout(), result = report({ layout, runEvidence: runFixture(layout) });
  assert.equal(result.run.included, true); assert.equal(result.run.layoutMatches, true); assert.equal(result.run.jobMatches, true);
  assert.equal(result.run.metrics.good, 17); assert.equal(result.run.metrics.ng, 0); assert.equal(result.run.metrics.sim_t, 123.5);
  assert.equal(result.run.metricSource, 'current_observation'); assert.equal(result.run.observedAt, generatedAt);
  assert.equal(result.summary.productivityStatus, 'not_assessed');
});

test('a changed target or position invalidates full layout equality and excludes old run numbers', () => {
  for (const edit of [layout => { layout.assets[0].x += 1; }, layout => { layout.target_units_per_hour += 1; }]) {
    const layout = createDefaultLayout(), evidence = runFixture(layout); edit(layout);
    const result = report({ layout, runEvidence: evidence });
    assert.equal(result.run.included, false); assert.equal(result.run.layoutMatches, false); assert.equal(result.run.jobMatches, true);
    assert.deepEqual(result.run.metrics, { sim_t: null, good: null, ng: null, wip: null });
    assert.match(result.text, /현재 초안과 실행 당시 배치가 달라/);
    assert.doesNotMatch(result.text, /서버 양품 카운터: 17/);
  }
});

test('conflicting job identifiers, invalid snapshots and missing request receipts exclude metrics', () => {
  const layout = createDefaultLayout();
  for (const mutate of [
    r => { r.current_observation.run_id = 'other-job'; },
    r => { r.current_observation.job_id = 'other-job'; },
    r => { r.request_snapshot.job_id = 'other-job'; },
    r => { r.job_detail = { job_id: 'other-job', good: 999 }; },
    r => { r.request_snapshot.layout.factory.width = 0; },
    r => { delete r.request_snapshot; },
  ]) {
    const evidence = runFixture(layout); mutate(evidence);
    const result = assessReportRun(layout, evidence);
    assert.equal(result.included, false); assert.equal(result.metrics.good, null);
  }
});

test('saved detail can be reviewed but missing or invalid numbers remain unknown, never zero', () => {
  const layout = createDefaultLayout(), evidence = runFixture(layout); delete evidence.current_observation;
  evidence.job_detail = { job_id: 'job-123', state: 'exited', good: 7, ng: -1, sim_t: '120', live_status: {} };
  const result = assessReportRun(layout, evidence);
  assert.equal(result.included, true); assert.equal(result.metrics.good, 7); assert.equal(result.metrics.ng, null); assert.equal(result.metrics.sim_t, null);
  evidence.current_observation = { job_id: 'job-123', run_id: 'job-123', state: 'running', good: 8 };
  assert.equal(assessReportRun(layout, evidence).metrics.sim_t, null);
});

test('planning radius review is explicit input geometry and no-radius input cannot expose prior results', () => {
  const layout = createDefaultLayout();
  const result = report({ layout, planningReview: { status: 'approved', radius: 4, source: 'example', issues: ['가정 원이 통로와 중첩'], envelopes: [{ name: '로봇', outsideFactory: false, overlaps: [{ name: '통로', distance: 2 }] }] } });
  assert.equal(result.planningReview.status, 'not_assessed'); assert.match(result.text, /입력 반경 기반 평면 검토/);
  assert.match(result.text, /가정 원이 통로와 중첩/); assert.match(result.text, /실제 도달 범위/);
  const missing = report({ layout, planningReview: { radius: null, issues: ['OLD RESULT'], envelopes: [{ name: 'OLD ROBOT' }] } });
  assert.deepEqual(missing.planningReview.issues, []); assert.deepEqual(missing.planningReview.envelopes, []);
  assert.doesNotMatch(missing.text, /OLD RESULT|OLD ROBOT/);
});
