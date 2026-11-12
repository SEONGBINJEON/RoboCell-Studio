import { normalizeLayout } from './studio-model.js';

// A planning overlay only. No robot kinematics, stop-time model or safety-rated IO.
export function normalizeSafetySettings(raw = {}) {
  const radius = raw.radius === null || raw.radius === '' || raw.radius === undefined ? null : Number(raw.radius);
  if (radius !== null && (!Number.isFinite(radius) || radius < .1 || radius > 20)) throw new Error('검토 반경은 0.1~20m로 입력하세요.');
  return { radius, source: ['example','userprovided','assumption'].includes(raw.source) ? raw.source : 'assumption', reference: String(raw.reference || '').slice(0, 500) };
}

export function robotPlanAnchor(asset) {
  if (!['robot','robot-cell'].includes(asset.type)) return null;
  const theta = asset.rotation * Math.PI / 180;
  const dx = asset.type === 'robot-cell' ? 3.8 * asset.width / 11.6 : 0;
  const dy = asset.type === 'robot-cell' ? .6 * asset.depth / 3.4 : 0;
  return { x: asset.x + dx * Math.cos(theta) - dy * Math.sin(theta), y: asset.y + dx * Math.sin(theta) + dy * Math.cos(theta) };
}

export function distanceToFootprint(point, asset) {
  const theta = -asset.rotation * Math.PI / 180, dx = point.x - asset.x, dy = point.y - asset.y;
  const x = dx * Math.cos(theta) - dy * Math.sin(theta), y = dx * Math.sin(theta) + dy * Math.cos(theta);
  return Math.hypot(Math.max(0, Math.abs(x) - asset.width / 2), Math.max(0, Math.abs(y) - asset.depth / 2));
}

export function analyzePlanningSafety(rawLayout, rawSettings = {}) {
  const layout = normalizeLayout(rawLayout), settings = normalizeSafetySettings(rawSettings);
  const note = '입력한 반경을 바닥에 투영한 설계 참고 영역입니다. 실제 로봇 최대 도달거리·공구·이송물·정지거리·펜스 및 인터록의 검증을 대체하지 않습니다.';
  const result = { status:'not_assessed', ...settings, envelopes:[], issues:[], note };
  if (settings.radius === null) { result.issues.push('로봇 모델·공구의 도달거리 자료와 검토 반경이 입력되지 않았습니다.'); return result; }
  for (const asset of layout.assets.filter(a => ['robot','robot-cell'].includes(a.type))) {
    const center = robotPlanAnchor(asset), radius = settings.radius;
    const overlaps = layout.assets.filter(a => ['worker-zone','walkway'].includes(a.type)).map(zone => ({id:zone.id,name:zone.name,type:zone.type,distance:distanceToFootprint(center, zone)})).filter(zone => zone.distance <= radius + 1e-8);
    const outsideFactory = center.x - radius < 0 || center.x + radius > layout.factory.width || center.y - radius < 0 || center.y + radius > layout.factory.depth;
    result.envelopes.push({assetId:asset.id,name:asset.name,center,radius,overlaps,outsideFactory});
    overlaps.forEach(zone => result.issues.push(`${asset.name}: 입력 반경 ${radius}m가 ${zone.name}과 겹칩니다. 배치·작업 동선 검토가 필요합니다.`));
    if (outsideFactory) result.issues.push(`${asset.name}: 입력 반경이 공장 바닥 경계를 벗어납니다.`);
  }
  if (!result.envelopes.length) result.issues.push('배치에 검토 대상 로봇이 없습니다.');
  return result;
}
