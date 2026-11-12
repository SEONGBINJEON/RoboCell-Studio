import { fingerprintLayout, getRuntimeDiagnostics, isRunId, normalizeJobDetail } from './studio-runtime.js';

export const MAX_TELEMETRY_BYTES = 2_000_000;
export const MAX_TELEMETRY_ROWS = 20_000;
export const MAX_STORED_EVENTS = 4_000;
export const TELEMETRY_SIGNALS = Object.freeze([
  Object.freeze({ key: 'temperature_c', label: '온도', unit: '°C', min: -273.15, max: 2000 }),
  Object.freeze({ key: 'vibration_mm_s', label: '진동 속도', unit: 'mm/s', min: .001, max: 1000 }),
  Object.freeze({ key: 'current_a', label: '전류', unit: 'A', min: .001, max: 1_000_000 }),
  Object.freeze({ key: 'cycle_s', label: '사이클 시간', unit: 's', min: .001, max: 10_000_000 }),
]);
export const DEFAULT_TELEMETRY_THRESHOLDS = Object.freeze({ temperature_c: 70, vibration_mm_s: 4.5, current_a: 16, cycle_s: 45, baseline_percent: 35, baseline_samples: 12 });
const required = ['timestamp', 'equipment_id', ...TELEMETRY_SIGNALS.map(signal => signal.key)];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const median = values => { const sorted = [...values].sort((a, b) => a - b), at = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[at] : (sorted[at - 1] + sorted[at]) / 2; };
const rounded = value => Math.round(value * 1000) / 1000;

export function normalizeTelemetryThresholds(raw = {}) {
  const result = { ...DEFAULT_TELEMETRY_THRESHOLDS };
  for (const item of [...TELEMETRY_SIGNALS, { key: 'baseline_percent', min: 1, max: 1000 }, { key: 'baseline_samples', min: 3, max: 200 }]) {
    if (raw[item.key] === undefined) continue;
    const value = typeof raw[item.key] === 'number' || typeof raw[item.key] === 'string' && raw[item.key].trim() ? Number(raw[item.key]) : NaN;
    if (!Number.isFinite(value) || value < item.min || value > item.max || item.key === 'baseline_samples' && !Number.isInteger(value)) throw new Error(`${item.label || item.key} 기준 범위를 확인해 주세요 (${item.min}~${item.max}).`);
    result[item.key] = value;
  }
  return result;
}

function csvRecords(text) {
  const rows = []; let cells = [], value = '', quoted = false, afterQuote = false, line = 1, startLine = 1;
  const pushRow = () => { cells.push(value); if (cells.some(cell => cell.trim())) rows.push({ cells, line: startLine }); cells = []; value = ''; afterQuote = false; if (rows.length > MAX_TELEMETRY_ROWS + 1) throw new Error(`CSV는 최대 ${MAX_TELEMETRY_ROWS.toLocaleString()}행까지 읽을 수 있습니다.`); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; afterQuote = true; } }
      else { value += char; if (char === '\n') line++; }
    } else if (char === '"') {
      if (value || afterQuote) throw new Error(`${line}행의 따옴표 형식이 올바르지 않습니다.`);
      quoted = true;
    } else if (char === ',') { cells.push(value); value = ''; afterQuote = false; }
    else if (char === '\n' || char === '\r') { pushRow(); if (char === '\r' && text[i + 1] === '\n') i++; line++; startLine = line; }
    else { if (afterQuote && char.trim()) throw new Error(`${line}행에서 닫힌 따옴표 뒤에 문자가 있습니다.`); if (!afterQuote) value += char; }
  }
  if (quoted) throw new Error('CSV의 마지막 따옴표가 닫히지 않았습니다.');
  if (value || cells.length || afterQuote) pushRow();
  return rows;
}
function parseTimestamp(value, line) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const at = Date.parse(value);
  if (!match || !Number.isFinite(at)) throw new Error(`${line}행 timestamp는 시간대가 있는 ISO 8601 형식이어야 합니다 (예: 2026-11-12T09:00:00+09:00).`);
  const [, year, month, day, hour, minute, second] = match.map((item, i) => i > 0 && i < 7 ? Number(item) : item);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) throw new Error(`${line}행 timestamp의 날짜 또는 시간이 올바르지 않습니다.`);
  return at;
}

/** UTF-8 CSV only; malformed rows are rejected instead of silently skipped. */
export function parseTelemetryCsv(raw, { filename = '업로드 CSV', sha256 = null } = {}) {
  if (typeof raw !== 'string') throw new Error('CSV 텍스트가 필요합니다.');
  const byteLength = new TextEncoder().encode(raw).byteLength;
  if (byteLength > MAX_TELEMETRY_BYTES) throw new Error('CSV 파일은 2MB 이하로 올려 주세요.');
  const records = csvRecords(raw.replace(/^\ufeff/, ''));
  if (records.length < 2) throw new Error('CSV 헤더와 최소 한 행의 관측값이 필요합니다.');
  const headers = records.shift().cells.map(value => value.trim());
  if (new Set(headers).size !== headers.length || required.some(key => !headers.includes(key)) || headers.some(key => ![...required, 'state'].includes(key))) throw new Error(`CSV 열은 ${required.join(', ')} 및 선택 항목 state를 사용하세요. 중복·알 수 없는 열은 허용하지 않습니다.`);
  const previousByEquipment = new Map(), rows = []; let previousAt = -Infinity;
  for (const { cells, line } of records) {
    if (cells.length !== headers.length) throw new Error(`${line}행의 열 개수가 헤더와 다릅니다.`);
    const input = Object.fromEntries(headers.map((key, i) => [key, cells[i].trim()]));
    if (!input.equipment_id || input.equipment_id.length > 128 || /[\u0000-\u001f\u007f]/.test(input.equipment_id)) throw new Error(`${line}행 equipment_id는 1~128자의 장비 식별자여야 합니다.`);
    const at = parseTimestamp(input.timestamp, line);
    if (at < previousAt) throw new Error(`${line}행의 시간이 앞선 행보다 빠릅니다. timestamp 오름차순으로 정렬해 주세요.`);
    if (at <= (previousByEquipment.get(input.equipment_id) ?? -Infinity)) throw new Error(`${line}행에 같은 장비의 중복 또는 역순 시각이 있습니다.`);
    const row = { timestamp: new Date(at).toISOString(), at, equipment_id: input.equipment_id, state: clean(input.state, 80), row_number: line };
    for (const signal of TELEMETRY_SIGNALS) {
      const value = input[signal.key];
      if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error(`${line}행 ${signal.key}에는 비어 있지 않은 유한한 수치가 필요합니다.`);
      row[signal.key] = Number(value);
      if (signal.key === 'temperature_c' && row[signal.key] < -273.15 || signal.key !== 'temperature_c' && row[signal.key] < 0 || signal.key === 'cycle_s' && row[signal.key] === 0) throw new Error(`${line}행 ${signal.key} 값의 단위와 부호를 확인해 주세요.`);
    }
    rows.push(row); previousAt = at; previousByEquipment.set(row.equipment_id, at);
  }
  return makeDataset(rows, { kind: 'uploaded-csv', label: '사용자 업로드 CSV · 측정 출처 미검증', filename: clean(filename, 180), sha256: /^[a-f0-9]{64}$/i.test(sha256 || '') ? sha256.toLowerCase() : null, byteLength, measurementStatus: 'userprovided-unverified' });
}
function makeDataset(rows, source) {
  return { schema_version: 'robocell-telemetry/v1', source, rows, equipmentIds: [...new Set(rows.map(row => row.equipment_id))],
    dataQuality: { rowCount: rows.length, equipmentCount: new Set(rows.map(row => row.equipment_id)).size, start: rows[0]?.timestamp || null, end: rows.at(-1)?.timestamp || null,
      timeOrdered: true, invalidRows: 0, droppedRows: 0, timestampZone: 'explicit', note: '형식과 시간순서를 검사했습니다. 센서 교정·측정 정확성은 검증하지 않았습니다.' } };
}

export function createSyntheticTelemetry({ equipmentIds = ['cnc-a-01', 'cnc-a-02', 'robot-r-01', 'inspection-01'], samples = 120 } = {}) {
  const ids = [...new Set(equipmentIds.filter(id => typeof id === 'string' && id.trim()).map(id => clean(id, 128)))].slice(0, 8);
  if (!ids.length) ids.push('example-cnc-01');
  samples = Number.isInteger(samples) ? Math.max(20, Math.min(500, samples)) : 120;
  const start = Date.parse('2026-11-12T00:00:00Z'), rows = [];
  for (let n = 0; n < samples; n++) for (const [i, id] of ids.entries()) {
    const phase = Math.sin(n * .38 + i * 1.7), drift = Math.max(0, n - 45), at = start + n * 30_000;
    rows.push({ timestamp: new Date(at).toISOString(), at, equipment_id: id, temperature_c: rounded(43 + i * 2 + phase * 1.3 + (i % 4 === 0 ? drift * .52 : 0)),
      vibration_mm_s: rounded(1.8 + i * .11 + Math.abs(phase) * .3 + (i % 4 === 1 ? drift * .075 : 0)),
      current_a: rounded(8 + i * .7 + phase * .4 + (i % 4 === 2 && n > 50 && n % 13 < 3 ? 10 : 0)),
      cycle_s: rounded(29 + i * 2 + phase * .6 + (i % 4 === 3 && n > 70 ? 20 : 0)), state: 'running', row_number: rows.length + 2 });
  }
  return makeDataset(rows, { kind: 'synthetic-example', label: '합성 예시 · 현장 측정 데이터 아님', filename: 'RoboCell_합성_설비상태_예시.csv', sha256: null,
    measurementStatus: 'synthetic', generator: 'deterministic-example/v1', note: '온도 상승·진동 증가·전류 피크·사이클 지연을 설명하기 위해 생성한 값입니다.' });
}

export function telemetryToCsv(dataset) {
  const quote = value => { let string = String(value ?? ''); if (typeof value === 'string' && /^[=+@-]/.test(string)) string = `'${string}`; return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string; };
  const fields = [...required, 'state'];
  return `${fields.join(',')}\r\n${dataset.rows.map(row => fields.map(key => quote(row[key])).join(',')).join('\r\n')}\r\n`;
}
export async function hashTelemetrySource(input, provider = globalThis.crypto) {
  if (!provider?.subtle?.digest) return null;
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await provider.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function analyzeTelemetry(dataset, options = {}) {
  if (!record(dataset) || !Array.isArray(dataset.rows) || !dataset.rows.length || dataset.rows.length > MAX_TELEMETRY_ROWS) throw new Error('검사할 설비 상태 데이터가 없습니다.');
  if (!record(dataset.source) || !record(dataset.dataQuality) || dataset.rows.some(row => !record(row) || typeof row.equipment_id !== 'string' || !row.equipment_id || !Number.isFinite(row.at) || TELEMETRY_SIGNALS.some(signal => typeof row[signal.key] !== 'number' || !Number.isFinite(row[signal.key])))) throw new Error('정상화된 설비 관측값과 출처가 필요합니다.');
  const thresholds = normalizeTelemetryThresholds(options.thresholds || options), byEquipment = new Map();
  for (const row of dataset.rows) { if (!byEquipment.has(row.equipment_id)) byEquipment.set(row.equipment_id, []); byEquipment.get(row.equipment_id).push(row); }
  const events = [], equipment = [], affectedRows = new Set(); let eventCount = 0, highDeviationCount = 0;
  for (const [id, rows] of byEquipment) {
    const baselineReady = rows.length > thresholds.baseline_samples;
    const baselines = Object.fromEntries(TELEMETRY_SIGNALS.map(signal => [signal.key, baselineReady ? median(rows.slice(0, thresholds.baseline_samples).map(row => row[signal.key])) : null]));
    let equipmentEvents = 0; const signals = Object.fromEntries(TELEMETRY_SIGNALS.map(signal => [signal.key, { min: Infinity, max: -Infinity, latest: rows.at(-1)[signal.key], events: 0 }]));
    rows.forEach((row, index) => {
      for (const signal of TELEMETRY_SIGNALS) {
        const value = row[signal.key], threshold = thresholds[signal.key], baseline = baselines[signal.key], rules = [];
        signals[signal.key].min = Math.min(signals[signal.key].min, value); signals[signal.key].max = Math.max(signals[signal.key].max, value);
        if (value > threshold) rules.push({ kind: 'threshold', limit: threshold, unit: signal.unit });
        const changePercent = baselineReady && index >= thresholds.baseline_samples && baseline > 0 ? (value - baseline) / baseline * 100 : null;
        if (changePercent !== null && changePercent > thresholds.baseline_percent) rules.push({ kind: 'baseline-change', limit: thresholds.baseline_percent, baselineValue: baseline, changePercent: rounded(changePercent), unit: '%' });
        if (!rules.length) continue;
        const level = value - threshold > Math.max(Math.abs(threshold), .001) * .25 || changePercent !== null && changePercent > thresholds.baseline_percent * 1.5 ? 'high-deviation' : 'attention';
        eventCount++; equipmentEvents++; signals[signal.key].events++; if (level === 'high-deviation') highDeviationCount++;
        affectedRows.add(`${id}\u0000${row.timestamp}`);
        if (events.length < MAX_STORED_EVENTS) events.push({ id: `event-${eventCount}`, equipment_id: id, timestamp: row.timestamp, at: row.at, signal: signal.key, signalLabel: signal.label, unit: signal.unit, value,
          threshold, baselineValue: baseline, changePercent: changePercent === null ? null : rounded(changePercent), rules, level, state: row.state,
          source: dataset.source.label, reason: rules.map(rule => rule.kind === 'threshold' ? `${signal.label} ${value}${signal.unit} > 입력 기준 ${threshold}${signal.unit}` : `초기 ${thresholds.baseline_samples}개 표본 중앙값 ${rounded(baseline)}${signal.unit} 대비 +${rounded(changePercent)}% > 입력 변화 기준 ${thresholds.baseline_percent}%`).join(' / ') });
      }
    });
    equipment.push({ equipment_id: id, samples: rows.length, eventCount: equipmentEvents, baselineReady, baselines, signals });
  }
  events.sort((a, b) => a.at - b.at || a.equipment_id.localeCompare(b.equipment_id));
  return { schema_version: 'robocell-telemetry-analysis/v1', method: 'deterministic-threshold-and-initial-median', source: { ...dataset.source }, thresholds,
    thresholdSource: '사용자 조정 가능 가정값 · 제조사 허용 한계 또는 안전 기준 아님', dataQuality: { ...dataset.dataQuality }, equipment,
    summary: { rowCount: dataset.rows.length, equipmentCount: byEquipment.size, equipmentWithEvents: equipment.filter(item => item.eventCount).length, eventCount, storedEventCount: events.length,
      highDeviationCount, affectedSampleCount: affectedRows.size, eventsTruncated: eventCount > events.length }, anomalies: events,
    missingEvidence: ['설비별 제조사 허용 범위와 센서 교정 기록', '초기 기준 구간이 정상 운전이었다는 현장 확인', '고장 원인·향후 고장 시점·안전 승인에 대한 독립 검증'],
    note: '규칙에 해당한 관측값을 찾습니다. 학습 모델의 예측, 확정 고장 진단 또는 설비 안전 판정이 아닙니다. 초기 기준 구간이 정상 상태라는 보장은 없습니다.' };
}

/** Retains actual observed extrema; does not fabricate interpolated samples. */
export function buildSignalSeries(dataset, equipmentId, signal, maxPoints = 400) {
  if (!TELEMETRY_SIGNALS.some(item => item.key === signal)) throw new Error('표시할 신호를 확인해 주세요.');
  const rows = dataset.rows.filter(row => row.equipment_id === equipmentId), limit = Math.max(6, Math.floor(maxPoints));
  if (rows.length <= limit) return rows.map(row => ({ at: row.at, value: row[signal], timestamp: row.timestamp }));
  const selected = new Set([0, rows.length - 1]), buckets = Math.floor((limit - 2) / 2);
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = 1 + Math.floor(bucket * (rows.length - 2) / buckets), end = 1 + Math.floor((bucket + 1) * (rows.length - 2) / buckets);
    let min = start, max = start;
    for (let at = start; at < end; at++) { if (rows[at][signal] < rows[min][signal]) min = at; if (rows[at][signal] > rows[max][signal]) max = at; }
    selected.add(min); selected.add(max);
  }
  return [...selected].sort((a, b) => a - b).map(index => ({ at: rows[index].at, value: rows[index][signal], timestamp: rows[index].timestamp }));
}

/** Isaac exposes run counters, not the example sensor stream. Positive counters
 * are snapshot observations; their individual occurrence times are unknown. */
export function analyzeIsaacDiagnostics(raw, layout) {
  const input = record(raw) ? raw : {}, jobId = isRunId(input.job_id) ? input.job_id : null;
  const observation = record(input.current_observation) ? input.current_observation : null;
  const detail = record(input.job_detail) && jobId ? normalizeJobDetail(input.job_detail, jobId) : null;
  const identityMatches = !!jobId && (!observation || observation.job_id === jobId && (observation.run_id == null || observation.run_id === jobId))
    && (!input.job_detail || detail?.ok === true) && (!input.request_snapshot || input.request_snapshot.job_id === jobId);
  let layoutMatches = false;
  try { layoutMatches = !!input.request_snapshot?.layout && fingerprintLayout(input.request_snapshot.layout) === fingerprintLayout(layout); } catch { /* Remains unknown. */ }
  const sample = identityMatches ? observation || (detail?.ok ? { ...detail.live_status, state: detail.state, exit_code: detail.exit_code } : null) : null;
  const diagnostics = sample ? getRuntimeDiagnostics(sample) : [];
  const sampleTime = input.request_snapshot?.last_sample_at;
  const observedAt = Number.isFinite(sampleTime) && Number.isFinite(new Date(sampleTime).valueOf()) ? new Date(sampleTime).toISOString() : null;
  const anomalies = diagnostics.map((item, index) => ({ id: `run-observation-${index + 1}`, equipment_id: null, job_id: jobId, timestamp: observedAt, timeSemantics: 'snapshot-time-not-event-time',
    signal: item.code, signalLabel: item.message, value: item.count ?? null, threshold: item.count == null ? null : 0, unit: item.count == null ? '' : '건',
    source: 'Isaac 실행 서버 관측', reason: item.message, level: item.level === 'error' ? 'high-deviation' : 'attention' }));
  return { schema_version: 'robocell-isaac-diagnostics/v1', source: { kind: 'isaac-run', label: '실제 Isaac 실행 근거 · 센서 CSV와 별도', jobId }, jobId, identityMatches, layoutMatches,
    dataQuality: { rowCount: sample ? 1 : 0, equipmentCount: 0, observedAt, note: '단일 실행 스냅샷입니다. 개별 문제의 발생 시각과 장비 귀속은 제공되지 않았습니다.' },
    summary: { eventCount: anomalies.length, equipmentWithEvents: null, note: '문제 종류 수이며 총 발생 횟수는 각 서버 카운터로 확인합니다.' }, anomalies,
    counters: sample ? Object.fromEntries(['ik_timeouts', 'grasp_fail', 'part_lost', 'parts_lost', 'good', 'ng', 'wip'].filter(key => Number.isSafeInteger(sample[key]) && sample[key] >= 0).map(key => [key, sample[key]])) : {},
    missingEvidence: ['온도·진동·전류·사이클 시계열 미수신', '검증된 접촉 이벤트 미수신 — 접촉 횟수나 충돌 판정을 추정하지 않음', '개별 이벤트 발생 시각과 설비별 센서 식별자 미수신'],
    note: !identityMatches ? '작업 번호를 확인할 수 없거나 서로 달라 관측값을 표시하지 않습니다.' : !sample ? '현재 선택한 작업의 서버 관측값이 없습니다.' :
      layoutMatches ? '실행 당시 배치와 현재 초안이 일치합니다. 기록된 문제는 원인 확정이나 안전 판정을 뜻하지 않습니다.' : '현재 초안과 실행 배치의 일치를 확인하지 못했습니다. 아래 값은 표시된 작업 번호의 관측입니다.' };
}
