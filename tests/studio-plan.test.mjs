import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout, normalizeLayout, footprintCorners } from '../web/studio-model.js';
import { renderLayoutPlanSvg } from '../web/studio-plan.js';

function assetGeometry(svg, id) {
  const group = svg.match(new RegExp(`<g data-asset-id="${id}"[^>]*transform="translate\\(([-\\d.]+) ([-\\d.]+)\\) rotate\\(([-\\d.]+)\\)"[^>]*>([\\s\\S]*?)</g>`));
  assert.ok(group, `asset ${id} is present`);
  const rect = group[4].match(/class="asset-footprint" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/);
  return { x:+group[1], y:+group[2], angle:+group[3], left:+rect[1], top:+rect[2], width:+rect[3], depth:+rect[4] };
}

test('plan escapes untrusted names in text and attributes and contains only static SVG', () => {
  const raw = createDefaultLayout();
  raw.name = '" onload="alert(1) <script>&';
  raw.assets[0].name = '<foreignObject><script>alert(1)</script></foreignObject>';
  const svg = renderLayoutPlanSvg(raw);
  assert.match(svg, /aria-label="&quot; onload=&quot;alert\(1\) &lt;script&gt;&amp;/);
  assert.match(svg, /&lt;foreignObject&gt;&lt;script&gt;/);
  assert.doesNotMatch(svg, /<(?:script|foreignObject|image|use|animate|style)\b|\shref=|\sonload="/i);
  assert.match(svg, /<title>/);
});

test('normalizes supported input without mutation and rejects invalid geometry', () => {
  const raw = createDefaultLayout();
  raw.factory.width = '24';
  raw.assets[0].rotation = -90;
  delete raw.assets[0].width;
  const before = structuredClone(raw);
  assert.equal(renderLayoutPlanSvg(raw), renderLayoutPlanSvg(normalizeLayout(raw)));
  assert.deepEqual(raw, before);
  raw.factory.depth = Infinity;
  assert.throws(() => renderLayoutPlanSvg(raw));
});

test('SVG footprint rotation and SW coordinate projection match model corners', () => {
  for (const rotation of [0, 30, 90, 180, 270, -45]) {
    const raw = createDefaultLayout();
    raw.assets = [{ ...raw.assets[0], id:'machine', type:'cnc', width:4, depth:2, x:8, y:7, rotation }];
    const layout = normalizeLayout(raw);
    const svg = renderLayoutPlanSvg(raw);
    const geometry = assetGeometry(svg, 'machine');
    const floor = svg.match(/class="factory-floor" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/);
    const scale = +floor[3] / layout.factory.width;
    const radians = geometry.angle * Math.PI / 180;
    // Local physical Y is reflected before applying SVG's downward-axis rotation.
    const actual = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([dx,dy]) => {
      const x = dx * geometry.width / 2, y = -dy * geometry.depth / 2;
      return { x:geometry.x + x * Math.cos(radians) - y * Math.sin(radians), y:geometry.y + x * Math.sin(radians) + y * Math.cos(radians) };
    });
    const expected = footprintCorners(layout.assets[0]).map(point => ({ x:+floor[1] + point.x * scale, y:+floor[2] + (layout.factory.depth - point.y) * scale }));
    actual.forEach((point,index) => {
      assert.ok(Math.abs(point.x - expected[index].x) < .001, `${rotation}° X corner ${index}`);
      assert.ok(Math.abs(point.y - expected[index].y) < .001, `${rotation}° Y corner ${index}`);
    });
  }
});

test('compact plan preserves framing and footprints while omitting visible text', () => {
  const raw = createDefaultLayout();
  const full = renderLayoutPlanSvg(raw), compact = renderLayoutPlanSvg(raw, {compact:true});
  assert.equal(full.match(/viewBox="[^"]+"/)[0], compact.match(/viewBox="[^"]+"/)[0]);
  for (const asset of raw.assets) assert.deepEqual(assetGeometry(full,asset.id), assetGeometry(compact,asset.id));
  assert.doesNotMatch(compact, /<text\b/);
  assert.match(full, />24 m<\/text>/);
  assert.match(full, />18 m<\/text>/);
});

test('zones draw underneath equipment without changing report indices; outside assets remain visible', () => {
  const raw = createDefaultLayout();
  raw.assets[0].x = -10;
  const svg = renderLayoutPlanSvg(raw);
  assert.ok(svg.indexOf('data-asset-id="walkway-01"') < svg.indexOf('data-asset-id="cell-01"'));
  assert.match(svg, /data-asset-id="cell-01" data-index="1" data-outside="true"/);
  const geometry = assetGeometry(svg, 'cell-01');
  assert.ok(geometry.x - geometry.width / 2 >= 79.99);
  assert.ok(geometry.x + geometry.width / 2 <= 920.01);
});
