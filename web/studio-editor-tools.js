import { normalizeLayout, footprintCorners } from './studio-model.js';

const EPS = 1e-6;
const zeroNoise = value => Math.abs(value) < 1e-10 ? 0 : value;

/** Coordinates refer to the saved floor plan, independent of the camera view.
 * front = minimum Y edge; back = maximum Y edge. These are geometric tools,
 * not collision avoidance, robot reachability, or safety clearance checks.
 */
export const ALIGNMENTS = Object.freeze([
  Object.freeze({ id: 'center', label: '공장 중앙', description: 'X·Y 중심을 공장 중심에 맞춥니다.' }),
  Object.freeze({ id: 'x-center', label: '가로 중앙', description: 'X 중심을 공장 가로 중심에 맞춥니다.' }),
  Object.freeze({ id: 'y-center', label: '세로 중앙', description: 'Y 중심을 공장 세로 중심에 맞춥니다.' }),
  Object.freeze({ id: 'left', label: '왼쪽 경계', description: '회전된 바닥 영역의 X 최소값을 0에 맞춥니다.' }),
  Object.freeze({ id: 'right', label: '오른쪽 경계', description: '회전된 바닥 영역을 공장 가로 끝에 맞춥니다.' }),
  Object.freeze({ id: 'front', label: '앞쪽 경계 · Y=0', description: '회전된 바닥 영역의 Y 최소값을 0에 맞춥니다.' }),
  Object.freeze({ id: 'back', label: '뒤쪽 경계 · Y 최대', description: '회전된 바닥 영역을 공장 세로 끝에 맞춥니다.' }),
]);
const alignmentIds = new Set(ALIGNMENTS.map(item => item.id));

function geometryFor(layout, asset) {
  const corners = footprintCorners(asset).map(p => ({ x: zeroNoise(p.x), y: zeroNoise(p.y) }));
  const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
  const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y));
  const width = maxX - minX, depth = maxY - minY;
  const clearances = { left: zeroNoise(minX), right: zeroNoise(layout.factory.width - maxX),
    front: zeroNoise(minY), back: zeroNoise(layout.factory.depth - maxY) };
  return { assetId: asset.id, corners,
    bounds: { minX, maxX, minY, maxY, width, depth }, clearances,
    area: asset.width * asset.depth,
    boundingArea: width * depth,
    inBounds: Object.values(clearances).every(distance => distance >= -EPS),
    fitsFactory: width <= layout.factory.width + EPS && depth <= layout.factory.depth + EPS,
    heightClearance: zeroNoise(layout.factory.height - asset.height),
  };
}

/** Missing/no selection returns null. Malformed layouts are rejected using the
 * common model validator; negative clearances are retained to expose overflow.
 */
export function getSelectionGeometry(raw, selectedId) {
  const layout = normalizeLayout(raw);
  const asset = layout.assets.find(item => item.id === selectedId);
  return asset ? geometryFor(layout, asset) : null;
}

/** Returns an independent normalized layout. The aligned edge uses the rotated
 * footprint's bounds, not unrotated width/depth. The other coordinate is kept
 * unless it is outside the feasible interval, in which case it is brought into
 * the factory. An oversized footprint is rejected before any clamping.
 * Existing geometry overlap and Isaac's wall margin rules remain separate.
 */
export function alignAsset(raw, selectedId, anchor) {
  if (!alignmentIds.has(anchor)) throw new RangeError('지원하지 않는 배치 정렬입니다.');
  const layout = normalizeLayout(raw);
  const asset = layout.assets.find(item => item.id === selectedId);
  if (!asset) throw new Error('정렬할 설비를 먼저 선택해 주세요.');
  const geometry = geometryFor(layout, asset);
  if (!geometry.fitsFactory) throw new RangeError('회전된 설비의 바닥 영역이 공장보다 큽니다. 크기나 회전을 조정한 뒤 정렬해 주세요.');
  const halfX = geometry.bounds.width / 2, halfY = geometry.bounds.depth / 2;
  const w = layout.factory.width, d = layout.factory.depth;
  const clampCenter = (value, halfSpan, extent) => {
    const lo = halfSpan, hi = extent - halfSpan;
    // Equal-sized footprints can differ by floating-point noise only. Never
    // feed a reversed interval to a generic clamp or create a negative center.
    return lo > hi ? extent / 2 : Math.max(lo, Math.min(hi, value));
  };
  asset.x = clampCenter(asset.x, halfX, w);
  asset.y = clampCenter(asset.y, halfY, d);
  switch (anchor) {
    case 'center': asset.x = w / 2; asset.y = d / 2; break;
    case 'x-center': asset.x = w / 2; break;
    case 'y-center': asset.y = d / 2; break;
    case 'left': asset.x = halfX; break;
    case 'right': asset.x = w - halfX; break;
    case 'front': asset.y = halfY; break;
    case 'back': asset.y = d - halfY; break;
  }
  asset.x = zeroNoise(asset.x); asset.y = zeroNoise(asset.y);
  return layout;
}
