import { CATALOG, normalizeLayout, computeLayoutMetrics } from './studio-model.js';
import { fingerprintLayout } from './studio-runtime.js';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const text = (value, limit = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const catalog = new Map(CATALOG.map(item => [item.type, item]));
const sources = new Set(['userprovided', 'assumption', 'example']);
const sourceOf = value => sources.has(value) ? value : 'assumption';
export const EVIDENCE_SOURCES = freeze({ userprovided: '사용자 제공', assumption: '가정', example: '합성 예시' });
export const EVIDENCE_FIELDS = freeze([
  { id: 'dimensions', label: '공장 치수', description: '가로·세로·높이의 도면 또는 실측 근거' },
  { id: 'equipment', label: '설비 목록과 크기', description: '설비 종류·수량·외형 치수의 근거' },
  { id: 'placement', label: '설비 배치', description: '설비와 구역의 위치·회전 근거' },
  { id: 'processTimes', label: '공정 작업시간', description: '설비별 작업시간의 측정 또는 공정표 근거' },
  { id: 'productionTarget', label: '생산 목표', description: '시간당 목표 수량의 요구사항 근거' },
  { id: 'materialFlow', label: '자재 흐름', description: '투입·가공·검사·배출의 연결 순서와 운반 방식' },
]);

const templateSpecs = freeze([
  { id: 'machining-baseline', name: '가공 이송 기본형', category: '가공 · 이송', width: 24, depth: 18, height: 6, target: 90,
    description: '고정 로봇 이송 셀과 이동 통로를 배치한 기본 예시',
    assets: [
      ['robot-cell', '로봇 이송 셀', 12, 10],
      ['walkway', '주 이동 통로', 12, 4.5, { width: 24 }],
      ['worker-zone', '작업 준비 구역', 18, 6.5],
    ] },
  { id: 'machining-automation', name: '정밀가공 자동화 라인', category: '가공 · 자동화', width: 24, depth: 18, height: 6, target: 120,
    description: 'CNC 10대와 이송 로봇 2대를 중심으로 투입·검사·작업자 동선을 구성한 배치 예시',
    assets: [
      ...[4,8,12,16,20].map((x,i)=>['cnc',`CNC A-${String(i+1).padStart(2,'0')}`,x,13.5,{processTime:35}]),
      ...[4,8,12,16,20].map((x,i)=>['cnc',`CNC B-${String(i+1).padStart(2,'0')}`,x,8,{processTime:35,rotation:180}]),
      ['robot', '가공 이송 R-01', 7, 10.8], ['robot', '가공 이송 R-02', 17, 10.8],
      ['conveyor', '소재 투입', 6, 5.2, {width:7}], ['conveyor', '검사 이송', 17, 5.2, {width:6}],
      ['inspection', '치수 측정', 21.5, 3, { processTime: 18 }], ['buffer', '원자재 적치', 3, 3],
      ['buffer', '출하 적치', 18.5, 3], ['worker-zone', '작업 준비 구역', 10.5, 3.2, { width:4, depth:2 }],
      ['walkway', '주 이동 통로', 12, 1, {width:24,depth:1.5}],
    ] },
  { id: 'inspection-packing', name: '검사 · 포장형', category: '검사 · 포장', width: 26, depth: 18, height: 5, target: 180,
    description: '검사대와 포장 작업 구역, 출하 적치를 나눈 예시',
    assets: [
      ['conveyor', '검사 투입', 7, 6, { width: 5 }], ['conveyor', '포장 배출', 16, 6, { width: 5 }],
      ['inspection', '외관 검사', 7, 11, { processTime: 15 }], ['inspection', '최종 검사', 15, 11, { processTime: 20 }],
      ['worker-zone', '포장 작업 구역', 7, 15, { width: 4 }], ['worker-zone', '라벨 작업 구역', 15, 15, { width: 4 }],
      ['buffer', '입고 적치', 22, 7, { width: 2.5, depth: 2 }], ['buffer', '출하 적치', 22, 13, { width: 2.5, depth: 2 }],
      ['walkway', '주 이동 통로', 13, 2, { width: 26, depth: 2 }],
    ] },
  { id: 'assembly-logistics', name: '조립 · 자재 물류형', category: '조립 · 물류', width: 32, depth: 24, height: 6, target: 100,
    description: '조립 지원 로봇과 자재 적치, 작업 구역을 구성한 예시',
    assets: [
      ['robot', '조립 지원 로봇 1', 10, 10], ['robot', '조립 지원 로봇 2', 22, 10],
      ['buffer', '부품 적치 1', 5, 7, { width: 3, depth: 2 }], ['buffer', '부품 적치 2', 27, 7, { width: 3, depth: 2 }],
      ['buffer', '조립 작업대 1', 10, 14, { width: 3, depth: 2, processTime: 40 }],
      ['buffer', '조립 작업대 2', 22, 14, { width: 3, depth: 2, processTime: 45 }],
      ['worker-zone', '조립 작업 구역 1', 10, 18, { width: 4, depth: 3 }],
      ['worker-zone', '조립 작업 구역 2', 22, 18, { width: 4, depth: 3 }],
      ['conveyor', '중앙 자재 이송', 16, 6, { width: 8 }], ['inspection', '출하 전 검사', 28, 17, { processTime: 20 }],
      ['walkway', '주 이동 통로', 16, 2.5, { width: 32, depth: 2 }],
    ] },
]);

export const FACTORY_TEMPLATES = freeze(templateSpecs.map(spec => ({
  id: spec.id, name: spec.name, label: spec.name, category: spec.category, description: spec.description,
  width: spec.width, depth: spec.depth, height: spec.height, area: spec.width * spec.depth,
  assetCount: spec.assets.length, equipmentCount: spec.assets.filter(([type]) => !['walkway', 'worker-zone'].includes(type)).length,
  source: 'example', dataOrigin: 'synthetic', sourceLabel: '합성 예시 · 현장 실측 데이터 아님',
})));

export function getFactoryTemplates() { return FACTORY_TEMPLATES; }

/** Fresh mutable normalized layout. No backend capability is promised by a template. */
export function createTemplate(id) {
  const spec = templateSpecs.find(item => item.id === id);
  if (!spec) throw new Error('공장 예시를 찾지 못했습니다.');
  return normalizeLayout({
    name: `합성 예시 · ${spec.name}`, factory: { width: spec.width, depth: spec.depth, height: spec.height }, target_units_per_hour: spec.target,
    assets: spec.assets.map(([type, name, x, y, overrides = {}], index) => {
      const item = catalog.get(type);
      return { id: `${spec.id}-${index + 1}`, type, name, x, y, rotation: 0, width: item.width, depth: item.depth, height: item.height, processTime: 0, ...overrides };
    }),
  });
}

function fieldValues(layout, evidence) {
  const assets = [...layout.assets].sort((a, b) => a.id.localeCompare(b.id));
  return {
    dimensions: layout.factory,
    equipment: assets.map(({ id, type, name, width, depth, height }) => ({ id, type, name, width, depth, height })),
    placement: assets.map(({ id, x, y, rotation, width, depth }) => ({ id, x, y, rotation, width, depth })),
    processTimes: assets.filter(a => !['walkway', 'worker-zone'].includes(a.type)).map(({ id, processTime }) => ({ id, processTime })),
    productionTarget: layout.target_units_per_hour,
    materialFlow: { sequence: text(evidence?.fields?.materialFlow?.value, 2000), assets: assets.map(a => a.id) },
  };
}

// Persisted confirmation must carry its original field snapshot. A missing or
// malformed key is never repaired into a confirmation of today's input values.
function validFieldValueKey(id, key) {
  if (typeof key !== 'string' || !key.length || key.length > 100_000) return false;
  let value;
  try { value = JSON.parse(key); } catch { return false; }
  const numbers = (item, keys) => record(item) && keys.every(k => typeof item[k] === 'number' && Number.isFinite(item[k]));
  const identity = item => record(item) && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.id);
  if (id === 'dimensions') return numbers(value, ['width', 'depth', 'height']);
  if (id === 'productionTarget') return typeof value === 'number' && Number.isFinite(value);
  if (id === 'materialFlow') return record(value) && typeof value.sequence === 'string'
    && Array.isArray(value.assets) && value.assets.length <= 100 && value.assets.every(assetId => typeof assetId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(assetId));
  if (!Array.isArray(value) || value.length > 100 || !value.every(identity)) return false;
  if (id === 'equipment') return value.every(item => typeof item.name === 'string' && catalog.has(item.type) && numbers(item, ['width', 'depth', 'height']));
  if (id === 'placement') return value.every(item => numbers(item, ['x', 'y', 'rotation', 'width', 'depth']));
  if (id === 'processTimes') return value.every(item => numbers(item, ['processTime']));
  return false;
}

/** Existing field valueKey values are retained so later edits cannot silently
 * turn an old confirmation into confirmation of new measurements. */
export function createProjectEvidence(raw, options = {}) {
  const layout = normalizeLayout(raw), base = record(options) ? options : {};
  const values = fieldValues(layout, base), defaultSource = sourceOf(base.source);
  const fields = Object.fromEntries(EVIDENCE_FIELDS.map(field => {
    const input = record(base.fields?.[field.id]) ? base.fields[field.id] : {};
    const source = sourceOf(input.source ?? defaultSource);
    return [field.id, {
      source, status: input.status === 'confirmed' && source === 'userprovided' && validFieldValueKey(field.id, input.valueKey) ? 'confirmed' : 'unverified',
      note: text(input.note, 2000), reference: text(input.reference, 500),
      valueKey: typeof input.valueKey === 'string' ? input.valueKey.slice(0, 100_000) : JSON.stringify(values[field.id]),
      ...(field.id === 'materialFlow' ? { value: values.materialFlow.sequence } : {}),
    }];
  }));
  return { schema_version: 'robocell-project-evidence/v1', source: defaultSource,
    templateId: templateSpecs.some(item => item.id === base.templateId) ? base.templateId : null,
    layoutFingerprint: fingerprintLayout(layout), fields };
}

/** Explicit field edit/confirmation binds that field to the current values. */
export function updateProjectEvidenceField(raw, evidence, id, patch = {}) {
  if (!EVIDENCE_FIELDS.some(field => field.id === id)) throw new Error('입력 근거 항목을 찾지 못했습니다.');
  const next = createProjectEvidence(raw, evidence);
  next.fields[id] = { ...next.fields[id], ...patch };
  if (patch.status === 'confirmed') next.fields[id].valueKey = JSON.stringify(fieldValues(normalizeLayout(raw), next)[id]);
  return createProjectEvidence(raw, next);
}

export function confirmEvidenceField(raw, evidence, id, { source = 'userprovided', reference = '', note = '', ...rest } = {}) {
  return updateProjectEvidenceField(raw, evidence, id, { ...rest, source, reference, note, status: 'confirmed' });
}

export function summarizeProjectEvidence(raw, evidence) {
  const layout = normalizeLayout(raw), normalized = createProjectEvidence(layout, evidence), values = fieldValues(layout, normalized);
  const fields = EVIDENCE_FIELDS.map(field => {
    const item = normalized.fields[field.id], stale = item.valueKey !== JSON.stringify(values[field.id]);
    const missing = field.id === 'materialFlow' ? !values.materialFlow.sequence : field.id === 'equipment' ? !layout.assets.length :
      field.id === 'processTimes' ? !values.processTimes.length || values.processTimes.some(a => a.processTime === 0) : false;
    const status = item.status === 'confirmed' && !stale && !missing ? 'confirmed' : 'unverified';
    return { ...field, ...item, sourceLabel: EVIDENCE_SOURCES[item.source], stale, missing, status, confirmed: status === 'confirmed' };
  });
  const confirmedCount = fields.filter(field => field.confirmed).length;
  const gaps = fields.filter(field => !field.confirmed).map(field => ({ id: field.id, label: field.label,
    reason: field.stale ? '확인 이후 입력값이 바뀌었습니다.' : field.missing ? '필수 내용 또는 실측 작업시간이 비어 있습니다.' : '사용자 제공 근거와 확인이 필요합니다.' }));
  return { fields, totalCount: fields.length, confirmedCount, unverifiedCount: fields.length - confirmedCount,
    missingCount: fields.filter(field => field.missing).length, staleCount: fields.filter(field => field.stale).length,
    exampleCount: fields.filter(field => field.source === 'example').length, gaps,
    layoutFingerprint: fingerprintLayout(layout), metrics: computeLayoutMetrics(layout),
    note: '확인은 사용자가 입력 근거를 확인한 상태이며 독립 검증이나 안전 승인이 아닙니다.' };
}
