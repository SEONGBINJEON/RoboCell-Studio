import { normalizeLayout, validateLayout, computeLayoutMetrics, CATALOG } from './studio-model.js';
import { fingerprintLayout, isRunId, normalizeJobDetail, getRuntimeDiagnostics } from './studio-runtime.js';
import { getIsaacCompatibility } from './studio-isaac.js';
import { summarizeProjectEvidence, EVIDENCE_SOURCES } from './studio-project-model.js';
import { renderLayoutPlanSvg } from './studio-plan.js';
import { matchingAIAnalysis } from './studio-ai.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value, limit = 1000) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
export const escapeReportHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const e = escapeReportHtml;
const format = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '미수신';
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => { const time = typeof value === 'number' || typeof value === 'string' ? new Date(value) : null; return time && Number.isFinite(time.valueOf()) ? time.toISOString() : ''; };

/** Only a matching local request snapshot plus matching server job identifiers
 * permits metrics to appear as observations associated with this draft. The
 * report does not treat a request snapshot as proof of physical equivalence. */
export function assessReportRun(layout, raw) {
  const layoutFingerprint = fingerprintLayout(layout), input = record(raw) ? raw : {};
  const jobId = isRunId(input.job_id) ? input.job_id : null;
  const receipt = record(input.request_snapshot) ? input.request_snapshot : null;
  let snapshotFingerprint = null;
  try { if (receipt?.layout) snapshotFingerprint = fingerprintLayout(receipt.layout); } catch { /* An invalid snapshot remains unverified. */ }
  const layoutMatches = snapshotFingerprint !== null && snapshotFingerprint === layoutFingerprint;
  const detailPresent = record(input.job_detail), observation = record(input.current_observation) ? input.current_observation : null;
  const detail = detailPresent && jobId ? normalizeJobDetail(input.job_detail, jobId) : null;
  const observationMatches = !!observation && observation.job_id === jobId && isRunId(jobId)
    && (observation.run_id == null || observation.run_id === jobId);
  const jobMatches = !!jobId && receipt?.job_id === jobId && (!detailPresent || detail?.ok === true)
    && (!observation || observationMatches);
  const hasServerEvidence = detail?.ok === true || observationMatches;
  const included = jobMatches && layoutMatches && hasServerEvidence;
  const reasons = [];
  if (!jobId) reasons.push('유효한 실행 작업 번호가 없습니다.');
  if (!receipt || !snapshotFingerprint) reasons.push('유효한 실행 당시 배치 사본이 없습니다.');
  else if (!layoutMatches) reasons.push('현재 초안과 실행 당시 배치가 달라 실행 수치를 현재 배치 결과에서 제외했습니다.');
  if (jobId && !jobMatches) reasons.push('실행 근거의 작업 번호가 일치하지 않아 실행 수치를 제외했습니다.');
  if (!hasServerEvidence) reasons.push('작업 번호가 확인되는 서버 관측값이 없습니다.');
  let sample = null, metricSource = null;
  if (included && observationMatches) { sample = observation; metricSource = 'current_observation'; }
  else if (included && detail?.ok) {
    const live = detail.live_status;
    sample = ['sim_t', 'good', 'ng', 'wip'].some(key => live[key] !== undefined) ? live : detail;
    metricSource = sample === live ? 'job_detail.live_status' : 'job_detail';
  }
  const metrics = { sim_t: sample ? numeric(sample.sim_t) : null, good: sample ? count(sample.good) : null,
    ng: sample ? count(sample.ng) : null, wip: sample ? count(sample.wip) : null };
  return {
    provided: record(raw), jobId, layoutMatches, jobMatches, hasServerEvidence, included,
    state: included ? clean(sample?.state || detail?.state, 80) : '', metrics, metricSource,
    observedAt: included ? date(input.observed_at ?? receipt?.last_sample_at) : '',
    requestedAt: date(receipt?.requested_at), reasons,
    diagnostics: included ? getRuntimeDiagnostics(sample).map(item => ({ ...item, message: clean(item.message) })) : [],
    note: '실행 배치 일치는 요청 사본의 전체 값 비교입니다. 서버 적용 범위, 물리 정확도, 안전 또는 생산성 검증을 보증하지 않습니다.',
  };
}

/** Deterministic, local evidence report. No AI or external service is called.
 * runEvidence uses the studio's robocell-run-evidence/v1 export shape. */
export function buildReviewReport({ layout: raw, projectEvidence, runEvidence, planningReview, diagnostics, aiAnalysis, generatedAt = new Date().toISOString() }) {
  const layout = normalizeLayout(raw), metrics = computeLayoutMetrics(layout), issues = validateLayout(layout);
  const readiness = summarizeProjectEvidence(layout, projectEvidence), run = assessReportRun(layout, runEvidence);
  const compatibility = getIsaacCompatibility(layout), created = date(generatedAt);
  if (!created) throw new Error('보고서 생성 시각이 올바르지 않습니다.');
  const title = `${layout.name} · 배치 검토 보고서`;
  const zoneCount = layout.assets.filter(asset => ['worker-zone', 'walkway'].includes(asset.type)).length;
  const ai = matchingAIAnalysis({layout:raw,projectEvidence,runEvidence,planningReview,diagnostics},aiAnalysis);
  const scope = ai ? '현재 입력·실행 근거와 AWS Bedrock의 AI 검토를 함께 정리한 보고서입니다. AI 해석과 관측 사실을 구분하며 안전 승인 결과를 제공하지 않습니다.' : '브라우저 배치 모델과 제공된 실행 근거를 정리한 규칙 기반 보고서입니다. AI 미연결: 현재 입력에 일치하는 AI 분석이 포함되지 않았습니다.';
  const planningInput = record(planningReview) ? planningReview : {};
  const radius = numeric(planningInput.radius);
  const planning = {
    status: 'not_assessed', radius: radius !== null && radius > 0 ? radius : null,
    source: Object.hasOwn(EVIDENCE_SOURCES, planningInput.source) ? planningInput.source : 'assumption',
    reference: clean(planningInput.reference, 500),
    issues: radius !== null && radius > 0 && Array.isArray(planningInput.issues) ? planningInput.issues.slice(0, 200).filter(item => typeof item === 'string').map(item => clean(item)) : [],
    envelopes: radius !== null && radius > 0 && Array.isArray(planningInput.envelopes) ? planningInput.envelopes.slice(0, 100).filter(record).map(item => ({
      name: clean(item.name, 80), outsideFactory: item.outsideFactory === true,
      overlaps: Array.isArray(item.overlaps) ? item.overlaps.slice(0, 100).filter(record).map(overlap => ({ name: clean(overlap.name, 80), distance: numeric(overlap.distance) })) : [],
    })) : [],
    note: '입력 반경의 평면 원과 주변 배치를 비교한 참고 검토입니다. 로봇 제조사 사양, 실제 도달 범위, 동작 경로 또는 안전거리의 검증 결과가 아닙니다.',
  };
  const limits = [
    '도면·실측과 대조되지 않은 예시 및 가정은 실제 공장의 사실로 취급하지 않습니다.',
    '바닥 면적은 설비별 사각형 면적의 합이며, 겹친 영역을 제거한 점유 면적이나 가동률이 아닙니다.',
    '경계 및 겹침 검사는 평면 기하 검사입니다. 로봇 도달성·동작 충돌·안전 승인 결과는 제공되지 않았습니다.',
    '목표 생산량과 작업시간은 입력값입니다. 실측 처리량, 생산성 개선률, 투자 회수 기간을 계산하지 않았습니다.',
    '현재 Isaac 연결은 고정 로봇 셀·공장 가로/세로·통로·작업자 구역만 반영합니다. 높이·목표 수량·작업시간은 실행기에 반영되지 않습니다.',
    '서버 관측 수량은 보고서에 전달된 시점의 값입니다. 최신 실시간 상태 또는 정상 공정 완료의 증거로 해석하지 않습니다.',
  ];
  const nextSteps = [
    ...readiness.gaps.map(gap => `${gap.label}: ${gap.reason}`),
    ...(issues.length ? ['경계 이탈과 바닥 겹침을 수정한 뒤 같은 배치로 기하 검사를 다시 확인하세요.'] : []),
    ...(compatibility.errors.length ? ['현재 실행기 지원 범위에 맞는 배치로 조정하거나 개별 설비 연동을 구현해야 합니다.'] : []),
    ...(!run.included ? ['현재 배치 사본과 작업 번호가 일치하는 실행 근거를 확보하세요.'] : []),
    '실제 설비 사양·공정 순서·운반 조건을 반영한 별도 동작 및 생산성 검증이 필요합니다.',
  ];
  const summary = {
    generatedAt: created, area: metrics.area, equipmentCount: metrics.assetCount, zoneCount, totalObjectCount: layout.assets.length,
    occupiedAreaSum: metrics.occupiedArea, walkwayAreaSum: metrics.walkwayArea, geometricIssueCount: issues.length,
    confirmedEvidenceCount: readiness.confirmedCount, totalEvidenceCount: readiness.totalCount,
    runIncluded: run.included, runJobId: run.jobId, safetyStatus: 'not_assessed', productivityStatus: 'not_assessed', aiConnected: !!ai,
  };
  const evidenceRows = readiness.fields.map(field => [field.label, field.sourceLabel,
    field.stale ? '입력 변경 · 재확인 필요' : field.confirmed ? '사용자 확인' : '미확인', field.reference || '미제공',
    [field.id === 'materialFlow' ? field.value : '', field.note].filter(Boolean).join(' · ') || '—']);
  const assetRows = layout.assets.map((asset,index) => [String(index+1).padStart(2,'0'),asset.name, CATALOG.find(item => item.type === asset.type)?.label || asset.type,
    `${format(asset.x)} / ${format(asset.y)} m`, `${format(asset.width)} × ${format(asset.depth)} × ${format(asset.height)} m`,
    `${format(asset.rotation)}°`, asset.processTime > 0 ? `${format(asset.processTime)} s (입력값)` : '미입력']);
  const runRows = [
    ['작업 번호', run.jobId || '미제공'], ['요청 배치 일치', run.layoutMatches ? '일치' : '확인 안 됨 / 불일치'],
    ['작업 번호 일치', run.jobMatches ? '일치' : '확인 안 됨 / 불일치'],
    ['관측값 포함', run.included ? '현재 배치와 연결된 서버 관측값' : '제외'],
    ['관측 시각', run.observedAt || '미제공'], ['서버 상태', run.state || '미수신'],
    ['시뮬레이션 시간', run.metrics.sim_t === null ? '미수신' : `${format(run.metrics.sim_t)} s`],
    ['서버 양품 카운터', format(run.metrics.good)], ['서버 불량 카운터', format(run.metrics.ng)], ['서버 재공 카운터', format(run.metrics.wip)],
  ];
  const planningRows = [
    ['입력 반경', planning.radius === null ? '미입력 · 검토하지 않음' : `${format(planning.radius)} m`],
    ['입력 출처', EVIDENCE_SOURCES[planning.source]], ['참조 자료', planning.reference || '미제공'],
    ...planning.envelopes.map(item => [item.name, `공장 경계: ${item.outsideFactory ? '원 일부가 경계 밖' : '전달된 검사에서 이탈 표시 없음'} / 평면 중첩: ${item.overlaps.map(overlap => overlap.name).join(', ') || '전달된 검사에서 중첩 표시 없음'}`]),
  ];
  const table = (headings, rows) => `<div class="table-wrap"><table><thead><tr>${headings.map(value => `<th scope="col">${e(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${e(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const list = items => `<ul>${items.map(item => `<li>${e(item)}</li>`).join('')}</ul>`;
  const section = (name, content) => `<section><h2>${e(name)}</h2>${content}</section>`;
  const aiHtml = ai ? section('AI 검토 의견', `<p class="note">AWS Bedrock · ${e(ai.model)} · ${e(ai.generated_at||'')}<br>분석 요청 ${e(ai.request_id)} · 입력 변경 시 기존 AI 의견은 제외됩니다.</p><div class="ai-analysis">${e(ai.answer)}</div>${table(['근거 ID','참조 필드'],ai.citations.map(item=>[item.evidence_id,item.field]))}${ai.unverified.length?'<h3>추가 확인</h3>'+list(ai.unverified):''}`) : '';
  const diagnosticInput=record(diagnostics)?diagnostics:null;
  const diagnosticRows=diagnosticInput?[
    ['출처',clean(diagnosticInput.source?.label)||'미제공'],
    ['관측 표본',format(count(diagnosticInput.summary?.rowCount))],
    ['분석 설비',format(count(diagnosticInput.summary?.equipmentCount))],
    ['규칙 해당 관측',format(count(diagnosticInput.summary?.eventCount))],
    ['분석 방식',clean(diagnosticInput.method)||'실행 상태 관측'],
    ['기준 출처',clean(diagnosticInput.thresholdSource)||'실행 서버가 제공한 상태 기록'],
    ['배치 연결',diagnosticInput.layoutAssociation?.kind==='id-match-only-unverified'?'설비 ID 일치만 확인 · 실제 센서와 설비의 대응 관계 미검증':'제공된 실행 근거의 작업 번호·배치 일치 조건 확인 필요'],
  ]:[];
  const diagnosticEvents=Array.isArray(diagnosticInput?.anomalies)?diagnosticInput.anomalies.filter(record).slice(0,20).map(item=>[clean(item.timestamp,80),clean(item.equipment_id,80),clean(item.signal,80),`${format(numeric(item.value))} ${clean(item.unit,30)}`,clean(item.reason,800)]):[];
  const diagnosticHtml=diagnosticInput?section('설비 상태 분석 근거',table(['항목','관측 및 기준'],diagnosticRows)+table(['시각','설비 ID','신호','관측값','규칙 근거'],diagnosticEvents)+`<p class="note">${e(clean(diagnosticInput.note))} 이 문서에는 최대 20개 관측을 표시합니다. 전체 분석 결과는 진단 화면에서 확인하세요.</p>`):'';
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${e(title)}</title><style>
    *{box-sizing:border-box}body{margin:0;background:#edf0f4;color:#202733;font:14px/1.7 system-ui,'Malgun Gothic',sans-serif}main{max-width:1080px;margin:32px auto;background:white;padding:44px}header{border-top:6px solid #ffd233;padding:24px 0;border-bottom:1px solid #dce2e9}.brand{font-weight:800;letter-spacing:.08em;color:#536b8a;font-size:12px}h1{font-size:28px;line-height:1.4;margin:12px 0}h2{font-size:18px;margin:0 0 12px}p{margin:8px 0}section{margin-top:28px}.meta,.note{color:#536078;font-size:12px}.banner{background:#f1f4f8;border-left:3px solid #526b8b;padding:14px 18px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}.card{border:1px solid #dce2e9;padding:16px}.card strong{display:block;font-size:24px}.card span{font-size:12px;color:#536078}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #dce2e9;overflow-wrap:anywhere}th{background:#f1f4f8;font-weight:650}ul{padding-left:22px}li{margin:5px 0}footer{border-top:1px solid #dce2e9;margin-top:30px;padding-top:15px;font-size:11px;color:#536078}@media(max-width:680px){main{margin:0;padding:22px}.cards{grid-template-columns:repeat(2,1fr)}h1{font-size:23px}th,td{padding:7px;font-size:11px}}@media print{@page{size:A4;margin:16mm}body{background:white;font-size:11px}main{margin:0;max-width:none;padding:0}h1{font-size:23px}h2{font-size:15px}header{padding:15px 0}.cards{gap:8px}.card{padding:10px}.card strong{font-size:19px}section{margin-top:20px}h2{break-after:avoid}tr,.card{break-inside:avoid}thead{display:table-header-group}th,td{font-size:10px;padding:7px}.table-wrap{overflow:visible}.banner{print-color-adjust:exact}footer{font-size:10px}}
  .layout-plan{display:block;width:100%;height:auto;background:#f5f7fa;border:1px solid #dce2e9}.ai-analysis{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;background:#f4f6f9;padding:20px;border-left:3px solid #7992ac}
  </style></head><body><main><header><div class="brand">ROBOCELL STUDIO / REVIEW REPORT</div><h1>${e(title)}</h1><p class="meta">생성 시각 ${e(created)} · 배치 및 실행 근거 검토</p></header><p class="banner">${e(scope)}</p>
  <div class="cards"><div class="card"><span>공장 바닥 면적</span><strong>${e(format(metrics.area))} m²</strong></div><div class="card"><span>설비 객체 / 구역</span><strong>${metrics.assetCount} / ${zoneCount}</strong></div><div class="card"><span>평면 기하 확인 사항</span><strong>${issues.length}건</strong></div><div class="card"><span>사용자 확인 근거</span><strong>${readiness.confirmedCount} / ${readiness.totalCount}</strong></div></div>
  ${section('1. 배치 개요', table(['항목', '현재 입력값'], [
    ['공장 크기', `${format(layout.factory.width)} × ${format(layout.factory.depth)} × ${format(layout.factory.height)} m`],
    ['전체 객체', `${layout.assets.length}개 (설비 ${metrics.assetCount}, 구역 ${zoneCount})`],
    ['설비 바닥 면적의 합', `${format(metrics.occupiedArea)} m²`], ['통로 면적의 합', `${format(metrics.walkwayArea)} m²`],
    ['시간당 목표 생산량', `${format(layout.target_units_per_hour)}개 (계획 입력값)`],
  ]) + '<p class="note">로봇 이송 셀 템플릿 1개는 설비 객체 1개로 셉니다. 셀 내부 구성품 수를 개별 설비 수량으로 추정하지 않습니다.</p>')}
  ${section('2. 입력 근거와 확인 상태', table(['항목', '출처', '상태', '자료 / 참조', '메모'], evidenceRows) + `<p class="note">${e(readiness.note)}</p>` + (readiness.exampleCount ? '<p class="banner">합성 예시 입력이 포함되어 있습니다. 특정 업체나 현장 공장을 조사한 데이터가 아닙니다.</p>' : ''))}
  ${section('3. 평면 기하 검사', issues.length ? list(issues.map(item => item.message)) : '<p>현재 모델에서 경계 이탈과 바닥 겹침이 발견되지 않았습니다. 동작·안전 검증은 별도입니다.</p>')}
  ${section('4. 평면 배치도와 설비 목록', renderLayoutPlanSvg(layout) + '<p class="note">현재 편집 배치의 평면도 · 표의 번호와 도면 번호가 대응합니다. 실측 도면이 아닙니다.</p>' + table(['번호','이름', '종류', 'X / Y', '가로 × 세로 × 높이', '회전', '작업시간'], assetRows))}
  ${section('5. 실행 근거 연결', table(['항목', '확인 내용'], runRows) + list(run.reasons) + (run.diagnostics.length ? list(run.diagnostics.map(item => item.message)) : '') + `<p class="note">${e(run.note)}</p>`)}
  ${section('6. 현재 실행기 적용 범위', compatibility.errors.length ? list(compatibility.errors) : '<p>현재 제한된 실행기 어댑터의 입력 조건에 맞습니다. 실행 성공 또는 물리 검증 통과를 의미하지 않습니다.</p>')}
  ${section('7. 입력 반경 기반 평면 검토', table(['항목', '참고 내용'], planningRows) + (planning.radius === null ? '<p>반경이 입력되지 않아 평면 원 검토 결과를 제시하지 않습니다.</p>' : list(planning.issues)) + `<p class="note">${e(planning.note)}</p>`)}
  ${diagnosticHtml}${aiHtml}${section('8. 다음 확인 항목', list(nextSteps))}${section('9. 보고서 해석 범위', list(limits))}
  <footer>RoboCell Studio · 배치 검토용 문서 · 승인서 또는 안전 인증서가 아닙니다.</footer></main></body></html>`;
  const text = [title, `생성 시각: ${created}`, scope, '', '배치 개요',
    `공장: ${format(layout.factory.width)} × ${format(layout.factory.depth)} × ${format(layout.factory.height)} m / ${format(metrics.area)} m²`,
    `전체 객체 ${layout.assets.length}개 / 설비 객체 ${metrics.assetCount}개 / 구역 ${zoneCount}개`,
    `설비 바닥 면적 합: ${format(metrics.occupiedArea)} m² / 통로 면적 합: ${format(metrics.walkwayArea)} m²`,
    `목표 생산량: ${format(layout.target_units_per_hour)}개/시간 (계획 입력값)`, '', '입력 근거',
    ...evidenceRows.map(row => row.join(' | ')), readiness.note, '', '평면 기하 검사',
    ...(issues.length ? issues.map(item => item.message) : ['경계 이탈과 바닥 겹침 없음. 동작·안전 검증은 별도.']),
    '', '설비와 구역', ...assetRows.map(row => row.join(' | ')), '', '실행 근거', ...runRows.map(row => row.join(': ')), ...run.reasons,
    ...run.diagnostics.map(item => item.message), run.note, '', '현재 실행기 적용 조건',
    ...(compatibility.errors.length ? compatibility.errors : ['제한된 어댑터 입력 조건 일치. 실행 또는 물리 검증 결과 아님.']),
    '', '입력 반경 기반 평면 검토', ...planningRows.map(row => row.join(': ')), ...(planning.radius === null ? [] : planning.issues), planning.note,
    ...(diagnosticInput?['','설비 상태 분석 근거',...diagnosticRows.map(row=>row.join(': ')),...diagnosticEvents.map(row=>row.join(' | '))]:[]),
    ...(ai?['','AI 검토 의견',`AWS Bedrock / ${ai.model} / ${ai.generated_at||''}`,ai.answer,...ai.citations.map(item=>`근거: ${item.evidence_id}.${item.field}`),...ai.unverified]:[]),
    '', '다음 확인 항목', ...nextSteps, '', '보고서 해석 범위', ...limits].join('\n');
  return { title, html, text, generatedAt: created, layoutFingerprint: fingerprintLayout(layout), summary, readiness, run, issues, compatibility,
    planningReview: planning, aiAnalysis:ai, schema_version: 'robocell-review-report/v1' };
}
