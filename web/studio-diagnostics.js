import { TELEMETRY_SIGNALS, DEFAULT_TELEMETRY_THRESHOLDS, MAX_TELEMETRY_BYTES, parseTelemetryCsv, createSyntheticTelemetry, telemetryToCsv, hashTelemetrySource, analyzeTelemetry, analyzeIsaacDiagnostics, buildSignalSeries, normalizeTelemetryThresholds } from './studio-telemetry.js';

const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const button = (text, action, className) => { const element = node('button', text, className); element.type = 'button'; element.addEventListener('click', action); return element; };
const format = (value, digits = 2) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: digits }) : '미수신';
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '발생 시각 미수신';
const svgNS = 'http://www.w3.org/2000/svg';
const svgNode = (tag, attributes = {}, text) => { const element = document.createElementNS(svgNS, tag); for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value)); if (text !== undefined) element.textContent = text; return element; };
const download = (filename, value, type) => { const url = URL.createObjectURL(new Blob([value], { type })), anchor = node('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); };

/** The host owns panel placement. Keep this mounted container when switching
 * project tabs so a local CSV remains available until explicitly replaced. */
export function mountDiagnostics(container, { getLayout = () => ({ assets: [] }), getRunEvidence = () => null, onSelectAsset = () => {}, askAI, notify = () => {} } = {}) {
  if (!container?.append) throw new Error('설비 진단 패널을 표시할 공간이 필요합니다.');
  let disposed = false, mode = 'sensor', thresholds = { ...DEFAULT_TELEMETRY_THRESHOLDS }, shownEvents = 80, loadGeneration = 0, aiGeneration = 0, aiBusy = false, lastEvidenceKey = '';
  const example = () => createSyntheticTelemetry({ equipmentIds: (getLayout()?.assets || []).filter(asset => !['walkway', 'worker-zone'].includes(asset.type)).map(asset => asset.id).slice(0, 8) });
  let dataset = example(), analysis = analyzeTelemetry(dataset, { thresholds }), run = analyzeIsaacDiagnostics(getRunEvidence(), getLayout());
  let equipmentId = dataset.equipmentIds[0], signalKey = 'temperature_c', eventFilter = 'all';
  const root = node('section', undefined, 'diagnostics'); root.setAttribute('aria-label', '설비 상태 분석 및 이상징후 탐지');
  const heading = node('div', undefined, 'diagnostics-heading'), titleWrap = node('div');
  titleWrap.append(node('span', 'EQUIPMENT DIAGNOSTICS', 'diagnostics-kicker'), node('h2', '설비 상태 · 이상징후 탐지'));
  heading.append(titleWrap, node('span', '설명 가능한 규칙 분석', 'diagnostics-method')); root.append(heading);
  const intro = node('p', '설비 관측값의 기준 초과와 초기 구간 대비 변화를 찾고, 판단 근거를 확인합니다. 실행 서버의 실제 관측과 예시 센서 데이터는 별도로 다룹니다.', 'diagnostics-intro'); root.append(intro);
  const sources = node('div', undefined, 'diagnostics-sources'); sources.setAttribute('role', 'group'); sources.setAttribute('aria-label', '분석 데이터 출처');
  const actualButton = button('실제 Isaac 실행 근거', () => { mode = 'run'; run = analyzeIsaacDiagnostics(getRunEvidence(), getLayout()); shownEvents = 80; render(); });
  const sensorButton = button('센서 CSV 분석', () => { mode = 'sensor'; render(); });
  const sampleButton = button('합성 예시 불러오기', () => { loadGeneration++; uploadButton.disabled = false; file.value = ''; dataset = example(); equipmentId = dataset.equipmentIds[0]; eventFilter = 'all'; mode = 'sensor'; analyze(); status.textContent = '합성 예시를 불러왔습니다. 현장 측정 데이터가 아닙니다.'; });
  const file = node('input'); file.type = 'file'; file.accept = '.csv,text/csv'; file.hidden = true;
  const uploadButton = button('CSV 가져오기', () => file.click(), 'diagnostics-primary');
  sources.append(actualButton, sensorButton, sampleButton, uploadButton, file); root.append(sources);
  const provenance = node('div', undefined, 'diagnostics-provenance'); provenance.setAttribute('role', 'status'); root.append(provenance);
  const status = node('p', '', 'diagnostics-status'); status.setAttribute('role', 'status'); root.append(status);
  const cards = node('div', undefined, 'diagnostics-cards'); root.append(cards);

  const thresholdSection = node('details', undefined, 'diagnostics-thresholds'); thresholdSection.append(node('summary', '분석 기준 설정 · 가정값'));
  const thresholdForm = node('form', undefined, 'diagnostics-threshold-form'), thresholdInputs = new Map();
  const thresholdDefinitions = [...TELEMETRY_SIGNALS, { key: 'baseline_percent', label: '초기 기준 대비 증가', unit: '%', min: 1, max: 1000 }, { key: 'baseline_samples', label: '초기 기준 표본 수', unit: '개/설비', min: 3, max: 200 }];
  for (const definition of thresholdDefinitions) {
    const label = node('label'), input = node('input'); input.type = 'number'; input.value = String(thresholds[definition.key]); input.min = String(definition.min); input.max = String(definition.max); input.step = definition.key === 'baseline_samples' ? '1' : 'any'; input.required = true;
    label.append(node('span', `${definition.label} (${definition.unit})`), input); thresholdForm.append(label); thresholdInputs.set(definition.key, input);
  }
  const apply = node('button', '기준 적용', 'diagnostics-primary'); apply.type = 'submit'; thresholdForm.append(apply);
  thresholdSection.append(node('p', '초기 표본 중앙값은 비교용 기준입니다. 정상 운전 구간이라는 보장은 없으며, 기본 임계값은 제조사 규격이나 안전 한계가 아닌 설명용 가정값입니다.', 'diagnostics-help'), thresholdForm); root.append(thresholdSection);
  thresholdForm.addEventListener('submit', event => {
    event.preventDefault();
    try { thresholds = normalizeTelemetryThresholds(Object.fromEntries([...thresholdInputs].map(([key, input]) => [key, input.value]))); analyze(); status.textContent = '입력한 가정 기준으로 다시 분석했습니다. 원본 관측값은 유지했습니다.'; }
    catch (error) { status.textContent = error.message; notify(error.message); }
  });

  const chartSection = node('section', undefined, 'diagnostics-chart-section');
  const chartHeading = node('div', undefined, 'diagnostics-section-heading'); chartHeading.append(node('h3', '관측 추세'));
  const chartControls = node('div', undefined, 'diagnostics-chart-controls'), equipmentSelect = node('select'), signalSelect = node('select');
  equipmentSelect.setAttribute('aria-label', '추세를 볼 설비'); signalSelect.setAttribute('aria-label', '추세를 볼 신호');
  for (const item of TELEMETRY_SIGNALS) { const option = node('option', `${item.label} (${item.unit})`); option.value = item.key; signalSelect.append(option); }
  chartControls.append(equipmentSelect, signalSelect); chartHeading.append(chartControls); chartSection.append(chartHeading);
  const chart = svgNode('svg', { viewBox: '0 0 1000 275', role: 'img', 'aria-label': '선택한 설비의 실제 입력 관측값 추세' }); chartSection.append(chart);
  const chartCaption = node('p', '', 'diagnostics-help'); chartSection.append(chartCaption); root.append(chartSection);
  equipmentSelect.addEventListener('change', () => { equipmentId = equipmentSelect.value; renderChart(); });
  signalSelect.addEventListener('change', () => { signalKey = signalSelect.value; renderChart(); });

  const runSection = node('section', undefined, 'diagnostics-run-section'); root.append(runSection);
  const eventSection = node('section', undefined, 'diagnostics-events'), eventHeading = node('div', undefined, 'diagnostics-section-heading');
  const eventTitle = node('h3', '기준 초과 관측'); eventHeading.append(eventTitle);
  const eventSelect = node('select'); eventSelect.setAttribute('aria-label', '이벤트 설비 필터'); eventHeading.append(eventSelect); eventSection.append(eventHeading);
  const eventHint = node('p', '', 'diagnostics-help'); eventSection.append(eventHint);
  const tableWrap = node('div', undefined, 'diagnostics-table-wrap'), table = node('table'), tableHead = node('thead'), headerRow = node('tr');
  for (const text of ['시각 (KST)', '설비 / 작업', '신호', '관측값', '입력 기준', '판단 근거', '출처']) { const th = node('th', text); th.scope = 'col'; headerRow.append(th); }
  tableHead.append(headerRow); const tableBody = node('tbody'); table.append(tableHead, tableBody); tableWrap.append(table); eventSection.append(tableWrap);
  const more = button('관측 더 보기', () => { shownEvents += 80; renderEvents(); }); eventSection.append(more); root.append(eventSection);
  eventSelect.addEventListener('change', () => { eventFilter = eventSelect.value; shownEvents = 80; renderEvents(); });

  const aiSection = node('section', undefined, 'diagnostics-ai');
  const aiHeading = node('div', undefined, 'diagnostics-section-heading'); aiHeading.append(node('h3', 'AI 원인 가설 · 후속 확인'));
  const aiButton = button('현재 근거로 AI 분석 요청', requestAI, 'diagnostics-primary'); aiButton.disabled = typeof askAI !== 'function'; aiHeading.append(aiButton); aiSection.append(aiHeading);
  aiSection.append(node('p', typeof askAI === 'function' ? '요청 버튼을 누르면 분석 요약과 일부 관측 이벤트를 연결된 AI로 보냅니다. 원시 CSV 파일은 보내지 않습니다. AI 해석은 규칙 판정과 구분해 표시합니다.' : 'AI 연결 전입니다. 아래 규칙 분석과 로컬 데이터 검토는 사용할 수 있습니다.', 'diagnostics-help'));
  const aiOutput = node('div', '', 'diagnostics-ai-output'); aiOutput.setAttribute('role', 'status'); aiSection.append(aiOutput); root.append(aiSection);
  const gaps = node('div', undefined, 'diagnostics-gaps'); root.append(gaps);
  const footer = node('div', undefined, 'diagnostics-footer');
  footer.append(button('분석 근거 JSON', () => download('RoboCell_설비진단_근거.json', JSON.stringify({ ...(mode === 'run' ? run : analysis), exported_at: new Date().toISOString() }, null, 2), 'application/json')),
    button('합성 예시 CSV 내려받기', () => download('RoboCell_합성_설비상태_예시.csv', telemetryToCsv(example()), 'text/csv;charset=utf-8')),
    button('실제 실행 근거 새로 읽기', refreshRunEvidence)); root.append(footer);
  root.append(node('p', 'CSV: UTF-8, 최대 2MB / 20,000행. 필수 열 timestamp,equipment_id,temperature_c,vibration_mm_s,current_a,cycle_s · 선택 열 state. timestamp는 시간대 포함 ISO 8601이며 전체 행을 오름차순으로 정렬해야 합니다.', 'diagnostics-help'));
  container.append(root);

  file.addEventListener('change', async () => {
    const selected = file.files?.[0]; if (!selected) return;
    const generation = ++loadGeneration; status.textContent = 'CSV를 로컬에서 읽고 형식·시간순서·해시를 확인하고 있습니다.'; uploadButton.disabled = true;
    try {
      if (selected.size > MAX_TELEMETRY_BYTES) throw new Error('CSV 파일은 2MB 이하로 올려 주세요.');
      const bytes = await selected.arrayBuffer(); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let sha256 = null; try { sha256 = await hashTelemetrySource(bytes); } catch { /* The visible source marks the unavailable hash. */ }
      const next = parseTelemetryCsv(text, { filename: selected.name, sha256 });
      if (disposed || generation !== loadGeneration) return;
      const nextAnalysis = analyzeTelemetry(next, { thresholds }); dataset = next; analysis = nextAnalysis; mode = 'sensor'; equipmentId = next.equipmentIds[0]; eventFilter = 'all'; shownEvents = 80;
      render(); status.textContent = `${next.rows.length.toLocaleString()}행을 읽었습니다. 파일은 이 브라우저 안에서 분석했으며 자동 업로드하지 않았습니다.`;
    } catch (error) {
      if (disposed || generation !== loadGeneration) return;
      status.textContent = error instanceof TypeError ? 'UTF-8 CSV 파일인지 확인해 주세요. 이전 분석은 유지했습니다.' : `${error.message} 이전 분석은 유지했습니다.`; notify(status.textContent);
    } finally { if (!disposed && generation === loadGeneration) { file.value = ''; uploadButton.disabled = false; } }
  });

  function assetName(id) { return (getLayout()?.assets || []).find(asset => asset.id === id)?.name || id; }
  function analyze() { analysis = analyzeTelemetry(dataset, { thresholds }); shownEvents = 80; render(); }
  function render() {
    if (disposed) return;
    const sensorMode = mode === 'sensor', current = sensorMode ? analysis : run;
    const evidenceKey = JSON.stringify(getEvidence());
    if (lastEvidenceKey && evidenceKey !== lastEvidenceKey) { aiGeneration++; aiBusy = false; aiButton.disabled = typeof askAI !== 'function'; if (aiOutput.childNodes.length) aiOutput.replaceChildren(node('p', '분석 근거가 바뀌어 이전 AI 응답을 보류했습니다. 현재 근거로 다시 요청해 주세요.')); }
    lastEvidenceKey = evidenceKey;
    actualButton.setAttribute('aria-pressed', String(!sensorMode)); sensorButton.setAttribute('aria-pressed', String(sensorMode));
    thresholdSection.hidden = !sensorMode; chartSection.hidden = !sensorMode; runSection.hidden = sensorMode; eventSelect.hidden = !sensorMode;
    provenance.replaceChildren(node('strong', current.source.label));
    provenance.dataset.kind = current.source.kind;
    if (sensorMode) {
      provenance.append(node('span', `${dataset.source.filename} · ${time(dataset.dataQuality.start)} — ${time(dataset.dataQuality.end)} (KST)`));
      if (dataset.source.kind === 'uploaded-csv') provenance.append(node('code', dataset.source.sha256 ? `SHA-256 ${dataset.source.sha256}` : 'SHA-256 미생성 · 브라우저 암호화 기능을 사용할 수 없음'));
      else provenance.append(node('span', dataset.source.note));
      provenance.append(node('span', '배치 설비 선택은 장비 ID 일치로만 연결합니다. 센서와 현재 프로젝트의 실제 대응 관계를 검증한 것은 아닙니다.'));
    } else provenance.append(node('span', `작업 ${run.jobId || '미확인'} · ${run.note}`));
    cards.replaceChildren();
    const values = sensorMode ? [['관측 표본', `${format(analysis.summary.rowCount, 0)}행`], ['기준 초과 설비', `${analysis.summary.equipmentWithEvents} / ${analysis.summary.equipmentCount}`], ['신호 초과 관측', `${format(analysis.summary.eventCount, 0)}건`], ['큰 편차 관측', `${format(analysis.summary.highDeviationCount, 0)}건`]] :
      [['실행 스냅샷', run.dataQuality.rowCount ? '수신' : '미수신'], ['작업 번호', run.identityMatches ? '일치' : '확인 필요'], ['현재 배치', run.layoutMatches ? '요청 사본 일치' : '일치 미확인'], ['문제 종류', `${run.anomalies.length}종`]];
    for (const [label, value] of values) { const card = node('div'); card.append(node('span', label), node('strong', value)); cards.append(card); }
    if (sensorMode) {
      equipmentSelect.replaceChildren(); eventSelect.replaceChildren(); const all = node('option', '모든 설비'); all.value = 'all'; eventSelect.append(all);
      for (const id of dataset.equipmentIds) { for (const select of [equipmentSelect, eventSelect]) { const option = node('option', assetName(id)); option.value = id; select.append(option); } }
      equipmentSelect.value = equipmentId; signalSelect.value = signalKey; eventSelect.value = eventFilter; renderChart();
    } else renderRun();
    renderEvents(); gaps.replaceChildren(node('h3', '아직 확인되지 않은 근거'));
    const list = node('ul'); for (const item of current.missingEvidence) list.append(node('li', item)); gaps.append(list, node('p', current.note, 'diagnostics-help'));
  }
  function renderRun() {
    runSection.replaceChildren(node('h3', '실제 실행 서버 관측'));
    runSection.append(node('p', '서버가 제공하는 값은 실행 카운터와 상태 스냅샷입니다. 온도·진동 등 센서 시계열을 대신 만들지 않습니다. 접촉 이벤트가 없으므로 접촉 횟수나 충돌 여부도 추정하지 않습니다.', 'diagnostics-help'));
    const counters = node('div', undefined, 'diagnostics-run-counters'), labels = { ik_timeouts: 'IK 시간 초과', grasp_fail: '파지 실패', part_lost: '부품 유실', parts_lost: '부품 유실(서버 별칭)', good: '양품 카운터', ng: '불량 카운터', wip: '재공 카운터' };
    if (!Object.keys(run.counters).length) counters.append(node('p', '유효한 서버 카운터를 아직 받지 못했습니다.'));
    for (const [key, value] of Object.entries(run.counters)) { const item = node('div'); item.append(node('span', labels[key] || key), node('strong', `${value}건`)); counters.append(item); }
    runSection.append(counters, node('p', run.dataQuality.note, 'diagnostics-help'));
  }
  function renderChart() {
    chart.replaceChildren(); const signal = TELEMETRY_SIGNALS.find(item => item.key === signalKey), points = buildSignalSeries(dataset, equipmentId, signalKey);
    chart.setAttribute('aria-label', `${assetName(equipmentId)} ${signal.label} 관측값 추세. ${dataset.source.label}.`);
    chart.append(svgNode('title', {}, `${assetName(equipmentId)} · ${signal.label} · ${dataset.source.label}`));
    if (!points.length) { chart.append(svgNode('text', { x: 500, y: 130, 'text-anchor': 'middle' }, '표시할 관측값이 없습니다.')); return; }
    const threshold = thresholds[signalKey], baseline = analysis.equipment.find(item => item.equipment_id === equipmentId)?.baselines[signalKey];
    const values = [...points.map(point => point.value), threshold], rawMin = Math.min(...values), rawMax = Math.max(...values), pad = Math.max((rawMax - rawMin) * .14, Math.abs(rawMax) * .025, .1);
    const min = rawMin - pad, max = rawMax + pad, first = points[0].at, span = Math.max(1, points.at(-1).at - first);
    const left = 66, top = 24, width = 903, height = 192, px = at => left + (at - first) / span * width, py = value => top + (max - value) / (max - min) * height;
    chart.append(svgNode('rect', { x: left, y: top, width, height, fill: '#f8fafc' }));
    for (let n = 0; n <= 4; n++) { const value = min + (max - min) * n / 4, y = py(value); chart.append(svgNode('line', { x1: left, y1: y, x2: left + width, y2: y, class: 'diagnostics-chart-grid' }), svgNode('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'diagnostics-chart-axis' }, format(value))); }
    chart.append(svgNode('line', { x1: left, y1: py(threshold), x2: left + width, y2: py(threshold), class: 'diagnostics-chart-threshold' }));
    chart.append(svgNode('text', { x: left + width - 5, y: py(threshold) - 8, 'text-anchor': 'end', class: 'diagnostics-chart-threshold-label' }, `입력 기준 ${format(threshold)} ${signal.unit}`));
    if (baseline !== null && baseline !== undefined && baseline >= min && baseline <= max) chart.append(svgNode('line', { x1: left, y1: py(baseline), x2: left + width, y2: py(baseline), class: 'diagnostics-chart-baseline' }));
    chart.append(svgNode('polyline', { points: points.map(point => `${px(point.at).toFixed(2)},${py(point.value).toFixed(2)}`).join(' '), class: 'diagnostics-chart-signal' }));
    const visibleEvents = analysis.anomalies.filter(item => item.equipment_id === equipmentId && item.signal === signalKey).filter((_, index, all) => index % Math.max(1, Math.ceil(all.length / 150)) === 0);
    for (const item of visibleEvents) { const dot = svgNode('circle', { cx: px(item.at), cy: py(item.value), r: 3.2, class: 'diagnostics-chart-event' }); dot.append(svgNode('title', {}, `${time(item.timestamp)} · ${item.reason}`)); chart.append(dot); }
    for (let n = 0; n <= 4; n++) { const at = first + span * n / 4; chart.append(svgNode('text', { x: px(at), y: top + height + 27, 'text-anchor': n === 0 ? 'start' : n === 4 ? 'end' : 'middle', class: 'diagnostics-chart-axis' }, new Date(at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }))); }
    chart.append(svgNode('text', { x: left, y: 14, class: 'diagnostics-chart-axis' }, signal.unit), svgNode('text', { x: left + width, y: 267, 'text-anchor': 'end', class: 'diagnostics-chart-axis' }, '시각 (KST)'));
    const total = dataset.rows.filter(row => row.equipment_id === equipmentId).length;
    chartCaption.textContent = `파란선: 입력 관측값 · 주황선: 가정 임계값 · 회색 점선: 초기 ${thresholds.baseline_samples}개 표본 중앙값 · 붉은 점: 규칙 해당 관측. ${total > points.length ? `${total}개 중 극값을 보존한 ${points.length}개 표본을 표시합니다.` : `${total}개 표본을 표시합니다.`}`;
  }
  function renderEvents() {
    const current = mode === 'run' ? run : analysis, events = mode === 'run' ? run.anomalies : analysis.anomalies.filter(item => eventFilter === 'all' || item.equipment_id === eventFilter);
    eventTitle.textContent = mode === 'run' ? '실행 문제 관측' : '기준 초과 관측';
    eventHint.textContent = mode === 'run' ? '행의 시각은 관측 스냅샷 시각입니다. 개별 문제의 발생 시각은 제공되지 않았습니다.' :
      `같은 표본에서 여러 신호가 초과하면 각각 표시합니다. 장비 이름을 누르면 같은 ID의 배치 설비를 선택합니다.${analysis.summary.eventsTruncated ? ` 분석 이벤트 ${format(analysis.summary.eventCount, 0)}개 중 최대 ${analysis.anomalies.length}개를 보관합니다.` : ''}`;
    tableBody.replaceChildren();
    if (!events.length) { const row = node('tr'), cell = node('td', mode === 'run' ? '현재 근거에 표시할 문제 관측이 없습니다. 문제 부재나 정상 운전을 보증하지 않습니다.' : '지정한 기준에 해당하는 관측이 없습니다. 설비 정상 상태나 안전을 보증하지 않습니다.'); cell.colSpan = 7; row.append(cell); tableBody.append(row); }
    for (const item of events.slice(0, shownEvents)) {
      const row = node('tr'); row.dataset.level = item.level;
      const equipmentCell = node('td'), selectable = item.equipment_id && (getLayout()?.assets || []).some(asset => asset.id === item.equipment_id);
      if (selectable) { const select = button(assetName(item.equipment_id), event => { event.stopPropagation(); onSelectAsset(item.equipment_id); }); select.title = '3D 배치에서 이 설비 선택'; equipmentCell.append(select); row.addEventListener('click', () => onSelectAsset(item.equipment_id)); row.classList.add('is-selectable'); }
      else equipmentCell.textContent = item.equipment_id || `작업 ${run.jobId || '미확인'} · 설비 미분류`;
      const signal = TELEMETRY_SIGNALS.find(signal => signal.key === item.signal);
      row.append(node('td', time(item.timestamp)), equipmentCell, node('td', signal?.label || item.signal), node('td', item.value === null ? '상태 기록' : `${format(item.value)} ${item.unit}`),
        node('td', item.threshold === null ? '상태 오류 관측' : mode === 'run' ? '> 0건 기록' : `${format(item.threshold)} ${item.unit}${item.rules?.some(rule => rule.kind === 'baseline-change') ? ` / +${thresholds.baseline_percent}%` : ''}`),
        node('td', item.reason), node('td', mode === 'run' ? '실제 서버' : dataset.source.kind === 'synthetic-example' ? '합성 예시' : '업로드 CSV')); tableBody.append(row);
    }
    more.hidden = events.length <= shownEvents; more.textContent = `관측 더 보기 (${Math.min(shownEvents, events.length)} / ${events.length})`;
  }
  function getEvidence() {
    const current = mode === 'run' ? run : analysis;
    return structuredClone({ ...current, anomalies: current.anomalies.slice(0, 80),
      equipment: current.equipment?.slice(0, 40), contextEventCount: Math.min(current.anomalies.length, 80),
      contextEventsOmitted: Math.max(0, (current.summary.eventCount || 0) - 80), selectedMode: mode,
      layoutAssociation: mode === 'sensor' ? { kind: 'id-match-only-unverified', matchedIds: dataset.equipmentIds.filter(id => (getLayout()?.assets || []).some(asset => asset.id === id)) } : undefined,
      contextNote: '외부 AI와 보고서용 제한된 요약입니다. 원시 CSV 행은 포함하지 않습니다.' });
  }
  async function requestAI() {
    if (typeof askAI !== 'function' || aiBusy || disposed) return;
    aiBusy = true; aiButton.disabled = true; const generation = ++aiGeneration, evidence = getEvidence();
    aiOutput.replaceChildren(node('p', '연결된 AI가 현재 근거를 검토하고 있습니다.')); const sourceLabel = evidence.source.label;
    try {
      const response = await askAI({ layout: getLayout(), runEvidence: mode === 'run' ? getRunEvidence() : null, diagnostics: evidence });
      if (disposed || generation !== aiGeneration) return;
      const value = typeof response === 'string' ? response : response?.answer ?? response?.text ?? response?.result ?? response;
      const kind = response?.mode === 'llm' ? '실제 AI 응답' : response?.mode ? `분석 응답 (${response.mode})` : '연결된 분석 응답';
      aiOutput.replaceChildren(node('span', `${kind} · 요청 당시 출처: ${sourceLabel}`, 'diagnostics-ai-source'), node('pre', typeof value === 'string' ? value.slice(0, 30_000) : (JSON.stringify(value, null, 2) || '응답 본문이 비어 있습니다.').slice(0, 30_000)));
      if (response && typeof response === 'object') {
        const provenance = [response.provider, response.model, response.request_id ? `요청 ${response.request_id}` : ''].filter(Boolean).map(value => String(value).slice(0, 300)).join(' · ');
        if (provenance) aiOutput.append(node('p', provenance, 'diagnostics-help'));
        if (Array.isArray(response.citations) && response.citations.length) aiOutput.append(node('p', `인용 근거: ${response.citations.slice(0, 20).map(item => `${String(item.evidence_id || '').slice(0, 100)}${item.field ? ` / ${String(item.field).slice(0, 200)}` : ''}`).join(' · ')}`, 'diagnostics-help'));
        if (Array.isArray(response.unverified) && response.unverified.length) { aiOutput.append(node('strong', 'AI가 미확인으로 남긴 항목')); const list = node('ul'); for (const value of response.unverified.slice(0, 20)) list.append(node('li', String(value).slice(0, 1000))); aiOutput.append(list); }
      }
    } catch (error) { if (!disposed && generation === aiGeneration) aiOutput.replaceChildren(node('p', `AI 요청을 완료하지 못했습니다: ${error.message || '연결 상태를 확인해 주세요.'} 규칙 분석 결과는 유지됩니다.`)); }
    finally { if (!disposed && generation === aiGeneration) { aiBusy = false; aiButton.disabled = false; } }
  }
  function refreshRunEvidence() { if (disposed) return; run = analyzeIsaacDiagnostics(getRunEvidence(), getLayout()); if (mode === 'run') render(); status.textContent = '현재 선택한 실제 실행 근거를 다시 읽었습니다.'; }
  render();
  return { getEvidence, refreshRunEvidence, refreshLayout() { render(); }, dispose() { disposed = true; loadGeneration++; aiGeneration++; root.remove(); },
    setMode(next) { mode = next === 'run' ? 'run' : 'sensor'; if (mode === 'run') run = analyzeIsaacDiagnostics(getRunEvidence(), getLayout()); render(); } };
}
