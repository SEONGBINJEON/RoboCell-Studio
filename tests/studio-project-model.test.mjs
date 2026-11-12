import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLayout, validateLayout, createDefaultLayout } from '../web/studio-model.js';
import { getIsaacCompatibility } from '../web/studio-isaac.js';
import { fingerprintLayout } from '../web/studio-runtime.js';
import { FACTORY_TEMPLATES, getFactoryTemplates, createTemplate, createProjectEvidence, summarizeProjectEvidence, confirmEvidenceField, updateProjectEvidenceField } from '../web/studio-project-model.js';

test('four synthetic templates are distinct normalized layouts with clear provenance and fresh copies', () => {
  assert.equal(getFactoryTemplates().length, 4);
  const identities = new Set();
  for (const item of FACTORY_TEMPLATES) {
    assert.equal(item.dataOrigin, 'synthetic'); assert.equal(item.source, 'example');
    const layout = createTemplate(item.id); assert.deepEqual(normalizeLayout(layout), layout);
    assert.match(layout.name, /합성 예시/); assert.deepEqual(validateLayout(layout), []);
    identities.add(fingerprintLayout(layout)); layout.assets[0].x = 400;
    assert.notEqual(createTemplate(item.id).assets[0].x, 400);
  }
  assert.equal(identities.size, 4);
  assert.throws(() => { FACTORY_TEMPLATES[0].name = 'changed'; }, TypeError);
  assert.throws(() => createTemplate('unknown'), /찾지 못/);
});

test('only the baseline sample matches the existing limited adapter', () => {
  assert.deepEqual(getIsaacCompatibility(createTemplate('machining-baseline')).errors, []);
  for (const id of ['machining-automation', 'inspection-packing', 'assembly-logistics']) {
    assert.ok(getIsaacCompatibility(createTemplate(id)).errors.length > 0);
  }
});

test('default and synthetic evidence cannot imply confirmed site measurements', () => {
  const layout = createDefaultLayout();
  const summary = summarizeProjectEvidence(layout, createProjectEvidence(layout));
  assert.equal(summary.totalCount, 6); assert.equal(summary.confirmedCount, 0);
  assert.ok(summary.fields.find(item => item.id === 'materialFlow').missing);
  const example = createProjectEvidence(layout, { source: 'example', fields: { dimensions: { source: 'example', status: 'confirmed' } } });
  assert.equal(summarizeProjectEvidence(layout, example).exampleCount, 6);
  assert.equal(summarizeProjectEvidence(layout, example).confirmedCount, 0);
});

test('field confirmation is immutable, scoped to values and invalidated by later edits', () => {
  const layout = createDefaultLayout(), original = createProjectEvidence(layout);
  let evidence = confirmEvidenceField(layout, original, 'dimensions', { reference: '사용자 도면 A', note: '도면 치수 대조' });
  assert.equal(original.fields.dimensions.status, 'unverified');
  assert.equal(summarizeProjectEvidence(layout, evidence).confirmedCount, 1);
  layout.factory.width = 28;
  let summary = summarizeProjectEvidence(layout, evidence);
  assert.equal(summary.confirmedCount, 0); assert.equal(summary.fields[0].stale, true);
  evidence = updateProjectEvidenceField(layout, evidence, 'dimensions', { note: '메모만 수정' });
  assert.equal(summarizeProjectEvidence(layout, evidence).confirmedCount, 0);
  evidence = confirmEvidenceField(layout, evidence, 'dimensions', { reference: '새 도면 B' });
  assert.equal(summarizeProjectEvidence(layout, evidence).confirmedCount, 1);
  layout.target_units_per_hour = 150;
  assert.equal(summarizeProjectEvidence(layout, evidence).confirmedCount, 1);
});

test('material flow needs actual content and is invalidated when equipment identities change', () => {
  const layout = createDefaultLayout();
  let evidence = confirmEvidenceField(layout, createProjectEvidence(layout), 'materialFlow', { reference: '공정표' });
  assert.equal(summarizeProjectEvidence(layout, evidence).fields.find(item => item.id === 'materialFlow').confirmed, false);
  evidence = confirmEvidenceField(layout, evidence, 'materialFlow', { value: '입고 → 가공 → 검사 → 출하', reference: '공정표 A' });
  assert.equal(summarizeProjectEvidence(layout, evidence).fields.find(item => item.id === 'materialFlow').confirmed, true);
  layout.assets.pop();
  assert.equal(summarizeProjectEvidence(layout, evidence).fields.find(item => item.id === 'materialFlow').stale, true);
});

test('restoring missing or malformed confirmation keys cannot confirm changed measurements', () => {
  const layout = createDefaultLayout();
  const confirmed = confirmEvidenceField(layout, createProjectEvidence(layout), 'dimensions', { reference: 'Original 24m survey' });
  layout.factory.width = 48;
  for (const valueKey of [undefined, null, '', '{broken', 'null', '[]', '{}', '42', '{"width":"48","depth":18,"height":6}']) {
    const stored = structuredClone(confirmed);
    if (valueKey === undefined) delete stored.fields.dimensions.valueKey;
    else stored.fields.dimensions.valueKey = valueKey;
    const restored = createProjectEvidence(layout, stored);
    assert.equal(restored.fields.dimensions.status, 'unverified');
    assert.equal(summarizeProjectEvidence(layout, restored).confirmedCount, 0);
    // Ordinary edits and a second save/reload must not silently restore approval.
    const edited = updateProjectEvidenceField(layout, restored, 'dimensions', { note: 'Metadata only' });
    assert.equal(summarizeProjectEvidence(layout, createProjectEvidence(layout, edited)).confirmedCount, 0);
    const rechecked = confirmEvidenceField(layout, edited, 'dimensions', { reference: 'New 48m survey' });
    assert.equal(summarizeProjectEvidence(layout, rechecked).confirmedCount, 1);
    assert.deepEqual(JSON.parse(rechecked.fields.dimensions.valueKey), layout.factory);
  }
  // An intact old snapshot remains old and stale rather than being replaced.
  const intact = createProjectEvidence(layout, confirmed);
  assert.equal(intact.fields.dimensions.valueKey, confirmed.fields.dimensions.valueKey);
  assert.equal(summarizeProjectEvidence(layout, intact).fields[0].stale, true);
});

test('each evidence type requires its own persisted key and explicit confirmation binds updated material flow', () => {
  const layout = createDefaultLayout(); layout.assets[0].processTime = 30;
  for (const id of ['dimensions', 'equipment', 'placement', 'processTimes', 'productionTarget', 'materialFlow']) {
    const confirmed = confirmEvidenceField(layout, createProjectEvidence(layout), id, { value: '입고 → 검사', reference: 'User document' });
    assert.equal(summarizeProjectEvidence(layout, confirmed).fields.find(field => field.id === id).confirmed, true);
    delete confirmed.fields[id].valueKey;
    const restored = createProjectEvidence(layout, confirmed);
    assert.equal(summarizeProjectEvidence(layout, restored).fields.find(field => field.id === id).confirmed, false);
  }
  const evidence = confirmEvidenceField(layout, createProjectEvidence(layout), 'materialFlow', { value: '입고 → 검사' });
  const changed = updateProjectEvidenceField(layout, evidence, 'materialFlow', { value: '입고 → 가공 → 검사', status: 'confirmed' });
  assert.equal(JSON.parse(changed.fields.materialFlow.valueKey).sequence, '입고 → 가공 → 검사');
  assert.equal(summarizeProjectEvidence(layout, changed).fields.find(field => field.id === 'materialFlow').confirmed, true);
});
