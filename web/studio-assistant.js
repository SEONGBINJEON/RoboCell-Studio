import { computeLayoutMetrics, validateLayout } from './studio-model.js';
import { getIsaacCompatibility } from './studio-isaac.js';
import { summarizeProjectEvidence } from './studio-project-model.js';
import { buildReviewReport } from './studio-report.js';
import { analyzePlanningSafety } from './studio-safety.js';

/** Deterministic local lookup. Intentionally never labels itself generative AI. */
export function answerProjectQuestion(question, {layout, projectEvidence, runEvidence, safetySettings} = {}) {
  const q = String(question || '').normalize('NFKC').toLowerCase().slice(0,2000);
  const metrics = computeLayoutMetrics(layout), readiness = summarizeProjectEvidence(layout,projectEvidence);
  let answer, sources=[];
  if (/안전|펜스|울타리|반경|충돌|사람|작업자|위험/.test(q)) {
    const review=analyzePlanningSafety(layout,safetySettings);
    answer=`안전 승인 상태는 '미평가'입니다. ${review.radius===null?'검토 반경이 입력되지 않았습니다.':`입력 반경 ${review.radius}m 기준 평면 검토 항목은 ${review.issues.length}건입니다.`}\n${review.issues.slice(0,5).join('\n')}\n${review.note}\n로봇 모델·공구 및 이송물 범위, 접근 동선, 펜스·인터록, 보호정지 시간과 재시작 조건의 근거가 필요합니다.`;
    sources=['현재 배치 + 사용자가 입력한 검토 반경','ISO 10218-2:2025 / ISO 13855:2024: 적용 범위 참고'];
  } else if (/실행|아이작|isaac|변환|연동|지원/.test(q) && !/결과|양품|불량|생산성|효율|개선|보고서/.test(q)) {
    const result=getIsaacCompatibility(layout);
    answer=result.errors.length?`현재 실행기로 바로 전송할 수 없는 항목이 있습니다.\n${result.errors.join('\n')}\n현재는 로봇 셀 1개와 통로·작업자 구역을 지원합니다. 개별 설비는 3D 설계·저장 단계이며 Isaac Sim 일반화 연동이 필요합니다.`:'현재 배치는 기존 Isaac Sim 실행기의 입력 조건에 맞습니다. 실행 화면에서 배치를 확정한 뒤 구성·실행할 수 있습니다. 공장 높이·생산 목표·공정 시간은 계획값이며 실행기의 동작 조건에 적용되지 않습니다.';
    sources=['현재 배치의 실행 호환성 검사'];
  } else if (/결과|양품|불량|생산성|효율|개선|보고서/.test(q)) {
    const report=buildReviewReport({layout,projectEvidence,runEvidence});
    answer=report.run.included?`현재 배치와 연결된 작업 ${report.run.jobId}의 서버 관측값을 보고서에 포함할 수 있습니다.\n${Object.entries(report.run.metrics).map(([k,v])=>`${k}: ${v ?? '미수신'}`).join('\n')}\n같은 조건의 기준안·개선안 비교가 없으면 개선율을 산출하지 않습니다. 관측 카운터는 안전 검증 통과를 의미하지 않습니다.`:`현재 배치와 일치하는 실행 근거를 확정할 수 없습니다.\n${report.run.reasons.join('\n')}\n보고서에는 입력값과 미확인 항목을 먼저 정리할 수 있습니다.`;
    sources=['현재 배치와 실행 요청 사본 비교','서버 실행 기록(확보된 경우)'];
  } else if (/근거|출처|정확|신뢰|확인|자료/.test(q)) {
    answer=`입력 근거 ${readiness.confirmedCount}/${readiness.totalCount}개를 사용자가 확인했습니다. 이 개수는 정확도 점수나 인증률이 아닙니다.\n${readiness.fields.map(f=>`${f.label}: ${f.stale?'값 변경 · 재확인 필요':f.confirmed?'사용자 확인':'미확인'} / ${f.sourceLabel}${f.reference?` / ${f.reference}`:''}`).join('\n')}`;
    sources=['입력 근거 기록','현재 배치의 필드별 값'];
  } else if (/면적|설비|몇|배치|크기|가로|세로|공장/.test(q)) {
    const issues=validateLayout(layout);
    answer=`현재 배치: ${layout.name}\n공장 ${layout.factory.width} × ${layout.factory.depth} × ${layout.factory.height}m, 바닥 면적 ${metrics.area}m²입니다. 설비·셀 객체 ${metrics.assetCount}개와 구역 ${layout.assets.length-metrics.assetCount}개가 있습니다.\n평면 경계·겹침 확인 사항 ${issues.length}건${issues.length?`: ${issues.slice(0,3).map(i=>i.message).join(' / ')}`:'.'}\n이 값은 입력 모델에서 계산한 값이며 실제 현장 실측값이라는 의미는 아닙니다.`;
    sources=['현재 편집 중인 배치 모델'];
  } else {
    answer='현재는 생성형 AI가 연결되지 않은 로컬 자료 조회 모드입니다. 배치 면적·설비 수, Isaac Sim 실행 가능 여부, 입력 근거, 안전 검토 항목, 실행 결과에 대해 질문할 수 있습니다. 새 설계 제안이나 문서 자동 해석은 아직 수행하지 않습니다.';
    sources=['기능 상태'];
  }
  return {mode:'local_lookup',answer,sources,generatedAt:new Date().toISOString()};
}
