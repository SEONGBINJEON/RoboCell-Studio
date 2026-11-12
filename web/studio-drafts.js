import { normalizeLayout, computeLayoutMetrics } from './studio-model.js';

export const DRAFT_STORE_KEY = 'robocell-studio-library-v1';
export const MAX_DRAFTS = 20;
export const MAX_STORE_CHARS = 700_000;
const copy = value => structuredClone(value);
const cleanName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const near = (a, b) => Math.abs(a - b) < 1e-6;

function decode(raw) {
  if (raw === null) return [];
  if (typeof raw !== 'string' || raw.length > MAX_STORE_CHARS) throw new Error('보관함 데이터가 너무 큽니다. 원본을 백업한 뒤 확인해 주세요.');
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('보관함 JSON을 읽지 못했습니다. 기존 데이터를 보존하고 있습니다.'); }
  if (!data || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_DRAFTS) throw new Error('지원하지 않는 보관함 형식입니다. 기존 데이터를 보존하고 있습니다.');
  const ids = new Set();
  return data.entries.map(entry => {
    if (!entry || !validId(entry.id) || ids.has(entry.id) || !cleanName(entry.name) ||
        typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) {
      throw new Error('보관함 항목이 손상됐습니다. 기존 데이터를 보존하고 있습니다.');
    }
    ids.add(entry.id);
    return { id: entry.id, name: cleanName(entry.name), createdAt: entry.createdAt, layout: normalizeLayout(entry.layout) };
  });
}

/** Every mutation reads the latest stored value and commits only after validation.
 * No current-draft key is read or written. Returned snapshots are independent copies.
 */
export function createDraftStore(storage, { now = () => new Date().toISOString(),
  makeId = () => `draft-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)}` } = {}) {
  const read = () => {
    let raw;
    try { raw = storage.getItem(DRAFT_STORE_KEY); }
    catch { throw new Error('이 브라우저에서 보관함을 사용할 수 없습니다. 배치 JSON으로 보관해 주세요.'); }
    try { return { entries: decode(raw), raw }; }
    catch (error) { throw Object.assign(new Error(error.message || '보관함 데이터를 확인해 주세요.'), { raw }); }
  };
  const write = entries => {
    const raw = JSON.stringify({ version: 1, entries });
    if (raw.length > MAX_STORE_CHARS) throw new Error('보관함 용량 한도에 도달했습니다. 배치 JSON을 내려받아 별도로 보관해 주세요.');
    try { storage.setItem(DRAFT_STORE_KEY, raw); }
    catch { throw new Error('보관함에 저장하지 못했습니다. 저장 공간이나 브라우저 설정을 확인해 주세요. 기존 보관함은 유지됩니다.'); }
  };
  return {
    inspect() { try { return { ...read(), error: null }; } catch (error) { return { entries: [], raw: error.raw ?? null, error: error.message }; } },
    list() { return copy(read().entries); },
    save(name, layout) {
      const title = cleanName(name);
      if (!title) throw new Error('보관할 배치안 이름을 입력해 주세요.');
      const entries = read().entries;
      if (entries.length >= MAX_DRAFTS) throw new Error(`보관함은 최대 ${MAX_DRAFTS}개입니다. 필요한 배치 JSON을 내려받고 이전 항목을 정리해 주세요.`);
      const snapshot = normalizeLayout(layout);
      const id = makeId();
      const createdAt = now();
      if (!validId(id) || entries.some(e => e.id === id) || !Number.isFinite(Date.parse(createdAt))) throw new Error('새 보관 번호를 만들지 못했습니다. 다시 시도해 주세요.');
      const entry = { id, name: title, createdAt, layout: snapshot };
      write([entry, ...entries]);
      return copy(entry);
    },
    rename(id, name) {
      const title = cleanName(name);
      if (!title) throw new Error('배치안 이름을 입력해 주세요.');
      const entries = read().entries;
      const entry = entries.find(e => e.id === id);
      if (!entry) throw new Error('이 배치안은 다른 창에서 변경됐습니다. 목록을 다시 확인해 주세요.');
      entry.name = title; write(entries); return copy(entry);
    },
    remove(id) {
      const entries = read().entries;
      const index = entries.findIndex(e => e.id === id);
      if (index < 0) throw new Error('이 배치안은 이미 삭제됐습니다. 목록을 다시 확인해 주세요.');
      const [entry] = entries.splice(index, 1);
      write(entries); return { entry: copy(entry), index };
    },
    restore(removed) {
      const entries = read().entries;
      const checked = decode(JSON.stringify({ version: 1, entries: [removed?.entry] }))[0];
      if (entries.length >= MAX_DRAFTS) throw new Error('보관함이 가득 차 삭제를 되돌리지 못했습니다. 먼저 공간을 확보해 주세요.');
      if (entries.some(e => e.id === checked.id)) throw new Error('이미 복원된 배치안입니다.');
      const index = Math.max(0, Math.min(entries.length, Number.isInteger(removed.index) ? removed.index : 0));
      entries.splice(index, 0, checked); write(entries); return copy(checked);
    },
  };
}

/** Geometry and saved plan fields only. No simulated throughput/safety inference. */
export function compareLayouts(baselineRaw, currentRaw) {
  const baseline = normalizeLayout(baselineRaw), current = normalizeLayout(currentRaw);
  const before = computeLayoutMetrics(baseline), after = computeLayoutMetrics(current);
  const metrics = [
    ['width', '공장 가로', 'm', baseline.factory.width, current.factory.width],
    ['depth', '공장 세로', 'm', baseline.factory.depth, current.factory.depth],
    ['height', '공장 높이 · 계획값', 'm', baseline.factory.height, current.factory.height],
    ['area', '전체 면적', '㎡', before.area, after.area],
    ['assetCount', '설비·셀 수', '개', before.assetCount, after.assetCount],
    ['occupiedArea', '설비 바닥 면적 합계', '㎡', before.occupiedArea, after.occupiedArea],
    ['walkwayArea', '통로 면적 합계', '㎡', before.walkwayArea, after.walkwayArea],
  ].map(([key, label, unit, a, b]) => ({ key, label, unit, before: a, after: b, delta: near(a, b) ? 0 : b - a }));
  const oldById = new Map(baseline.assets.map(a => [a.id, a])), newById = new Map(current.assets.map(a => [a.id, a]));
  const changes = [];
  for (const asset of current.assets) {
    const old = oldById.get(asset.id);
    if (!old || old.type !== asset.type) { changes.push({ id: asset.id, name: asset.name, kind: 'added', fields: [] }); continue; }
    const fields = [];
    if (old.name !== asset.name) fields.push({ key: 'name', label: '이름', before: old.name, after: asset.name });
    for (const [key, label] of [['x','X'],['y','Y'],['rotation','회전'],['width','가로'],['depth','세로'],['height','높이']]) {
      if (!near(old[key], asset[key])) fields.push({ key, label, before: old[key], after: asset[key], unit: key === 'rotation' ? '°' : 'm' });
    }
    if (fields.length) changes.push({ id: asset.id, name: asset.name, kind: 'changed', fields });
  }
  for (const asset of baseline.assets) {
    if (!newById.has(asset.id) || newById.get(asset.id).type !== asset.type) changes.push({ id: asset.id, name: asset.name, kind: 'removed', fields: [] });
  }
  return { metrics, changes, targetChanged: baseline.target_units_per_hour !== current.target_units_per_hour,
    processTimesChanged: current.assets.filter(a => oldById.has(a.id) && !near(a.processTime, oldById.get(a.id).processTime)).length };
}

export function mountDraftLibrary({ container, getLayout, onLoad, onNotice = () => {} }) {
  if (!container || typeof getLayout !== 'function' || typeof onLoad !== 'function') throw new TypeError('Draft library requires container, getLayout and onLoad.');
  const doc = container.ownerDocument;
  const el = (tag, text, className) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, className = '') => { const node = el('button', text, `draft-btn ${className}`); node.type = 'button'; return node; };
  let storage;
  try { storage = doc.defaultView.localStorage; } catch { storage = null; }
  const store = createDraftStore(storage);
  let entries = [], selectedId = '', removed = null, dialogMode = '', storageFailed = false, lastRaw = null, initialized = false;
  const root = el('details', undefined, 'draft-library');
  const summary = el('summary');
  const heading = el('span', '배치안 보관함');
  const count = el('span', '', 'draft-count');
  summary.append(heading, count); root.append(summary);
  const body = el('div', undefined, 'draft-body'); root.append(body);
  body.append(el('p', '이 브라우저에 이름별로 보관하고, 현재 편집안과 공간·설비 변경을 비교하세요. 서버나 기업 계정에 동기화되지는 않습니다.', 'draft-help'));
  const errorBox = el('p', '', 'draft-error'); errorBox.hidden = true; errorBox.setAttribute('role', 'alert'); body.append(errorBox);
  const recover = button('보관함 원본 백업 JSON'); recover.hidden = true; body.append(recover);
  const saveForm = el('form', undefined, 'draft-save-row');
  const saveLabel = el('label', '새 보관 이름');
  const saveInput = el('input'); saveInput.type = 'text'; saveInput.maxLength = 80; saveInput.setAttribute('aria-label', '배치안 저장 이름');
  saveInput.value = cleanName(getLayout().name); saveLabel.append(saveInput);
  const saveButton = button('현재 배치안 보관', 'draft-btn-primary'); saveButton.type = 'submit'; saveForm.append(saveLabel, saveButton); body.append(saveForm);
  const selectRow = el('div', undefined, 'draft-select-row'); const selectLabel = el('label', '저장한 배치안 · 비교 기준');
  const select = el('select'); select.setAttribute('aria-label', '보관한 배치안'); selectLabel.append(select); selectRow.append(selectLabel);
  const actionRow = el('div', undefined, 'draft-actions');
  const loadButton = button('편집기로 불러오기'), renameButton = button('이름 변경'), deleteButton = button('삭제');
  actionRow.append(loadButton, renameButton, deleteButton); selectRow.append(actionRow); body.append(selectRow);
  const meta = el('p', '', 'draft-help'); body.append(meta);
  const undoRow = el('div', undefined, 'draft-undo'); const undoText = el('span'); const undoButton = button('보관함 삭제 되돌리기'); undoRow.append(undoText, undoButton); undoRow.hidden = true; body.append(undoRow);
  const comparison = el('div', undefined, 'draft-comparison'); body.append(comparison);
  const status = el('p', '', 'draft-status'); status.setAttribute('role', 'status'); body.append(status);

  const dialog = el('dialog', undefined, 'draft-dialog'); dialog.setAttribute('aria-label', '보관한 배치안 변경');
  const dialogTitle = el('h2'), dialogText = el('p'), renameInput = el('input'); renameInput.maxLength = 80; renameInput.setAttribute('aria-label', '변경할 보관 이름');
  const dialogError = el('p', '', 'draft-error'); dialogError.setAttribute('role', 'alert'); dialogError.hidden = true;
  const dialogActions = el('div', undefined, 'draft-actions'); const cancelButton = button('취소'), confirmButton = button('적용', 'draft-btn-primary'); dialogActions.append(cancelButton, confirmButton);
  dialog.append(dialogTitle, dialogText, renameInput, dialogError, dialogActions); container.append(root, dialog);

  const announce = message => { status.textContent = message; onNotice(message); };
  const fmt = value => typeof value === 'number' ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : value;
  const renderComparison = () => {
    if (!root.open) return;
    comparison.replaceChildren();
    const selected = entries.find(e => e.id === selectedId);
    if (!selected) return;
    let result;
    try { result = compareLayouts(selected.layout, getLayout()); }
    catch { comparison.append(el('p', '현재 편집안의 유효한 값을 입력하면 비교할 수 있습니다.', 'draft-help')); return; }
    comparison.append(el('h3', '선택 배치 → 현재 편집안'));
    const table = el('table'); const caption = el('caption', '입력한 배치의 기하학적 비교 · 생산성·충돌·안전 검증 결과가 아닙니다.'); table.append(caption);
    const thead = el('thead'), tr = el('tr'); for (const title of ['항목', '선택 배치', '현재 편집안', '차이']) { const th = el('th', title); th.scope = 'col'; tr.append(th); } thead.append(tr); table.append(thead);
    const tbody = el('tbody');
    for (const item of result.metrics) { const row = el('tr'), title = el('th', item.label); title.scope = 'row'; row.append(title, el('td', `${fmt(item.before)} ${item.unit}`), el('td', `${fmt(item.after)} ${item.unit}`), el('td', item.delta ? `${item.delta > 0 ? '+' : ''}${fmt(item.delta)} ${item.unit}` : '변경 없음')); tbody.append(row); }
    table.append(tbody); const wrap = el('div', undefined, 'draft-table-wrap'); wrap.append(table); comparison.append(wrap);
    const totals = { added: 0, removed: 0, changed: 0 }; result.changes.forEach(change => totals[change.kind]++);
    comparison.append(el('p', `설비·구역 추가 ${totals.added} · 삭제 ${totals.removed} · 속성 변경 ${totals.changed}`, 'draft-diff-summary'));
    if (result.changes.length) {
      const list = el('ul', undefined, 'draft-change-list');
      for (const change of result.changes) { const li = el('li'); const label = {added:'추가',removed:'삭제',changed:'변경'}[change.kind]; li.append(el('strong', `${label} · ${change.name}`)); if (change.fields.length) li.append(el('span', change.fields.map(f => `${f.label} ${fmt(f.before)} → ${fmt(f.after)}${f.unit ? ` ${f.unit}` : ''}`).join(' / '))); list.append(li); }
      comparison.append(list);
    }
    if (result.targetChanged || result.processTimesChanged) comparison.append(el('p', '생산 목표 또는 공정 시간 계획값도 다릅니다. 이 값의 변경 효과를 실제 생산성 차이로 계산하지 않습니다.', 'draft-help'));
  };

  function refresh({ reload = false } = {}) {
    // Layout dragging can refresh on every pointer move. Avoid reparsing the
    // entire saved library or rebuilding hidden tables during those updates.
    if (initialized && !reload) { renderComparison(); return; }
    initialized = true;
    const inspected = store.inspect(); entries = inspected.entries; storageFailed = Boolean(inspected.error); lastRaw = inspected.raw;
    errorBox.hidden = !storageFailed; errorBox.textContent = inspected.error || ''; recover.hidden = !storageFailed || !lastRaw;
    count.textContent = storageFailed ? '저장소 확인 필요' : `${entries.length}/${MAX_DRAFTS} 보관 · 펼쳐서 비교`;
    if (!entries.some(e => e.id === selectedId)) selectedId = entries[0]?.id || '';
    select.replaceChildren();
    if (!entries.length) { const option = el('option', '아직 저장한 배치안이 없습니다.'); option.value = ''; select.append(option); }
    for (const entry of entries) { const option = el('option', `${entry.name} · ${new Date(entry.createdAt).toLocaleString('ko-KR')}`); option.value = entry.id; select.append(option); }
    select.value = selectedId; select.disabled = !entries.length;
    saveButton.disabled = storageFailed || entries.length >= MAX_DRAFTS;
    for (const control of [loadButton, renameButton, deleteButton]) control.disabled = storageFailed || !selectedId;
    const selected = entries.find(e => e.id === selectedId);
    meta.textContent = selected ? `저장 당시 배치: ${selected.layout.name} · ${fmt(selected.layout.factory.width)} × ${fmt(selected.layout.factory.depth)} m · 저장본은 편집해도 바뀌지 않습니다.` : '현재 배치를 먼저 보관하면 변경 전후를 비교할 수 있습니다.';
    undoRow.hidden = !removed; undoText.textContent = removed ? `“${removed.entry.name}”을 보관함에서 삭제했습니다.` : '';
    undoButton.disabled = storageFailed;
    renderComparison();
  }
  const action = fn => { try { fn(); } catch (error) { announce(error.message || '보관함 작업을 완료하지 못했습니다.'); } refresh({ reload: true }); };
  saveForm.addEventListener('submit', event => { event.preventDefault(); action(() => { const saved = store.save(saveInput.value, getLayout()); selectedId = saved.id; announce(`“${saved.name}”을 새 배치안으로 보관했습니다.`); }); });
  select.addEventListener('change', () => { selectedId = select.value; refresh({ reload: true }); });
  root.addEventListener('toggle', () => { if (root.open) refresh({ reload: true }); });
  loadButton.addEventListener('click', () => action(() => { const entry = store.list().find(e => e.id === selectedId); if (!entry) throw new Error('선택한 배치안이 없습니다.'); onLoad(copy(entry.layout)); announce(`“${entry.name}”을 불러왔습니다. 편집기의 실행 취소로 이전 배치로 돌아갈 수 있습니다.`); }));
  const showDialog = mode => {
    const selected = entries.find(e => e.id === selectedId); if (!selected) return;
    dialogMode = mode; dialog.dataset.entryId = selected.id; dialogError.hidden = true;
    dialogTitle.textContent = mode === 'rename' ? '보관 이름 변경' : '보관함에서 삭제';
    dialogText.textContent = mode === 'rename' ? '저장된 배치 내용은 유지하고 보관함 이름만 바꿉니다.' : `“${selected.name}”을 삭제할까요? 현재 편집안은 유지되며, 다음 삭제 전까지 이 화면에서 되돌릴 수 있습니다.`;
    renameInput.hidden = mode !== 'rename'; renameInput.value = selected.name; confirmButton.textContent = mode === 'rename' ? '이름 저장' : '삭제';
    dialog.showModal(); (mode === 'rename' ? renameInput : cancelButton).focus();
  };
  renameButton.addEventListener('click', () => showDialog('rename')); deleteButton.addEventListener('click', () => showDialog('delete'));
  cancelButton.addEventListener('click', () => dialog.close());
  confirmButton.addEventListener('click', () => {
    try { const id = dialog.dataset.entryId;
      if (dialogMode === 'rename') { store.rename(id, renameInput.value); announce('보관 이름을 변경했습니다.'); }
      else { removed = store.remove(id); announce('보관함에서 삭제했습니다. 삭제 되돌리기를 사용할 수 있습니다.'); }
      dialog.close(); refresh({ reload: true });
    } catch (error) { dialogError.textContent = error.message; dialogError.hidden = false; }
  });
  renameInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); confirmButton.click(); } });
  undoButton.addEventListener('click', () => action(() => { const restored = store.restore(removed); removed = null; selectedId = restored.id; announce('삭제한 배치안을 복원했습니다.'); }));
  recover.addEventListener('click', () => { if (!lastRaw) return; const url = URL.createObjectURL(new Blob([lastRaw], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = 'RoboCell_보관함_복구원본.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); announce('보관함 원본을 내려받았습니다. 기존 데이터는 변경하지 않았습니다.'); });
  const storageListener = event => { if (event.key === DRAFT_STORE_KEY || event.key === null) refresh({ reload: true }); };
  doc.defaultView.addEventListener('storage', storageListener);
  refresh();
  return { refresh, destroy() { doc.defaultView.removeEventListener('storage', storageListener); root.remove(); dialog.remove(); } };
}
