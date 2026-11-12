// Desktop pane sizing only. This module does not change layouts or run controls.
const STORAGE_KEY = 'robocell-workbench-widths-v1';
const PANELS = Object.freeze({ left: Object.freeze({ initial: 204, min: 176, max: 320 }), right: Object.freeze({ initial: 228, min: 210, max: 340 }) });
const HANDLE_WIDTH = 6, CANVAS_MIN = 420;
const MIN_GRID_WIDTH = PANELS.left.min + PANELS.right.min + 2 * HANDLE_WIDTH + CANVAS_MIN;
const mounted = new WeakMap();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const defaults = () => ({ left: PANELS.left.initial, right: PANELS.right.initial });

/** Resolve actual widths while preserving the canvas. The preferred values
 * remain separate so shrinking a window does not overwrite the saved layout.
 * activeSide shrinks the panel being manipulated first when space runs out. */
export function resolveWorkbenchWidths(gridWidth, preferred = {}, activeSide = null) {
  const widths = Object.fromEntries(Object.entries(PANELS).map(([side, spec]) => [side,
    Math.round(clamp(Number.isFinite(preferred[side]) ? preferred[side] : spec.initial, spec.min, spec.max))]));
  const available = Math.floor(gridWidth) - 2 * HANDLE_WIDTH - CANVAS_MIN;
  if (!Number.isFinite(available) || available < PANELS.left.min + PANELS.right.min) return null;
  const excess = Math.max(0, widths.left + widths.right - available);
  if (excess) {
    if (activeSide === 'left' || activeSide === 'right') {
      const other = activeSide === 'left' ? 'right' : 'left';
      const reduction = Math.min(excess, widths[activeSide] - PANELS[activeSide].min);
      widths[activeSide] -= reduction;
      widths[other] -= excess - reduction;
    } else {
      const leftRoom = widths.left - PANELS.left.min, rightRoom = widths.right - PANELS.right.min;
      const leftReduction = Math.min(leftRoom, Math.round(excess * leftRoom / (leftRoom + rightRoom)));
      widths.left -= leftReduction;
      widths.right -= excess - leftReduction;
    }
  }
  return widths;
}

/** Mount once after the editor DOM exists. Returns an idempotent dispose().
 * Tab reaches each separator; arrows move the divider, Shift uses 24px steps,
 * Home/double-click restore that panel, and Escape cancels an active drag. */
export function mountWorkbench() {
  const grid = document.querySelector('.editor-grid');
  if (!grid) return { dispose() {} };
  if (mounted.has(grid)) return mounted.get(grid);
  const library = grid.querySelector(':scope > .library-panel');
  const viewport = grid.querySelector(':scope > .viewport-column');
  const inspector = grid.querySelector(':scope > .inspector-panel');
  if (!library || !viewport || !inspector) return { dispose() {} };
  let preferred = defaults(), actual = { ...preferred }, storage = null, storageBlocked = false;
  let drag = null, frame = 0, pendingX = null, disposed = false, active = false;
  const cleanups = [], handles = {}, savedIds = new Map();
  const oldVariables = ['--workbench-left-width', '--workbench-right-width'].map(name => [name, grid.style.getPropertyValue(name), grid.style.getPropertyPriority(name)]);
  try {
    storage = window.localStorage;
    const raw = storage.getItem(STORAGE_KEY);
    if (raw !== null) {
      if (raw.length > 1000) throw new Error('Invalid preference size');
      const stored = JSON.parse(raw);
      if (!stored || stored.version !== 1 || !Object.entries(PANELS).every(([side, spec]) => Number.isFinite(stored[side]) && stored[side] >= spec.min && stored[side] <= spec.max)) throw new Error('Invalid pane preferences');
      preferred = { left: stored.left, right: stored.right };
    }
  } catch { storageBlocked = true; }
  const persist = () => {
    if (storageBlocked || !storage) return;
    try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...preferred })); }
    catch { storageBlocked = true; }
  };
  const listen = (target, type, listener, options) => { target.addEventListener(type, listener, options); cleanups.push(() => target.removeEventListener(type, listener, options)); };
  const ensureId = (element, base) => {
    if (element.id) return element.id;
    let id = base, suffix = 1;
    while (document.getElementById(id)) id = `${base}-${suffix++}`;
    savedIds.set(element, id); element.id = id; return id;
  };
  const description = document.createElement('span');
  description.className = 'workbench-resize-instructions';
  description.textContent = '좌우 방향키로 패널 경계를 8픽셀 이동합니다. Shift와 함께 누르면 24픽셀 이동합니다. Home 또는 두 번 클릭하면 기본 폭으로 복원합니다. 드래그 중 Escape로 취소합니다.';
  grid.append(description);
  const descriptionId = ensureId(description, 'workbench-resize-instructions');
  const desktop = window.matchMedia('(min-width: 1001px)');
  const allowed = () => desktop.matches && !document.body.classList.contains('focus-mode') && !grid.hidden && !document.hidden && grid.getBoundingClientRect().width >= MIN_GRID_WIDTH;

  function paint(side = null) {
    if (disposed) return;
    active = allowed();
    grid.classList.toggle('workbench-resize-active', active);
    for (const handle of Object.values(handles)) { handle.tabIndex = active ? 0 : -1; handle.setAttribute('aria-disabled', String(!active)); }
    if (!active) return;
    const width = grid.getBoundingClientRect().width;
    actual = resolveWorkbenchWidths(width, preferred, side);
    if (!actual) return;
    const budget = Math.floor(width) - 2 * HANDLE_WIDTH - CANVAS_MIN;
    for (const name of ['left', 'right']) {
      grid.style.setProperty(`--workbench-${name}-width`, `${actual[name]}px`);
      handles[name].setAttribute('aria-valuemin', String(PANELS[name].min));
      handles[name].setAttribute('aria-valuemax', String(Math.min(PANELS[name].max, budget - actual[name === 'left' ? 'right' : 'left'])));
      handles[name].setAttribute('aria-valuenow', String(actual[name]));
      handles[name].setAttribute('aria-valuetext', `${actual[name]} 픽셀`);
    }
  }
  function applyPending() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (!drag || pendingX === null) return;
    const delta = (pendingX - drag.startX) * (drag.side === 'left' ? 1 : -1);
    const desired = { ...drag.actual, [drag.side]: drag.actual[drag.side] + delta };
    const resolved = resolveWorkbenchWidths(grid.getBoundingClientRect().width, desired, drag.side);
    pendingX = null;
    if (!resolved) return;
    preferred = resolved; paint(drag.side);
  }
  function finishDrag(commit) {
    if (!drag) return;
    if (commit) applyPending();
    else { if (frame) cancelAnimationFrame(frame); frame = 0; pendingX = null; preferred = drag.preferred; }
    const previous = drag; drag = null;
    document.body.classList.remove('workbench-resizing');
    previous.handle.classList.remove('is-dragging');
    if (previous.handle.hasPointerCapture?.(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
    paint();
    if (commit) persist();
  }
  function reset(side) { preferred = { ...preferred, [side]: PANELS[side].initial }; paint(side); persist(); }
  for (const [side, panel] of [['left', library], ['right', inspector]]) {
    const handle = document.createElement('div');
    handle.className = `workbench-separator workbench-separator-${side}`;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', side === 'left' ? '설비 패널 폭 조절' : '속성 패널 폭 조절');
    handle.setAttribute('aria-controls', ensureId(panel, `workbench-${side}-panel`));
    handle.setAttribute('aria-describedby', descriptionId);
    handle.title = '드래그 또는 좌우 방향키로 폭 조절 · 두 번 클릭하면 기본 폭';
    handles[side] = handle;
    (side === 'left' ? viewport : inspector).before(handle);
    listen(handle, 'pointerdown', event => {
      if (!active || !allowed() || event.button !== 0 || !event.isPrimary || drag) return;
      event.preventDefault(); handle.focus({ preventScroll: true });
      drag = { side, handle, pointerId: event.pointerId, startX: event.clientX, preferred: { ...preferred }, actual: { ...actual } };
      try { handle.setPointerCapture(event.pointerId); } catch { drag = null; return; }
      handle.classList.add('is-dragging'); document.body.classList.add('workbench-resizing');
    });
    listen(handle, 'pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId || drag.handle !== handle) return;
      event.preventDefault(); pendingX = event.clientX;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; applyPending(); });
    });
    listen(handle, 'pointerup', event => { if (drag?.pointerId === event.pointerId && drag.handle === handle) { pendingX = event.clientX; finishDrag(true); } });
    listen(handle, 'pointercancel', event => { if (drag?.pointerId === event.pointerId && drag.handle === handle) finishDrag(false); });
    listen(handle, 'lostpointercapture', () => { if (drag?.handle === handle) finishDrag(false); });
    listen(handle, 'dblclick', event => { if (!active) return; event.preventDefault(); finishDrag(false); reset(side); });
    listen(handle, 'keydown', event => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); finishDrag(false); return; }
      if (!active || event.altKey || event.ctrlKey || event.metaKey || drag || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Home') { reset(side); return; }
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1) * (event.shiftKey ? 24 : 8);
      preferred = resolveWorkbenchWidths(grid.getBoundingClientRect().width, { ...actual, [side]: actual[side] + delta }, side) || preferred;
      paint(side); persist();
    });
  }
  grid.classList.add('workbench-resizable');
  const refresh = () => { if (drag && !allowed()) finishDrag(false); paint(drag?.side); };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
  resize?.observe(grid);
  const changes = new MutationObserver(refresh);
  changes.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  changes.observe(grid, { attributes: true, attributeFilter: ['hidden'] });
  listen(window, 'resize', refresh); listen(desktop, 'change', refresh);
  listen(document, 'visibilitychange', refresh);
  listen(window, 'blur', () => finishDrag(false));
  paint();
  const api = { dispose() {
    if (disposed) return;
    finishDrag(false); disposed = true;
    if (frame) cancelAnimationFrame(frame);
    resize?.disconnect(); changes.disconnect(); cleanups.forEach(cleanup => cleanup());
    Object.values(handles).forEach(handle => handle.remove()); description.remove();
    grid.classList.remove('workbench-resizable', 'workbench-resize-active');
    for (const [name, value, priority] of oldVariables) value ? grid.style.setProperty(name, value, priority) : grid.style.removeProperty(name);
    for (const [element, id] of savedIds) if (element.id === id) element.removeAttribute('id');
    mounted.delete(grid);
  } };
  mounted.set(grid, api); return api;
}
