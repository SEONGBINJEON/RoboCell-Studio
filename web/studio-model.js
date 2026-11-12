// Browser-only layout data. Geometry checks below are 2D editing aids, not safety validation.
export const SCHEMA_VERSION = 'robocell-layout/v1';
export const CATALOG = Object.freeze([
  { type: 'robot-cell', label: '로봇 이송 셀', category: '템플릿', width: 11.6, depth: 3.4, height: 2.8, color: '#efc71d', description: '로봇·가공기·검사대·컨베이어를 묶은 기본 셀' },
  { type: 'robot', label: '산업용 로봇', category: '설비', width: 1.8, depth: 1.8, height: 2.4, color: '#f1c819', description: '받침대와 다관절 로봇의 배치용 형상' },
  { type: 'cnc', label: 'CNC 가공기', category: '설비', width: 2.8, depth: 2.4, height: 2.5, color: '#d8dfe0', description: '가공기 외함·도어·조작 패널' },
  { type: 'conveyor', label: '컨베이어', category: '이송', width: 4, depth: 0.9, height: 0.85, color: '#597077', description: '롤러와 프레임을 갖춘 이송 구간' },
  { type: 'inspection', label: '검사대', category: '설비', width: 1.7, depth: 1.4, height: 2.1, color: '#4d9b95', description: '검사 테이블·카메라·표시등' },
  { type: 'buffer', label: '부품 버퍼', category: '보관', width: 1.5, depth: 1.2, height: 0.9, color: '#b49369', description: '작업대 위 트레이와 부품 적치 공간' },
  { type: 'worker-zone', label: '작업자 구역', category: '구역', width: 3, depth: 2, height: 0.05, color: '#549798', description: '사람이 작업하는 구역의 평면 표시' },
  { type: 'walkway', label: '이동 통로', category: '구역', width: 16, depth: 1.5, height: 0.025, color: '#d6bd42', description: '보행·운반 통로의 평면 표시' },
]);
const CATALOG_MAP = new Map(CATALOG.map(item => [item.type, item]));
const ZONES = new Set(['worker-zone', 'walkway']);
const cleanText = (value, fallback, max = 80) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || fallback : fallback;
const finite = (value, name, min, max) => {
  if (value === null || typeof value === 'boolean' || value === '' || (typeof value === 'string' && !value.trim())) throw new Error(`${name} 값을 확인해 주세요.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name}은(는) ${min}~${max} 범위로 입력해 주세요.`);
  return number;
};

export function createAsset(type, index = 1) {
  const template = CATALOG_MAP.get(type);
  if (!template) throw new Error('지원하지 않는 장비입니다.');
  const seed = globalThis.crypto?.randomUUID?.().slice(0, 8) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { id: `${type}-${seed}`, type, name: `${template.label} ${index}`, x: 12, y: 9, rotation: 0, width: template.width, depth: template.depth, height: template.height, processTime: type === 'cnc' ? 30 : type === 'inspection' ? 20 : 0 };
}

export function createDefaultLayout() {
  return {
    schema_version: SCHEMA_VERSION,
    name: '금속 부품 이송·검사 라인',
    factory: { width: 24, depth: 18, height: 6 },
    target_units_per_hour: 90,
    assets: [
      { ...createAsset('robot-cell'), id: 'cell-01', name: '로봇 이송 셀', x: 12, y: 10 },
      { ...createAsset('walkway'), id: 'walkway-01', name: '주 이동 통로', x: 12, y: 4.5, width: 24 },
      { ...createAsset('worker-zone'), id: 'worker-zone-01', name: '작업자 준비 구역', x: 18, y: 6.5 },
    ],
  };
}

export function normalizeLayout(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('공장 배치 JSON 형식을 확인해 주세요.');
  if (raw.schema_version && raw.schema_version !== SCHEMA_VERSION) throw new Error('지원하지 않는 배치 파일 버전입니다.');
  const f = raw.factory;
  if (!f || typeof f !== 'object') throw new Error('공장 치수(factory)가 없습니다.');
  if (!Array.isArray(raw.assets) || raw.assets.length > 100) throw new Error('장비 목록은 최대 100개까지 사용할 수 있습니다.');
  const ids = new Set();
  const assets = raw.assets.map((a, i) => {
    if (!a || !CATALOG_MAP.has(a.type)) throw new Error(`${i + 1}번째 장비 종류를 확인해 주세요.`);
    const template = CATALOG_MAP.get(a.type);
    if (typeof a.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id) || ids.has(a.id)) throw new Error('장비 ID가 없거나 중복됩니다.');
    ids.add(a.id);
    return {
      id: a.id, type: a.type, name: cleanText(a.name, template.label),
      x: finite(a.x, 'X 좌표', -500, 500), y: finite(a.y, 'Y 좌표', -500, 500),
      rotation: ((finite(a.rotation ?? 0, '회전', -36000, 36000) % 360) + 360) % 360,
      width: finite(a.width ?? template.width, '장비 가로', 0.1, 200),
      depth: finite(a.depth ?? template.depth, '장비 세로', 0.1, 200),
      height: finite(a.height ?? template.height, '장비 높이', 0.01, 30),
      processTime: finite(a.processTime ?? 0, '작업시간', 0, 86400),
    };
  });
  return {
    schema_version: SCHEMA_VERSION,
    name: cleanText(raw.name, '새 공장 배치'),
    factory: { width: finite(f.width, '공장 가로', 4, 200), depth: finite(f.depth, '공장 세로', 4, 200), height: finite(f.height, '공장 높이', 2, 30) },
    target_units_per_hour: finite(raw.target_units_per_hour ?? 90, '목표 생산량', 1, 100000), assets,
  };
}

export function footprintCorners(asset) {
  const angle = asset.rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([dx,dy]) => ({
    x: asset.x + dx * asset.width * .5 * c - dy * asset.depth * .5 * s,
    y: asset.y + dx * asset.width * .5 * s + dy * asset.depth * .5 * c,
  }));
}

function overlaps(a, b) {
  const pa = footprintCorners(a), pb = footprintCorners(b);
  for (const poly of [pa, pb]) {
    for (let i = 0; i < 2; i++) {
      const dx = poly[i + 1].x - poly[i].x, dy = poly[i + 1].y - poly[i].y;
      const axis = { x: -dy, y: dx };
      const projection = points => points.map(p => p.x * axis.x + p.y * axis.y);
      const aa = projection(pa), bb = projection(pb);
      if (Math.max(...aa) <= Math.min(...bb) + 1e-6 || Math.max(...bb) <= Math.min(...aa) + 1e-6) return false;
    }
  }
  return true;
}

export function validateLayout(raw) {
  let layout;
  try { layout = normalizeLayout(raw); }
  catch (error) { return [{ level: 'error', message: error.message, assetIds: [] }]; }
  const issues = [];
  for (const asset of layout.assets) {
    if (footprintCorners(asset).some(p => p.x < -1e-6 || p.y < -1e-6 || p.x > layout.factory.width + 1e-6 || p.y > layout.factory.depth + 1e-6)) {
      issues.push({ level: 'error', message: `${asset.name}: 바닥 경계 밖으로 나간 부분이 있습니다.`, assetIds: [asset.id] });
    }
    if (asset.height > layout.factory.height) issues.push({ level: 'error', message: `${asset.name}: 장비 높이가 공장 높이보다 큽니다.`, assetIds: [asset.id] });
  }
  for (let i = 0; i < layout.assets.length; i++) {
    for (let j = i + 1; j < layout.assets.length; j++) {
      const a = layout.assets[i], b = layout.assets[j];
      if (ZONES.has(a.type) && ZONES.has(b.type)) continue;
      if (!overlaps(a, b)) continue;
      const zone = ZONES.has(a.type) || ZONES.has(b.type);
      issues.push({ level: 'warning', message: `${a.name} · ${b.name}: ${zone ? '장비 바닥 면적과 구역이 겹칩니다.' : '장비 바닥 면적이 겹칩니다.'}`, assetIds: [a.id, b.id] });
    }
  }
  return issues;
}

export function computeLayoutMetrics(layout) {
  const area = layout.factory.width * layout.factory.depth;
  return {
    area, areaPyeong: area / 3.305785,
    assetCount: layout.assets.filter(a => !ZONES.has(a.type)).length,
    occupiedArea: layout.assets.filter(a => !ZONES.has(a.type)).reduce((sum, a) => sum + a.width * a.depth, 0),
    walkwayArea: layout.assets.filter(a => a.type === 'walkway').reduce((sum, a) => sum + a.width * a.depth, 0),
  };
}
