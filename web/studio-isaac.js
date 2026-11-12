import { normalizeLayout, validateLayout } from './studio-model.js';

// This adapter describes the existing, single-cell Isaac backend. It is not a
// physics, robot reachability, collision or safety validator.
const EPS = 1e-6;
const LEGACY_TYPES = new Map([
  ['robot-cell', '로봇 이송 셀'],
  ['walkway', '이동 통로'],
  ['worker-zone', '작업자 구역'],
]);
const close = (a, b) => Math.abs(a - b) <= EPS;
const between = (n, min, max) => n >= min - EPS && n <= max + EPS;
const tidy = n => Number(n.toFixed(6));
const rect = a => ({ x0: a.x - a.width / 2, x1: a.x + a.width / 2, y0: a.y - a.depth / 2, y1: a.y + a.depth / 2 });
const intersects = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS
  && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > EPS;

/**
 * Convert a studio-model layout into the existing POST /api/factory contract.
 *
 * The backend only changes the hall, one unrotated fixed robot cell, one full
 * length aisle band and one worker-zone rectangle. Requiring all three avoids
 * silently inheriting a template aisle or worker zone when the editor omitted it.
 *
 * @returns {{errors: string[], warnings: string[], payload: object|null}}
 * Never mutates the input and returns errors rather than throwing for invalid data.
 */
export function getIsaacCompatibility(raw) {
  const errors = [];
  const warnings = [];
  const result = payload => ({ errors: [...new Set(errors)], warnings: [...new Set(warnings)], payload });
  let layout;
  try {
    layout = normalizeLayout(raw);
  } catch (error) {
    errors.push(error.message || '공장 배치 형식을 확인해 주세요.');
    return result(null);
  }

  warnings.push('현재 Isaac 연동에는 공장·장비 높이, 목표 생산량, 작업시간이 반영되지 않습니다. 이 값은 웹 설계에만 저장됩니다.');
  const { width: length, depth: width } = layout.factory;
  // The old adapter accepts 12 m, but its cell-clearance interval is reversed
  // below 12.8 m. Reject that interval instead of relying on backend clamping.
  if (!between(length, 12.8, 80)) errors.push('Isaac 적용 시 공장 가로는 12.8~80 m여야 합니다.');
  if (!between(width, 8, 40)) errors.push('Isaac 적용 시 공장 세로는 8~40 m여야 합니다.');

  for (const issue of validateLayout(layout)) {
    if (issue.level === 'error') errors.push(issue.message);
  }
  const groups = new Map([...LEGACY_TYPES.keys()].map(type => [type, []]));
  for (const asset of layout.assets) {
    if (!groups.has(asset.type)) {
      errors.push(`${asset.name}: 개별 장비의 자유 배치는 아직 Isaac 서버에 적용할 수 없습니다. 고정 로봇 이송 셀을 사용해 주세요.`);
      continue;
    }
    groups.get(asset.type).push(asset);
    if (!close(asset.rotation, 0)) errors.push(`${asset.name}: 현재 Isaac 적용은 회전 0°만 지원합니다.`);
  }
  for (const [type, label] of LEGACY_TYPES) {
    if (groups.get(type).length !== 1) errors.push(`Isaac 적용에는 ${label}이(가) 정확히 1개 필요합니다.`);
  }

  const cell = groups.get('robot-cell').length === 1 ? groups.get('robot-cell')[0] : null;
  const walkway = groups.get('walkway').length === 1 ? groups.get('walkway')[0] : null;
  const worker = groups.get('worker-zone').length === 1 ? groups.get('worker-zone')[0] : null;
  let anchor = null;

  if (cell) {
    if (!close(cell.width, 11.6) || !close(cell.depth, 3.4)) {
      errors.push('Isaac 로봇 이송 셀의 바닥 크기는 11.6 × 3.4 m로 고정되어 있습니다.');
    }
    // Web assets are centred rectangles. The legacy backend expects the robot
    // base: cell footprint = anchor + X[-9.6, 2.0], Y[-2.3, 1.1].
    anchor = { x: cell.x + 3.8, y: cell.y + 0.6 };
    if (!between(anchor.x, 10.2, length - 2.6) || !between(anchor.y, 2.9, width - 1.7)) {
      errors.push('로봇 이송 셀 전체를 공장 경계에서 0.6 m 이상 안쪽에 배치해 주세요. 서버의 자동 위치 보정을 피하기 위한 조건입니다.');
    }
  }

  if (walkway) {
    if (!close(walkway.width, length) || !close(walkway.x, length / 2)) {
      errors.push('현재 Isaac 통로는 공장 가로 전체를 잇는 띠만 지원합니다. 통로 가로를 공장 가로와 같게, X를 공장 가로의 절반으로 맞춰 주세요.');
    }
    const band = rect(walkway);
    if (walkway.depth < 1 - EPS || band.y0 < 0.5 - EPS || band.y1 > width - 0.5 + EPS) {
      errors.push('Isaac 통로 폭은 1 m 이상이어야 하며, 세로 방향 양쪽 공장 경계에서 0.5 m 이상 떨어져야 합니다.');
    }
  }

  // Floor-plan overlap is only an editing check. For this limited template we
  // deliberately hold export instead of implying the physical scene is safe.
  if (cell && close(cell.rotation, 0)) {
    for (const zone of [walkway, worker]) {
      if (zone && close(zone.rotation, 0) && intersects(rect(cell), rect(zone))) {
        errors.push(`${cell.name}과(와) ${zone.name}의 바닥 영역이 겹칩니다. 겹침을 해소한 뒤 Isaac에 적용해 주세요.`);
      }
    }
  }
  if (walkway && worker && close(walkway.rotation, 0) && close(worker.rotation, 0)
      && intersects(rect(walkway), rect(worker))) {
    warnings.push('작업자 구역과 이동 통로가 겹칩니다. 두 구역은 바닥 표시로 전달되며 사람·차량 동선이나 안전성을 검증하지 않습니다.');
  }
  if (errors.length || !cell || !walkway || !worker || !anchor) return result(null);

  const aisle = rect(walkway);
  const workerZone = rect(worker);
  return result({
    name: layout.name,
    hall: { length_m: length, width_m: width },
    cell: { x: tidy(anchor.x), y: tidy(anchor.y), rotation_deg: 0 },
    aisle: { y0: tidy(aisle.y0), y1: tidy(aisle.y1) },
    worker_zone: Object.fromEntries(Object.entries(workerZone).map(([key, value]) => [key, tidy(value)])),
  });
}

/**
 * Verify the configuration echo before starting a newly configured Isaac job.
 * This compares server configuration values, not measured geometry or safety.
 * The legacy adapter rounds robot_base_expected to three decimal places and
 * omits the applied worker-zone coordinates from its response.
 */
export function validateIsaacResponse(payload, response) {
  const errors = [];
  const warnings = [];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const pair = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  const result = () => ({ errors: [...new Set(errors)], warnings: [...new Set(warnings)] });
  const expected = {
    hall: [payload?.hall?.length_m, payload?.hall?.width_m],
    robot_base_expected: [payload?.cell?.x, payload?.cell?.y],
    aisle: [payload?.aisle?.y0, payload?.aisle?.y1],
  };
  if (!object(payload) || !Object.values(expected).every(pair) || payload.cell?.rotation_deg !== 0) {
    errors.push('전송한 Isaac 배치 값을 확인할 수 없어 실행을 중단했습니다. 배치를 다시 적용해 주세요.');
    return result();
  }
  if (!object(response)) {
    errors.push('Isaac 서버가 올바른 환경 구성 응답을 반환하지 않아 실행을 중단했습니다.');
    return result();
  }
  if (typeof response.job_id !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(response.job_id)) {
    errors.push('Isaac 서버의 작업 번호가 유효하지 않아 실행할 수 없습니다.');
  }
  if (typeof response.scene_version !== 'string' || !response.scene_version.trim()) {
    errors.push('Isaac 서버 응답에 장면 버전이 없어 생성된 구성을 확인할 수 없습니다.');
  }
  if (!Array.isArray(response.warnings) || !response.warnings.every(value => typeof value === 'string')) {
    errors.push('Isaac 서버의 배치 보정 알림을 확인할 수 없어 실행을 중단했습니다.');
  } else {
    warnings.push(...response.warnings.filter(value => value.trim()).map(value => `Isaac 서버: ${value}`));
  }
  if (!object(response.derived)) {
    errors.push('Isaac 서버 응답에 적용된 배치 값(derived)이 없어 실행을 중단했습니다.');
    return result();
  }
  for (const [key, label] of [['hall', '공장 크기'], ['robot_base_expected', '로봇 셀 기준점'], ['aisle', '이동 통로']]) {
    const actual = response.derived[key];
    if (!pair(actual)) {
      errors.push(`Isaac 서버 응답에 유효한 ${label} 값이 없어 실행을 중단했습니다.`);
      continue;
    }
    // Up to 0.5 mm is lost by Python round(cx, 3), not a scene relocation.
    const tolerance = key === 'robot_base_expected' ? 0.0005 + EPS : EPS;
    if (actual.some((value, index) => Math.abs(value - expected[key][index]) > tolerance)) {
      errors.push(`${label}이(가) 입력과 다르게 설정되었습니다 (입력: ${expected[key].join(', ')} m / 서버: ${actual.join(', ')} m). 자동 보정된 배치를 실행하지 않았습니다.`);
    }
  }
  warnings.push('현재 서버 응답에는 작업자 구역의 적용 좌표가 없어 해당 구역은 자동 대조하지 못했습니다. 실행 화면에서 위치를 확인해 주세요.');
  if (Array.isArray(response.derived.removed_lathes) && response.derived.removed_lathes.length) {
    warnings.push(`공장 크기와 셀 위치에 맞춰 서버 템플릿의 가공설비 ${response.derived.removed_lathes.length}개가 제외되었습니다. 웹의 배치와 실제 장면 구성을 함께 확인해 주세요.`);
  }
  return result();
}
