import { normalizeLayout, footprintCorners } from './studio-model.js';

const COLORS = Object.freeze({
  'robot-cell': ['#eee3b8', '#8b7737'],
  robot: ['#f1d272', '#93702a'],
  cnc: ['#e0e6eb', '#60707e'],
  conveyor: ['#cbd5dd', '#657988'],
  inspection: ['#d0e7e1', '#658e83'],
  buffer: ['#dfcdb5', '#927957'],
  'worker-zone': ['#e2efea', '#7a9f91'],
  walkway: ['#f1ecd5', '#b5a672'],
});
const ZONES = new Set(['worker-zone', 'walkway']);
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const n = value => String(Math.round(value * 10000) / 10000);
const metres = value => `${Number(value.toFixed(2))} m`;

function gridStep(span) {
  const target = span / 20;
  const unit = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].find(value => value * unit >= target) * unit;
}

/**
 * Static plan of entered layout geometry, not a physical/safety simulation.
 * SW is (0,0), +X is right, +Y is up, positive layout rotation is counterclockwise.
 * Numbers use original asset order so they match report rows. Compact mode shares
 * the exact framing and geometry, omitting visible text for small preview cards.
 */
export function renderLayoutPlanSvg(raw, { compact = false } = {}) {
  const layout = normalizeLayout(raw);
  const { width, depth } = layout.factory;
  const corners = layout.assets.flatMap(footprintCorners);
  const minX = Math.min(0, ...corners.map(point => point.x));
  const minY = Math.min(0, ...corners.map(point => point.y));
  const maxX = Math.max(width, ...corners.map(point => point.x));
  const maxY = Math.max(depth, ...corners.map(point => point.y));
  const scale = Math.min(840 / (maxX - minX), 480 / (maxY - minY));
  const left = 80 + (840 - (maxX - minX) * scale) / 2;
  const top = 66 + (480 - (maxY - minY) * scale) / 2;
  const px = x => left + (x - minX) * scale;
  const py = y => top + (maxY - y) * scale;
  const line = (x1, y1, x2, y2, extra = '') => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ${extra}/>`;
  const text = (x, y, value, extra = '') => `<text x="${n(x)}" y="${n(y)}" ${extra}>${escape(value)}</text>`;
  const pieces = [];
  const title = `${layout.name} — 공장 배치도 ${metres(width)} × ${metres(depth)}`;
  pieces.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 660" role="img" aria-label="${escape(title)}" class="layout-plan" preserveAspectRatio="xMidYMid meet">`);
  pieces.push(`<title>${escape(title)}</title><desc>입력된 바닥 면적과 회전각을 표시한 평면도. 남서쪽 원점, X축 동쪽, Y축 북쪽. 설비 번호는 입력 목록 순서입니다. 안전 거리 또는 시뮬레이션 결과를 의미하지 않습니다.</desc>`);
  pieces.push('<g font-family="IBM Plex Sans KR, Pretendard, sans-serif" font-variant-numeric="tabular-nums" fill="#46535f">');
  pieces.push('<rect width="1000" height="660" fill="#ffffff"/>');
  if (!compact) pieces.push(text(38, 31, '공장 배치 평면도', 'font-size="16" font-weight="500"'), text(962, 31, '입력 배치 · 단위 m', 'font-size="12" text-anchor="end" fill="#77838e"'));
  pieces.push(`<rect class="factory-floor" x="${n(px(0))}" y="${n(py(depth))}" width="${n(width * scale)}" height="${n(depth * scale)}" fill="#f7f9fa"/>`);
  const step = gridStep(Math.max(width, depth));
  pieces.push('<g class="plan-grid" stroke="#e4e9ed" stroke-width="0.65">');
  for (let x = step; x < width - 1e-8; x += step) pieces.push(line(px(x), py(0), px(x), py(depth)));
  for (let y = step; y < depth - 1e-8; y += step) pieces.push(line(px(0), py(y), px(width), py(y)));
  pieces.push('</g>');

  // Draw zones first, preserving the original index for both labels and accessibility.
  const indexed = layout.assets.map((asset, index) => ({ asset, index }));
  indexed.sort((a, b) => Number(ZONES.has(b.asset.type)) - Number(ZONES.has(a.asset.type)));
  for (const { asset, index } of indexed) {
    const [fill, normalStroke] = COLORS[asset.type];
    const outside = footprintCorners(asset).some(point => point.x < -1e-6 || point.y < -1e-6 || point.x > width + 1e-6 || point.y > depth + 1e-6);
    const stroke = outside ? '#b35f51' : normalStroke;
    const w = asset.width * scale, d = asset.depth * scale;
    const zone = ZONES.has(asset.type);
    const number = String(index + 1).padStart(2, '0');
    const description = `${number} · ${asset.name} · ${metres(asset.width)} × ${metres(asset.depth)} · ${n(asset.rotation)}°${outside ? ' · 공장 경계 밖' : ''}`;
    pieces.push(`<g data-asset-id="${escape(asset.id)}" data-index="${index + 1}" data-outside="${outside}" transform="translate(${n(px(asset.x))} ${n(py(asset.y))}) rotate(${n(-asset.rotation)})"><title>${escape(description)}</title>`);
    pieces.push(`<rect class="asset-footprint" x="${n(-w / 2)}" y="${n(-d / 2)}" width="${n(w)}" height="${n(d)}" fill="${fill}" stroke="${stroke}" stroke-width="${zone ? '1' : '1.3'}"${zone ? ' stroke-dasharray="5 3"' : ''}/>`);
    // Small plan symbols describe the asset type without inventing internal dimensions.
    if (asset.type === 'cnc') {
      pieces.push(`<rect x="${n(-w * .32)}" y="${n(-d * .28)}" width="${n(w * .64)}" height="${n(d * .48)}" fill="none" stroke="${stroke}" stroke-width="0.8"/>`);
      pieces.push(line(-w * .3, d * .36, w * .3, d * .36, `stroke="${stroke}" stroke-width="2"`));
    } else if (asset.type === 'robot') {
      const radius = Math.min(w, d) * .3;
      pieces.push(`<circle r="${n(radius)}" fill="none" stroke="${stroke}" stroke-width="0.9"/>`);
      pieces.push(line(0, 0, w * .23, -d * .2, `stroke="${stroke}" stroke-width="2"`));
    } else if (asset.type === 'buffer') {
      for (const fraction of [-1 / 6, 1 / 6]) pieces.push(line(w * fraction, -d * .35, w * fraction, d * .35, `stroke="${stroke}" stroke-width="0.7"`));
    } else if (asset.type === 'conveyor') {
      for (let i = 1; i <= 7; i++) pieces.push(line(-w / 2 + w * i / 8, -d * .35, -w / 2 + w * i / 8, d * .35, `stroke="${stroke}" stroke-width="0.8"`));
    }
    pieces.push('</g>');
  }
  pieces.push(`<rect class="factory-boundary" x="${n(px(0))}" y="${n(py(depth))}" width="${n(width * scale)}" height="${n(depth * scale)}" fill="none" stroke="#7d8994" stroke-width="1.25"/>`);
  if (!compact) {
    pieces.push('<g class="asset-labels" font-size="12" font-weight="500" text-anchor="middle" dominant-baseline="central" fill="#35434e" stroke="#ffffff" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">');
    for (const { asset, index } of indexed) pieces.push(text(px(asset.x), py(asset.y), String(index + 1).padStart(2, '0')));
    pieces.push('</g>');
    const dy = py(0) + 28, dx = px(0) - 28;
    pieces.push('<g class="plan-dimensions" stroke="#87929c" stroke-width="0.85" fill="none">');
    pieces.push(line(px(0), py(0) + 6, px(0), dy + 6), line(px(width), py(0) + 6, px(width), dy + 6), line(px(0), dy, px(width), dy));
    pieces.push(line(px(0) - 6, py(0), dx - 6, py(0)), line(px(0) - 6, py(depth), dx - 6, py(depth)), line(dx, py(0), dx, py(depth)));
    for (const [x, y] of [[px(0), dy], [px(width), dy], [dx, py(0)], [dx, py(depth)]]) pieces.push(line(x - 3, y + 3, x + 3, y - 3));
    pieces.push('</g>');
    pieces.push(text((px(0) + px(width)) / 2, dy + 19, metres(width), 'font-size="13" text-anchor="middle"'));
    const middleY = (py(0) + py(depth)) / 2;
    pieces.push(text(dx - 13, middleY, metres(depth), `font-size="13" text-anchor="middle" transform="rotate(-90 ${n(dx - 13)} ${n(middleY)})"`));
    pieces.push('<g class="plan-origin" stroke="#607382" stroke-width="1.2">', line(px(0), py(0), px(0) + 25, py(0)), line(px(0), py(0), px(0), py(0) - 25), '</g>');
    pieces.push(text(px(0) + 30, py(0) + 4, 'X', 'font-size="10"'), text(px(0) - 3, py(0) - 31, 'Y', 'font-size="10" text-anchor="middle"'));
    pieces.push(text(38, 630, '설비 번호는 입력 목록 순서 · 치수 및 외형은 입력값 기준', 'font-size="12" fill="#77838e"'));
  }
  pieces.push('</g></svg>');
  return pieces.join('');
}
