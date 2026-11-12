import { normalizeLayout } from './studio-model.js';

// Pure presentation rules. These checks describe transport/runtime evidence;
// they never validate robot safety, physical correctness or production quality.
export const STATUS_MAX_AGE_MS = 10_000;
export const FRAME_MAX_AGE_MS = 8_000;
const READY_STATES = new Set(['running', 'playing', 'paused']);
const LOADING_STATES = new Set(['starting', 'loading', 'configured']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const nonnegative = value => number(value) !== null && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max = 500) => typeof value === 'string'
  ? value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : '';
const fresh = (timestamp, now, limit) => number(timestamp) !== null && number(now) !== null
  && now >= timestamp && now - timestamp <= limit;

export function isRunId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(value);
}

/** Request ceiling, not a claim about the renderer's frame rate. */
export function normalizeStreamRate(value) {
  const rate = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return [4, 8, 12, 24].includes(rate) ? rate : 24;
}

/** Successful image deliveries in the trailing three-second interval. During
 * the first second there is too little observation to report a useful rate.
 * This measures browser receipts, which may include the same rendered image. */
export function getReceivedFps(timestamps, { startedAt, now = Date.now() } = {}) {
  if (!Array.isArray(timestamps) || nonnegative(startedAt) === null || nonnegative(now) === null || now < startedAt) return null;
  const start = Math.max(startedAt, now - 3000), elapsed = now - start;
  if (elapsed < 1000) return null;
  const received = timestamps.filter(at => number(at) !== null && at > start && at <= now).length;
  return received * 1000 / elapsed;
}

/** Guard async reads against a newer poll, reconnect or control command.
 * Call invalidate() before a control mutation, then begin() for its fresh read.
 * A response may update the screen only if isCurrent(itsToken) is still true. */
export function createStatusGate() {
  let generation = 0, active = null;
  return {
    begin() { active = ++generation; return active; },
    isCurrent(token) { return active !== null && token === active; },
    invalidate() { generation += 1; active = null; },
  };
}

/** Refresh the selected current run as it changes, leaving older selected runs
 * alone. lastObservedState is the status state at the start of the detail read;
 * a read that began during loading must not mask a later running/paused state. */
export function shouldRefreshJobDetail({ selectedJob, currentJobId, currentState,
  lastObservedState, detail, detailBusy = false, now = Date.now() } = {}) {
  if (detailBusy || !isRunId(selectedJob)) return false;
  if (!detail || detail.job_id !== selectedJob) return true;
  if (selectedJob !== currentJobId) return false;
  if (lastObservedState !== currentState) return true;
  const fetchedAt = typeof detail.fetched_at === 'string' ? Date.parse(detail.fetched_at) : NaN;
  return !Number.isFinite(fetchedAt) || now < fetchedAt || now - fetchedAt > 10_000;
}

/** Stable comparison token, not a cryptographic hash. Includes all draft fields,
 * including names and planning-only height/target/processTime. Asset list order
 * is ignored; asset identities and every normalized property are retained.
 * Throws on an invalid layout instead of treating it as an unchanged draft. */
export function fingerprintLayout(raw) {
  const layout = normalizeLayout(raw);
  layout.assets.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return JSON.stringify(layout);
}

/** Compare only values sent to the legacy Isaac adapter. This deliberately does
 * not include draft height, targets or process timing, which are not applied.
 * Call with getIsaacCompatibility(layout).payload. Invalid payloads return null. */
export function fingerprintIsaacPayload(payload) {
  if (!record(payload) || !record(payload.hall) || !record(payload.cell)
      || !record(payload.aisle) || !record(payload.worker_zone)) return null;
  const values = [payload.hall.length_m, payload.hall.width_m, payload.cell.x, payload.cell.y,
    payload.cell.rotation_deg, payload.aisle.y0, payload.aisle.y1,
    payload.worker_zone.x0, payload.worker_zone.x1, payload.worker_zone.y0, payload.worker_zone.y1];
  return values.every(value => number(value) !== null) ? JSON.stringify(values) : null;
}

/** Return failure observations, not a validation verdict. Zero counters cannot
 * prove success; missing or malformed counters remain unknown. */
export function getRuntimeDiagnostics(raw) {
  const sim = record(raw) ? raw : {};
  const diagnostics = [];
  for (const [key, label] of [['ik_timeouts', 'IK 시간 초과'], ['grasp_fail', '파지 실패'], ['part_lost', '부품 유실'], ['parts_lost', '부품 유실']]) {
    const value = count(sim[key]);
    if (value > 0) diagnostics.push({ code: key, level: 'warning', count: value, message: `${label} ${value}건이 서버에 기록됐습니다.` });
  }
  const captureError = text(sim.capture_error).trim();
  if (captureError) diagnostics.push({ code: 'capture_error', level: 'error', message: `렌더 캡처 오류: ${captureError}` });
  if (['error', 'failed', 'crashed'].includes(sim.state)) diagnostics.push({ code: 'run_failed', level: 'error', message: text(sim.message).trim() || '실행 서버가 실패 상태를 반환했습니다.' });
  if (Number.isInteger(sim.exit_code) && sim.exit_code !== 0) diagnostics.push({ code: 'exit_code', level: 'error', message: `실행 프로세스가 종료 코드 ${sim.exit_code}로 끝났습니다.` });
  return diagnostics;
}

/**
 * All timestamps are browser epoch milliseconds. Update frameProgressAt only
 * when frame_id changes; reset it when job_id changes. Pass requestRunId only
 * when the displayed stream is bound to that requested run.
 *
 * ready / controlsEnabled: state is usable for Play/Pause/camera (independent of
 * image health so a broken camera can still be changed). canStop also permits
 * this identified job's loading phase but excludes stopping. isLive is stricter and never follows an
 * <img> load event alone. metrics hold only fresh numeric server observations.
 */
export function classifyRuntime(raw, {
  online = false, lastSuccessAt = null, now = Date.now(), streamLoaded = false,
  requestRunId = null, frameProgressAt = null,
} = {}) {
  const sim = record(raw) ? raw : {};
  const connected = online === true;
  const statusFresh = connected && fresh(lastSuccessAt, now, STATUS_MAX_AGE_MS);
  const statusAgeMs = number(lastSuccessAt) !== null && number(now) !== null && now >= lastSuccessAt ? now - lastSuccessAt : null;
  const jobId = isRunId(sim.job_id) ? sim.job_id : null;
  const runId = isRunId(sim.run_id) ? sim.run_id : null;
  const hasRunId = sim.run_id !== undefined && sim.run_id !== null;
  const hasRequest = requestRunId !== undefined && requestRunId !== null;
  const identityMatches = Boolean(jobId) && (!hasRunId || runId === jobId)
    && (!hasRequest || (isRunId(requestRunId) && requestRunId === jobId));
  const running = sim.running === true;
  const ready = statusFresh && identityMatches && running && READY_STATES.has(sim.state);
  const canStop = statusFresh && identityMatches && running && sim.state !== 'stopping';
  const captureError = text(sim.capture_error).trim();
  const sampledFrameAgeS = nonnegative(sim.last_frame_age_s);
  // The server's age is a sample, not a clock. Keep it aging between status
  // responses so repeated delivery of an old JPEG cannot prolong LIVE.
  const frameAgeS = sampledFrameAgeS !== null && statusAgeMs !== null ? sampledFrameAgeS + statusAgeMs / 1000 : null;
  const frameId = count(sim.frame_id);
  const frameAdvancing = fresh(frameProgressAt, now, FRAME_MAX_AGE_MS);
  let frameHealth, reason;
  if (!connected) [frameHealth, reason] = ['offline', '실행 서버와 연결되지 않았습니다.'];
  else if (!statusFresh) [frameHealth, reason] = ['stale-status', '서버 상태 갱신이 지연되어 마지막 화면과 수치를 숨겼습니다.'];
  else if (!running) [frameHealth, reason] = ['idle', '현재 실행 중인 작업이 없습니다.'];
  else if (!identityMatches) [frameHealth, reason] = ['identity-mismatch', '작업 번호와 실행 번호가 일치하지 않아 화면과 제어를 보류합니다.'];
  else if (sim.state === 'stopping') [frameHealth, reason] = ['stopping', '종료 요청을 전달했습니다. 실행 프로세스가 끝날 때까지 상태를 확인하고 있습니다.'];
  else if (LOADING_STATES.has(sim.state)) [frameHealth, reason] = ['loading', 'Isaac Sim 환경을 불러오고 있습니다.'];
  else if (!ready) [frameHealth, reason] = ['not-ready', '실행 상태를 확인할 수 없어 재생 제어를 보류합니다.'];
  else if (captureError) [frameHealth, reason] = ['capture-error', `렌더 캡처 오류: ${captureError}`];
  else if (frameAgeS !== null && frameAgeS * 1000 > FRAME_MAX_AGE_MS) [frameHealth, reason] = ['stale-frame', '새 렌더 프레임이 도착하지 않아 LIVE 표시를 중단했습니다.'];
  else if (frameId !== null && number(frameProgressAt) !== null && !frameAdvancing) [frameHealth, reason] = ['stale-frame', '렌더 프레임 번호가 갱신되지 않아 LIVE 표시를 중단했습니다.'];
  else if (!runId || frameAgeS === null || frameId === null || !frameAdvancing) [frameHealth, reason] = ['missing-frame', '실행 번호와 최신 프레임 정보를 확인하고 있습니다.'];
  else if (!streamLoaded) [frameHealth, reason] = ['connecting', '실제 렌더 화면의 첫 프레임을 기다리고 있습니다.'];
  else [frameHealth, reason] = ['live', sim.paused === true || sim.state === 'paused' ? '일시정지된 실제 장면입니다.' : '현재 작업의 실제 렌더를 수신하고 있습니다.'];
  const showMetrics = statusFresh && identityMatches && running && READY_STATES.has(sim.state);
  return {
    connected, statusFresh, identityMatches, ready, controlsEnabled: ready, canStop,
    jobId, runId, frameHealth, isLive: frameHealth === 'live', reason,
    frameAgeS, frameId, statusAgeMs,
    metrics: {
      sim_t: showMetrics ? nonnegative(sim.sim_t) : null,
      good: showMetrics ? count(sim.good) : null,
      ng: showMetrics ? count(sim.ng) : null,
      wip: showMetrics ? count(sim.wip) : null,
    },
    diagnostics: getRuntimeDiagnostics(sim),
  };
}

const numericPair = value => Array.isArray(value) && value.length === 2 && value.every(item => number(item) !== null) ? [...value] : null;

/** Whitelist a read-only /api/jobs/{id} response for UI and JSON export. Never
 * trust echoed arbitrary keys, shell command fields, server paths or a claimed
 * overall pass as a physical validation result. Log text must be rendered with
 * textContent/pre, never innerHTML. Returns {ok:false,error} on identity errors. */
export function normalizeJobDetail(raw, expectedJobId) {
  if (!isRunId(expectedJobId)) return { ok: false, error: '올바른 작업 번호가 필요합니다.' };
  if (!record(raw) || raw.job_id !== expectedJobId) return { ok: false, error: '조회한 작업 번호와 서버 응답이 일치하지 않습니다.' };
  const live = record(raw.live_status) ? raw.live_status : {};
  if ((live.run_id != null && live.run_id !== expectedJobId) || (live.job_id != null && live.job_id !== expectedJobId)) {
    return { ok: false, error: '실시간 상태가 다른 작업을 가리켜 결과를 표시하지 않습니다.' };
  }
  const liveStatus = {};
  for (const key of ['sim_t', 'timeline_time', 'wall_s', 'elapsed_wall_s', 'last_frame_age_s']) {
    if (nonnegative(live[key]) !== null) liveStatus[key] = live[key];
  }
  for (const key of ['frame', 'frame_id', 'good', 'ng', 'wip', 'jobs_done', 'grasp_ok', 'grasp_fail', 'ik_timeouts', 'part_lost', 'parts_lost']) {
    if (count(live[key]) !== null) liveStatus[key] = live[key];
  }
  for (const key of ['paused', 'timeline_playing', 'belt_running']) if (typeof live[key] === 'boolean') liveStatus[key] = live[key];
  for (const key of ['state', 'robot_state', 'camera', 'capture_error']) if (typeof live[key] === 'string') liveStatus[key] = text(live[key]);
  if (Array.isArray(live.carrier0_xyz) && live.carrier0_xyz.length === 3 && live.carrier0_xyz.every(v => number(v) !== null)) liveStatus.carrier0_xyz = [...live.carrier0_xyz];
  const derived = record(raw.derived) ? raw.derived : {};
  return {
    ok: true, schema_version: 'robocell-job-evidence/v1', source: 'isaac-platform-api',
    job_id: expectedJobId, name: text(raw.name, 80), state: text(raw.state, 80),
    created: text(raw.created, 80), updated: text(raw.updated, 80), started: text(raw.started, 80),
    scene_version: text(raw.scene_version, 160), exit_code: Number.isInteger(raw.exit_code) ? raw.exit_code : null,
    sim_t: nonnegative(raw.sim_t), good: count(raw.good), ng: count(raw.ng),
    derived: {
      hall: numericPair(derived.hall), robot_base_expected: numericPair(derived.robot_base_expected), aisle: numericPair(derived.aisle),
      removed_lathes: Array.isArray(derived.removed_lathes) ? derived.removed_lathes.slice(0, 100).filter(v => typeof v === 'string').map(v => text(v, 80)) : [],
    },
    warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 50).filter(v => typeof v === 'string').map(v => text(v)) : [],
    live_status: liveStatus,
    // Last portion is the API's bounded log excerpt, not the complete run log.
    log_tail: text(typeof raw.log_tail === 'string' ? raw.log_tail.slice(-8000) : '', 8000),
    validation: { status: 'not_assessed', note: '상태·로그 발췌 조회이며 물리·생산성 검증 결과가 아닙니다.' },
    diagnostics: getRuntimeDiagnostics({ ...liveStatus, state: raw.state, exit_code: raw.exit_code }),
  };
}
