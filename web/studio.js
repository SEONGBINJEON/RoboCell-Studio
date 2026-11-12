import { CATALOG, createAsset, createDefaultLayout, normalizeLayout, validateLayout, computeLayoutMetrics } from './studio-model.js';
import { FactoryScene } from './studio-scene.js';
import { createLiveController } from './studio-live.js';
import { mountDraftLibrary } from './studio-drafts.js';
import { getSelectionGeometry, alignAsset } from './studio-editor-tools.js';
import { mountCommandPalette } from './studio-command.js';
import { mountProjectDesk } from './studio-project.js';
import { mountWorkbench } from './studio-workbench.js';
import { mountSceneRecording } from './studio-recording.js';

// Canvas text is rasterized once, so load the same local font as the UI first.
if(document.fonts) await Promise.allSettled([400,500,600].map(weight=>document.fonts.load(`${weight} 14px "IBM Plex Sans KR"`,'공장 배치 0123456789')));

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const STORE = 'robocell-studio-layout-v1';
const format = (value, digits = 1) => Number(value).toLocaleString('ko-KR', { maximumFractionDigits: digits });
let layout = createDefaultLayout(), selectedId = null, scene, view = 'editor', live, draftLibrary, projectDesk;
let history = [], future = [], dragCheckpoint = false, toastTimer, saveTimer;
let recoveryRaw = null, autoSaveBlocked = false;
let initialNotice = '';
let snapStep = .25, catalogFilter = 'all', presentationMode = false, isolated = false;
try {
  const saved = localStorage.getItem(STORE);
  if (saved) {
    try { layout = normalizeLayout(JSON.parse(saved)); }
    catch { recoveryRaw = saved; autoSaveBlocked = true; initialNotice = '저장된 초안을 읽지 못했습니다. 원본을 보존하고 새 초안을 열었습니다.'; }
  }
  const contextRaw = localStorage.getItem('robocell-process-context');
  if (contextRaw) {
    try {
      const context = JSON.parse(contextRaw);
      layout = normalizeLayout({...layout,name:context.processName || layout.name,target_units_per_hour:context.targetUnitsPerHour || layout.target_units_per_hour});
      localStorage.removeItem('robocell-process-context');
      initialNotice = '의뢰서의 공정 이름과 생산 목표를 가져왔습니다.';
    } catch { initialNotice = '의뢰서 입력을 읽지 못했습니다. 저장된 공장 배치는 유지했습니다.'; }
  }
} catch { autoSaveBlocked = true; initialNotice = '이 브라우저의 자동 저장을 사용할 수 없습니다. 배치 JSON으로 보관해 주세요.'; }


const icons = {
  'robot-cell': '<path d="M3 23h26M5 23V10h9v13M7 13h5v6H7zM18 23v-4l5-5-3-5 3-4 4 3-3 4 3 6-5 4v3M17 25h9"/>',
  robot: '<path d="M7 27h18M11 27v-5h10v5M16 22l7-8-6-7 4-4 7 7-4 7M9 4l5 2 3 5-4 4-5-3z"/><circle cx="23" cy="14" r="2"/>',
  cnc: '<rect x="4" y="5" width="24" height="22" rx="1"/><path d="M7 9h13v14H7zM14 9v14M23 10h3v5h-3zM23 18h3M23 21h3"/>',
  conveyor: '<path d="M3 12h26v9H3zM6 21v6M26 21v6M7 12v9M12 12v9M17 12v9M22 12v9M27 12v9"/>',
  inspection: '<path d="M4 20h24v3H4zM7 23v6M25 23v6M7 20V4h18v16M16 4v7M13 11h6v4h-6zM12 19h8"/>',
  buffer: '<path d="M4 16h24v5H4zM7 21v7M25 21v7M6 7h8v8H6zM18 7h8v8h-8zM10 7v4M22 7v4"/>',
  'worker-zone': '<path d="M3 24l13-5 13 5-13 5zM13 17v-6h6v6M16 17v6"/><circle cx="16" cy="6" r="3"/>',
  walkway: '<path d="M3 11h26M3 24h26M6 17h16M17 13l5 4-5 4"/>',
};
const icon = type => `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[type] || icons.buffer}</svg>`;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4600); }
function checkpoint() { history.push(clone(layout)); if (history.length > 35) history.shift(); future = []; }
function save() {
  if (autoSaveBlocked) { $('save-state').textContent = recoveryRaw !== null ? '원본 보존 중 · 자동 저장 보류' : '자동 저장 불가 · JSON으로 보관'; return; }
  $('save-state').textContent = '저장 중…'; clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE, JSON.stringify(layout)); $('save-state').textContent = '이 브라우저에 저장됨'; }
    catch { $('save-state').textContent = '저장 불가 · JSON으로 내려받으세요'; }
  }, 180);
}
function setInput(id, value) { if (document.activeElement !== $(id)) $(id).value = value; }
function setMetric(id, value, unit) { const el = $(id); el.replaceChildren(document.createTextNode(format(value) + ' ')); if (unit) { const small = document.createElement('small'); small.textContent = unit; el.append(small); } }
function selectAsset(id) { selectedId = layout.assets.some(a => a.id === id) ? id : null; scene?.select(selectedId); renderInspector(); renderObjects(); }
function change(mutator, remember = true) { const next = clone(layout); mutator(next); let valid; try { valid = normalizeLayout(next); } catch(error) { toast(error.message); return; } if (remember) checkpoint(); layout = valid; render(); save(); }
function render() {
  scene?.setLayout(layout); scene?.select(selectedId);
  $('project-title').textContent = layout.name; $('viewport-dimensions').textContent = `${format(layout.factory.width)} × ${format(layout.factory.depth)} m`;
  $('summary-dimensions').textContent = `${format(layout.factory.width)} × ${format(layout.factory.depth)} m`;
  $('summary-area').textContent = `${format(layout.factory.width * layout.factory.depth)} m² · 높이 ${format(layout.factory.height)} m`;
  setInput('layout-name', layout.name); setInput('factory-width', layout.factory.width); setInput('factory-depth', layout.factory.depth); setInput('factory-height', layout.factory.height); setInput('production-target', layout.target_units_per_hour);
  const metrics = computeLayoutMetrics(layout); setInput('factory-pyeong', Number(metrics.areaPyeong.toFixed(1)));
  setMetric('metric-area', metrics.area, 'm²'); $('metric-pyeong').textContent = `${format(metrics.areaPyeong)}평`;
  setMetric('metric-assets', metrics.assetCount, '개'); setMetric('metric-occupied', metrics.occupiedArea, 'm²'); setMetric('metric-walkway', metrics.walkwayArea, 'm²');
  $('undo-layout').disabled = !history.length; $('redo-layout').disabled = !future.length;
  const issues = validateLayout(layout);
  $('validation-summary').classList.toggle('has-issues', Boolean(issues.length));
  document.querySelector('.validation-icon').textContent = issues.length ? '!' : '✓';
  $('validation-title').textContent = issues.length ? `배치 확인 사항 ${issues.length}건` : '평면 배치 확인 완료';
  $('validation-detail').textContent = issues.length ? issues[0].message : '평면상 경계 이탈·겹침 없음 · 로봇 동작과 안전은 별도 검증이 필요합니다.';
  $('layout-issues').replaceChildren(...issues.map(item => { const li = document.createElement('li'); li.textContent = item.message; return li; }));
  $('toggle-issues').disabled = !issues.length;
  renderInspector(); renderObjects(); live?.setLayout(); draftLibrary?.refresh(); projectDesk?.refresh();
}
function renderInspector() {
  const asset = layout.assets.find(a => a.id === selectedId);
  $('selection-empty').hidden = Boolean(asset); $('selection-fields').hidden = !asset;
  if ($('isolate-selection')) $('isolate-selection').disabled = !asset;
  $('viewport-selection').hidden = !asset; $('focus-selection').disabled = !asset;
  $('editor-status-text').textContent = asset ? `${asset.name} 선택됨` : '설계 준비 완료';
  if (!asset) return;
  $('viewport-selected-name').textContent = asset.name;
  $('viewport-selected-position').textContent = `X ${format(asset.x,2)} / Y ${format(asset.y,2)} m`;
  const geometry = getSelectionGeometry(layout, selectedId);
  $('align-asset').disabled = !geometry.fitsFactory;
  $('align-asset').title = geometry.fitsFactory ? '선택한 설비를 공장 기준으로 정렬' : '설비가 공장보다 커서 정렬할 수 없습니다.';
  for (const [side, distance] of Object.entries(geometry.clearances)) { const value = $(`clearance-${side}`); value.textContent = `${format(distance,2)} m`; value.classList.toggle('is-outside', distance < -.000001); }
  $('selected-icon').innerHTML = icon(asset.type); $('selected-label').textContent = asset.name; $('selected-type').textContent = CATALOG.find(a => a.type === asset.type)?.label;
  for (const [id, field] of [['asset-name','name'],['asset-x','x'],['asset-y','y'],['asset-rotation','rotation'],['asset-width','width'],['asset-depth','depth'],['asset-time','processTime']]) setInput(id, asset[field]);
}
function renderObjects() {
  const focusedAssetId = document.activeElement?.closest('#object-list button')?.dataset.assetId;
  $('object-count').textContent = String(layout.assets.length);
  $('object-list').replaceChildren(...layout.assets.map(asset => {
    const li = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.className = asset.id === selectedId ? 'selected' : '';
    button.dataset.assetId = asset.id; button.setAttribute('aria-pressed', String(asset.id === selectedId)); button.innerHTML = icon(asset.type);
    const name = document.createElement('span'); name.textContent = asset.name; button.append(name);
    button.addEventListener('click', () => selectAsset(asset.id)); li.append(button); return li;
  }));
  if (focusedAssetId) [...$('object-list').querySelectorAll('button')].find(button => button.dataset.assetId === focusedAssetId)?.focus({preventScroll:true});
}

try {
  scene = new FactoryScene($('factory-viewport'), {
    onSelect: selectAsset,
    onMove(id, point) { if (!dragCheckpoint) { checkpoint(); dragCheckpoint = true; } const asset = layout.assets.find(a => a.id === id); if (asset) { asset.x = Math.max(-500,Math.min(500,point.x)); asset.y = Math.max(-500,Math.min(500,point.y)); render(); } },
    onMoveEnd() { dragCheckpoint = false; save(); },
    onError(message) { $('scene-loading').hidden = false; $('scene-loading').textContent = message; toast(message); },
    onStats(stats) { const label=$('scene-performance');if(!label)return;label.textContent=stats.fps===null?'편집 렌더 대기':`편집 ${Math.round(stats.fps)} fps`;label.title=stats.fps===null?'브라우저 3D 편집 화면의 렌더 측정 대기':`편집 화면 측정 · ${stats.drawCalls} draw calls · ${Number(stats.triangles).toLocaleString('ko-KR')} triangles · Isaac Sim 영상 속도와 별개`; },
  });
  $('scene-loading').hidden = true;
} catch { $('scene-loading').textContent = '3D 그래픽을 초기화하지 못했습니다. 브라우저의 그래픽 가속을 켜고 새로고침해 주세요. 입력·JSON 저장은 계속 사용할 수 있습니다.'; }

function addAsset(type, point) {
  if (layout.assets.length >= 100) return toast('한 배치에는 최대 100개까지 추가할 수 있습니다.');
  let asset;
  try { asset = createAsset(type, layout.assets.filter(a => a.type === type).length + 1); } catch { return; }
  const snap = value => snapStep ? Math.round(value / snapStep) * snapStep : value;
  asset.x = snap(point?.x ?? layout.factory.width / 2); asset.y = snap(point?.y ?? layout.factory.depth / 2);
  change(data => data.assets.push(asset)); selectAsset(asset.id); toast(`${CATALOG.find(a => a.type === type).label} 추가 완료. 위치를 드래그해 조정하세요.`);
}
function renderCatalog() {
const query = $('asset-search').value.normalize('NFKC').toLocaleLowerCase('ko-KR').trim();
const items = CATALOG.filter(asset => { const isZone = ['worker-zone','walkway'].includes(asset.type); return (catalogFilter === 'all' || (catalogFilter === 'zone' ? isZone : !isZone)) && `${asset.label} ${asset.type} ${asset.description} ${asset.category}`.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(query); });
$('catalog-count').textContent = `${items.length}종`; $('catalog-empty').hidden = !!items.length;
$('asset-catalog').replaceChildren(...items.map(asset => {
  const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'asset-tile'; tile.draggable = true; tile.title = asset.description; tile.setAttribute('aria-label', `${asset.label} 추가`);
  tile.innerHTML = `<span class="catalog-icon">${icon(asset.type)}</span><strong>${asset.label}</strong><small>${asset.width} × ${asset.depth} m</small><span class="add-symbol">+</span>`;
  tile.addEventListener('click', () => addAsset(asset.type));
  tile.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-robocell-asset', asset.type); event.dataTransfer.effectAllowed = 'copy'; $('drop-hint').hidden = false; });
  tile.addEventListener('dragend', () => { $('drop-hint').hidden = true; }); return tile;
}));
}
renderCatalog();
$('asset-search').addEventListener('input', renderCatalog);
document.querySelectorAll('[data-catalog-filter]').forEach(button => button.addEventListener('click', () => { catalogFilter = button.dataset.catalogFilter; document.querySelectorAll('[data-catalog-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); renderCatalog(); }));
$('factory-viewport').addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/x-robocell-asset')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
$('factory-viewport').addEventListener('drop', event => { event.preventDefault(); $('drop-hint').hidden = true; const type = event.dataTransfer.getData('application/x-robocell-asset'); if (type) addAsset(type, scene?.getWorldPoint(event.clientX, event.clientY)); });

function bindInput(id, apply, numeric = true) {
  const input = $(id); let recorded = false, lastValid = input.value;
  input.addEventListener('focus', () => { recorded = false; lastValid = input.value; });
  input.addEventListener('input', () => {
    if (!input.validity.valid || !input.value.trim()) return;
    const value = numeric ? Number(input.value) : input.value.trim();
    if (numeric && !Number.isFinite(value)) return;
    change(data => apply(data, value), !recorded); recorded = true; lastValid = input.value;
  });
  input.addEventListener('blur', () => { if (!input.validity.valid || !input.value.trim()) { toast('입력 범위를 확인해 주세요. 마지막 유효한 값으로 복원했습니다.'); input.value = lastValid; } render(); });
}
function resizeWidth(data, width) {
  const previous = data.factory.width;
  for (const asset of data.assets) if (asset.type === 'walkway' && Math.abs(asset.width - previous) < .01 && Math.abs(asset.x - previous / 2) < .01 && !asset.rotation) { asset.width = width; asset.x = width / 2; }
  data.factory.width = width;
}
bindInput('layout-name', (data, value) => { data.name = value; }, false);
bindInput('factory-width', resizeWidth); bindInput('factory-depth', (data, value) => { data.factory.depth = value; });
bindInput('factory-height', (data, value) => { data.factory.height = value; }); bindInput('production-target', (data, value) => { data.target_units_per_hour = value; });
for (const [id, field] of [['asset-name','name'],['asset-x','x'],['asset-y','y'],['asset-rotation','rotation'],['asset-width','width'],['asset-depth','depth'],['asset-time','processTime']]) bindInput(id, (data, value) => { const asset = data.assets.find(a => a.id === selectedId); if (asset) asset[field] = value; }, field !== 'name');
$('apply-area').addEventListener('click', () => {
  const input = $('factory-pyeong'), value = Number(input.value); if (!input.validity.valid || !value) return toast('입력할 면적을 확인해 주세요.');
  const scale = Math.sqrt(value * 3.305785 / (layout.factory.width * layout.factory.depth));
  const width = Math.round(layout.factory.width * scale * 100) / 100, depth = Math.round(layout.factory.depth * scale * 100) / 100;
  if (width < 4 || depth < 4 || width > 200 || depth > 200) return toast('가로·세로가 4~200m인 범위에서 면적을 입력해 주세요.');
  change(data => { resizeWidth(data, width); data.factory.depth = depth; }); scene?.fit(); toast('면적을 반영했습니다. 설비가 경계 안에 있는지 확인해 주세요.');
});
function editSelected(fn) { if (!selectedId) return; change(data => { const asset = data.assets.find(a => a.id === selectedId); if (asset) fn(asset); }); }
$('rotate-asset').addEventListener('click', () => editSelected(asset => { asset.rotation = (asset.rotation + 90) % 360; }));
$('delete-asset').addEventListener('click', () => { if (!selectedId) return; change(data => { data.assets = data.assets.filter(a => a.id !== selectedId); selectedId = null; }); });
$('duplicate-asset').addEventListener('click', () => {
  const selected = layout.assets.find(a => a.id === selectedId); if (!selected) return;
  if (layout.assets.length >= 100) return toast('한 배치에는 최대 100개까지 추가할 수 있습니다.');
  const copy = { ...clone(selected), id: createAsset(selected.type).id, name: `${selected.name} 복사`.slice(0, 60), x: selected.x + 1, y: selected.y + 1 };
  change(data => data.assets.push(copy)); selectAsset(copy.id);
});
function travelHistory(from,to) { if (!from.length) return; to.push(clone(layout)); layout = from.pop(); if (!layout.assets.some(a=>a.id===selectedId)) selectedId=null; render(); save(); }
$('undo-layout').addEventListener('click',()=>travelHistory(history,future));
$('redo-layout').addEventListener('click',()=>travelHistory(future,history));
$('reset-layout').addEventListener('click', () => { loadDraft(createDefaultLayout()); toast('기본 셀 배치로 전환했습니다. 실행 취소로 되돌릴 수 있습니다. 입력 근거는 다시 확인해 주세요.'); });
$('toggle-issues').addEventListener('click', () => { $('layout-issues').hidden = !$('layout-issues').hidden; $('toggle-issues').textContent = $('layout-issues').hidden ? '자세히' : '접기'; });
for (const button of document.querySelectorAll('[data-camera]')) button.addEventListener('click', () => { scene?.setView(button.dataset.camera); document.querySelectorAll('[data-camera]').forEach(item => { const active = item.dataset.camera === button.dataset.camera; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); }); });
for (const mode of ['move','orbit']) $(`${mode}-mode`).addEventListener('click', () => { scene?.setMode(mode); for (const m of ['move','orbit']) { $(`${m}-mode`).classList.toggle('selected', m === mode); $(`${m}-mode`).setAttribute('aria-pressed', String(m === mode)); } });
$('fit-view').addEventListener('click', () => scene?.fit());
document.addEventListener('keydown', event => {
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key === 'k' && !document.querySelector('dialog[open]:not(#command-dialog)')) { event.preventDefault(); commandPalette.open(); return; }
  if (event.key === 'Escape' && !document.querySelector('dialog[open]') && presentationMode) { setPresentationMode(false); return; }
  if (view !== 'editor' || document.querySelector('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); $(event.shiftKey ? 'redo-layout':'undo-layout').click(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); $('redo-layout').click(); return; }
  if ((event.ctrlKey || event.metaKey) && key === 'd') {event.preventDefault(); $('duplicate-asset').click(); return;}
  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    if (key === 'f') { event.preventDefault(); event.shiftKey ? scene?.fit() : focusSelection(); return; }
    if (key === 'r') { event.preventDefault(); $('rotate-asset').click(); return; }
    if (key === '/') { event.preventDefault(); setPresentationMode(false); showLibraryTab('assets'); $('asset-search').focus(); return; }
  }
  if (event.key === 'Delete' && (document.activeElement?.closest('#factory-viewport') || document.activeElement?.closest('#object-list'))) { event.preventDefault(); $('delete-asset').click(); }
  if (selectedId && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) && document.activeElement?.closest('#factory-viewport')) { event.preventDefault(); editSelected(asset => { if (event.key === 'ArrowLeft') asset.x -= (snapStep || .1); if (event.key === 'ArrowRight') asset.x += (snapStep || .1); if (event.key === 'ArrowUp') asset.y -= (snapStep || .1); if (event.key === 'ArrowDown') asset.y += (snapStep || .1); }); }
});
$('export-layout').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ ...layout, exported_at: new Date().toISOString() }, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `RoboCell_배치_${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); toast('배치 JSON을 내려받았습니다.');
});
$('import-layout').addEventListener('click', () => $('layout-file').click());
$('layout-file').addEventListener('change', async () => {
  const file = $('layout-file').files[0]; if (!file) return;
  try { if (file.size > 2_000_000) throw new Error('배치 JSON은 2MB 이하로 올려 주세요.'); const next = normalizeLayout(JSON.parse(await file.text())); loadDraft(next); toast('배치 파일을 불러왔습니다. 실행 취소로 되돌릴 수 있습니다. 입력 근거는 다시 확인해 주세요.'); }
  catch (error) { toast(error instanceof SyntaxError ? '올바른 JSON 파일을 선택해 주세요.' : error.message); }
  finally { $('layout-file').value = ''; }
});

function loadDraft(next,options={}) {
  const normalized=normalizeLayout(next);checkpoint();layout=normalized;projectDesk?.resetForLayout(layout,options);selectedId=layout.assets.find(asset=>['robot-cell','robot','cnc'].includes(asset.type))?.id || layout.assets[0]?.id || null; render(); save(); scene?.fit();
}
function setView(next) {
  view = next; document.body.dataset.workspaceView = next; if (next !== 'editor') setPresentationMode(false); $('presentation-mode').disabled = next !== 'editor'; $('editor-panel').hidden = next !== 'editor'; $('live-panel').hidden = next !== 'live';
  $('draft-library-host').hidden = next !== 'editor';
  document.querySelectorAll('[data-view]').forEach(button => { const active = button.dataset.view === next; button.classList.toggle('active', active); if (button.getAttribute('role') === 'tab') {button.setAttribute('aria-selected', String(active)); button.tabIndex=active?0:-1;} else if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
  scene?.setActive(next === 'editor'); live?.setVisible(next === 'live');
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$('open-live').addEventListener('click', () => setView('live'));
for (const id of ['editor-tab','live-tab']) $(id).addEventListener('keydown',event=>{
  if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {event.preventDefault();const next=event.key==='Home'?'editor':event.key==='End'?'live':view==='editor'?'live':'editor';setView(next);$(`${next}-tab`).focus();}
});
live = createLiveController({getLayout:()=>layout,onLoadLayout:loadDraft,notify:toast});
live.setVisible(false);
draftLibrary = mountDraftLibrary({container:$('draft-library-host'),getLayout:()=>layout,onLoad:loadDraft,onNotice:toast});
$('draft-recovery').hidden = recoveryRaw === null;
$('download-recovery').addEventListener('click',()=>{
  if(recoveryRaw===null)return; const url=URL.createObjectURL(new Blob([recoveryRaw],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='RoboCell_복구용_원본.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
});
$('resume-autosave').addEventListener('click',()=>{
  try {localStorage.setItem(`${STORE}-recovery-${Date.now()}`,recoveryRaw);autoSaveBlocked=false;recoveryRaw=null;$('draft-recovery').hidden=true;save();toast('원본을 별도 보존하고 현재 초안의 자동 저장을 시작했습니다.');}
  catch {toast('원본을 보존할 공간이 부족합니다. 원본과 현재 배치를 JSON으로 내려받으세요.');}
});
$('fullscreen-view').addEventListener('click', async () => { try { await document.querySelector('.live-screen').requestFullscreen(); } catch { toast('이 브라우저에서는 전체 화면을 열 수 없습니다.'); } });
document.querySelectorAll('[data-capture]').forEach(button => button.addEventListener('click', () => { $('capture-large').src = `assets/isaac/${button.dataset.capture}.jpg`; $('capture-large').alt = button.querySelector('img').alt; $('capture-dialog').showModal(); }));
$('close-capture').addEventListener('click', () => $('capture-dialog').close());
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); if (!autoSaveBlocked) try { localStorage.setItem(STORE, JSON.stringify(layout)); } catch {} });
render(); selectAsset(layout.assets.find(asset => asset.type === 'robot-cell')?.id || layout.assets[0]?.id); save(); if (initialNotice) toast(initialNotice);


function showLibraryTab(name) {
  for (const type of ['assets','factory']) { const active = type === name; $(`library-${type}-panel`).hidden = !active; $(`library-${type}-tab`).setAttribute('aria-selected', String(active)); $(`library-${type}-tab`).tabIndex = active ? 0 : -1; }
}
for (const type of ['assets','factory']) {
  $(`library-${type}-tab`).addEventListener('click', () => showLibraryTab(type));
  $(`library-${type}-tab`).addEventListener('keydown', event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'assets' : event.key === 'End' ? 'factory' : type === 'assets' ? 'factory' : 'assets'; showLibraryTab(next); $(`library-${next}-tab`).focus(); } });
}
$('factory-summary').addEventListener('click', () => { showLibraryTab('factory'); $('factory-width').focus(); });
document.querySelector('.skip-link').addEventListener('click', () => { setView('editor'); setPresentationMode(false); showLibraryTab('factory'); });
function focusSelection() { if (!scene?.focusSelected()) toast('먼저 확대할 설비를 선택하세요.'); }
$('focus-selection').addEventListener('click', focusSelection);
$('align-asset').addEventListener('click', () => {
  if (!selectedId) return;
  try { const next = alignAsset(layout, selectedId, $('asset-alignment').value); checkpoint(); layout = next; render(); save(); toast('공장 경계 기준으로 정렬했습니다. 배치 겹침을 확인하세요.'); }
  catch (error) { toast(error.message); }
});
for (const [id, method] of [['toggle-grid','setGridVisible'],['toggle-labels','setLabelsVisible']]) $(id).addEventListener('click', () => { const visible = $(id).getAttribute('aria-pressed') !== 'true'; $(id).setAttribute('aria-pressed', String(visible)); scene?.[method](visible); });
$('snap-step').addEventListener('change', () => { snapStep = Number($('snap-step').value); scene?.setSnap(snapStep); });
function setPresentationMode(enabled) {
  presentationMode = enabled; document.body.classList.toggle('focus-mode', enabled);
  $('presentation-mode').setAttribute('aria-pressed', String(enabled)); $('presentation-mode').textContent = enabled ? '편집으로 돌아가기 · Esc' : '발표 모드';
}
$('presentation-mode').addEventListener('click', () => setPresentationMode(!presentationMode));
function openDrafts() { setView('editor'); const details = $('draft-library-host').querySelector('details'); if (details) details.open = true; $('draft-library-dialog').showModal(); }
for (const id of ['rail-drafts','open-drafts']) $(id).addEventListener('click', openDrafts);
$('close-drafts').addEventListener('click', () => $('draft-library-dialog').close());
$('shortcuts-open').addEventListener('click', () => $('shortcuts-dialog').showModal());
$('close-shortcuts').addEventListener('click', () => $('shortcuts-dialog').close());
let cursorFrame = 0, cursorPosition = null;
$('factory-viewport').addEventListener('pointermove', event => { cursorPosition = {x:event.clientX,y:event.clientY}; if (cursorFrame) return; cursorFrame = requestAnimationFrame(() => { cursorFrame = 0; if (!cursorPosition) return; const point = scene?.getWorldPoint(cursorPosition.x,cursorPosition.y); $('cursor-coordinate').textContent = point ? `X ${format(point.x,2)} / Y ${format(point.y,2)}` : 'X — / Y —'; }); });
$('factory-viewport').addEventListener('pointerleave', () => { cursorPosition = null; $('cursor-coordinate').textContent = 'X — / Y —'; });
const editorAction = action => () => { setView('editor'); action(); };
const commandPalette = mountCommandPalette({ getCommands: () => [
  {id:'fit',label:'전체 배치 보기',detail:'공장 전체가 보이도록 시점 맞추기',shortcut:'Shift F',run:editorAction(() => scene?.fit())},
  ...(selectedId ? [{id:'focus',label:'선택 설비 확대',detail:layout.assets.find(a => a.id === selectedId)?.name,shortcut:'F',run:editorAction(focusSelection)}, {id:'rotate',label:'선택 설비 90° 회전',shortcut:'R',run:editorAction(() => $('rotate-asset').click())}, {id:'duplicate',label:'선택 설비 복제',shortcut:'Ctrl D',run:editorAction(() => $('duplicate-asset').click())}] : []),
  {id:'factory',label:'공장 설정 열기',detail:'가로·세로·높이·생산 목표',run:editorAction(() => {setPresentationMode(false); showLibraryTab('factory'); $('factory-width').focus();})},
  {id:'assets',label:'설비 라이브러리 검색',detail:'설비를 찾아 배치에 추가',shortcut:'/',run:editorAction(() => {setPresentationMode(false); showLibraryTab('assets'); $('asset-search').focus();})},
  {id:'present',label:presentationMode?'발표 모드 종료':'발표 모드 시작',detail:'3D 작업 공간을 크게 보기',run:editorAction(() => setPresentationMode(!presentationMode))},
  {id:'drafts',label:'배치안 보관함 열기',detail:'저장한 배치안 관리·비교',run:openDrafts},
  ...[['examples','공장 예시'],['diagnostics','설비 상태 및 이상징후 진단'],['evidence','입력 근거'],['safety','작업 반경 검토'],['assistant','AI 분석'],['report','검토 보고서'],['demo','발표 진행']].map(([id,label])=>({id:`project-${id}`,label,run:()=>projectDesk?.open(id)})),
  {id:'shortcuts',label:'단축키 안내',detail:'더 빠르게 설계하는 키보드 명령',run:() => $('shortcuts-dialog').showModal()},
  {id:'live',label:'실시간 시뮬레이션 화면',detail:'5090 서버 상태·영상·실행 제어',run:() => setView('live')},
  ...CATALOG.map(asset => ({id:`add-${asset.type}`,label:`${asset.label} 추가`,detail:`${asset.description} · ${asset.width} × ${asset.depth} m`,run:editorAction(() => addAsset(asset.type))})),
  ...layout.assets.map(asset => ({id:`select-${asset.id}`,label:asset.name,detail:'배치한 설비 선택 및 확대',run:editorAction(() => {selectAsset(asset.id); focusSelection();})})),
] });
$('command-open').addEventListener('click', () => commandPalette.open());

projectDesk = mountProjectDesk({
  getLayout:()=>layout, onLoadLayout:loadDraft,
  getRunEvidence:()=>live.getRunEvidence(), getScene:()=>scene,
  openEditor:()=>setView('editor'),
  onSelectAsset:id=>{selectAsset(id);scene?.focusSelected();},
  openLive:mode=>{setView('live');mode==='recorded'?live.showRecorded():live.showLive();},
  notify:toast,
});

const displayTools=document.createElement('div');displayTools.className='scene-display-tools';
displayTools.innerHTML='<label>표시 <select id="model-detail" aria-label="3D 표시 방식"><option value="solid">재질</option><option value="wireframe">와이어</option></select></label><button id="isolate-selection" type="button" aria-pressed="false">선택만 보기</button>';
document.querySelector('.viewport-toolbar .segmented').before(displayTools);
$('model-detail').addEventListener('change',()=>scene?.setModelDetail($('model-detail').value));
$('isolate-selection').addEventListener('click',()=>{isolated=!isolated;scene?.isolateSelected(isolated);$('isolate-selection').setAttribute('aria-pressed',String(isolated));$('isolate-selection').textContent=isolated?'모두 보기':'선택만 보기';});
mountSceneRecording({container:displayTools,getCanvas:()=>scene?.canvas,notify:toast});
renderInspector();
mountWorkbench();
