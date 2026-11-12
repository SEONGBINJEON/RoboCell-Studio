import { normalizeLayout } from './studio-model.js';
import { getIsaacCompatibility, validateIsaacResponse } from './studio-isaac.js';
import { isRunId, fingerprintLayout, classifyRuntime, getRuntimeDiagnostics, normalizeJobDetail, createStatusGate, shouldRefreshJobDetail, normalizeStreamRate, getReceivedFps } from './studio-runtime.js';

const $ = id => document.getElementById(id);
const RUNS_KEY = 'robocell-studio-run-receipts-v1';
const states = { idle:'실행 대기', configured:'환경 구성됨', starting:'시작 중', loading:'환경 적재 중', running:'실행 중', playing:'실행 중', paused:'일시정지', stopping:'종료 요청됨', exited:'실행 종료', done:'실행 완료', failed:'실행 실패', error:'실행 오류' };
const num = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR', {maximumFractionDigits:1}) : '—';
const stamp = value => value ? new Date(value).toLocaleString('ko-KR', {hour12:false}) : '아직 없음';
const line = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };

/** UI controller for the existing single-job platform. Only explicit user actions send POSTs. */
export function createLiveController({getLayout, onLoadLayout, notify}) {
  let visible = false, mode = 'live', online = false, sim = {}, jobs = [], selectedJob = '', detail = null;
  let monitoring = false, streamRate = 24, receivedFrames = [], receiveStartedAt = null;
  let timer, watchdog, frameTimer, requestBusy = false, operation = '', lastSuccessAt = 0, failures = 0, error = '', target = '';
  let frameId, frameJob, frameProgressAt = 0, streamLoaded = false, streamJob = '', streamRetryAt = 0, streamGeneration = 0, lastClientFrameAt = 0, frameStartedAt = 0;
  let detailGeneration = 0, detailBusy = false, detailError = '', detailObservedState = null, pendingCamera = null;
  let receipts = {}, storageBlocked = false;
  const gate = createStatusGate();
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    if (raw) {
      if (raw.length > 1_000_000) throw new Error('large');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length > 12) throw new Error('shape');
      for (const item of parsed) {
        if (!isRunId(item.job_id)) throw new Error('id');
        const layout = normalizeLayout(item.layout);
        receipts[item.job_id] = {...item, layout};
      }
    }
  } catch { storageBlocked = true; receipts = {}; }

  function storeReceipt(id, patch) {
    if (!isRunId(id)) return;
    receipts[id] = {...receipts[id], ...structuredClone(patch), job_id:id};
    const entries = Object.values(receipts).sort((a,b)=>String(b.requested_at).localeCompare(String(a.requested_at))).slice(0,12);
    receipts = Object.fromEntries(entries.map(r=>[r.job_id,r]));
    if (storageBlocked) return;
    try { localStorage.setItem(RUNS_KEY, JSON.stringify(entries)); }
    catch { storageBlocked = true; notify('실행 기록을 브라우저에 저장하지 못했습니다. 실행 근거 JSON으로 내려받으세요.'); }
  }
  async function api(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), body === undefined ? 7000 : 20000);
    try {
      const response = await fetch(`/isaac${path}`, {method:body === undefined ? 'GET':'POST',
        headers:body === undefined ? {Accept:'application/json'} : {'Content-Type':'application/json',Accept:'application/json'},
        body:body === undefined ? undefined : JSON.stringify(body), cache:'no-store', signal:controller.signal});
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('로컬 연결 서버에서 스튜디오를 열어 주세요.');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || `요청 실패 (${response.status})`);
      return data;
    } catch(e) {
      if (e.name === 'AbortError') throw new Error('서버 응답 시간이 초과됐습니다. 실행 요청은 자동으로 반복하지 않습니다.');
      if (e.name === 'TypeError' && /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|Network request failed)$/i.test(e.message)) {
        throw new Error('로컬 연결 서버에 연결하지 못했습니다. 스튜디오 실행 도구가 켜져 있는지 확인해 주세요. 연결 상태는 자동으로 다시 확인합니다.');
      }
      throw e;
    }
    finally { clearTimeout(timeout); }
  }
  function acceptStatus(result) {
    if (!result || typeof result.sim !== 'object' || !result.sim || typeof result.sim.running !== 'boolean') throw new Error('서버 상태 응답 형식을 확인할 수 없습니다.');
    sim = result.sim; jobs = Array.isArray(result.jobs) ? result.jobs.filter(j=>j && isRunId(j.job_id)).slice(-20).reverse() : [];
    online = true; lastSuccessAt = Date.now(); failures = 0; error = '';
    if (frameJob !== sim.job_id) { frameJob = sim.job_id; frameId = undefined; frameProgressAt = 0; disconnectStream(); }
    if (Number.isFinite(sim.frame_id) && sim.frame_id !== frameId) { frameId = sim.frame_id; frameProgressAt = Date.now(); }
    if (!selectedJob) selectedJob = isRunId(sim.job_id) ? sim.job_id : jobs[0]?.job_id || '';
    if (receipts[sim.job_id]) {
      const r = receipts[sim.job_id];
      if (r.last_state !== sim.state || !r.last_sample_at || Date.now()-r.last_sample_at > 10000) {
        storeReceipt(sim.job_id,{last_state:sim.state,last_sample_at:Date.now(),last_observed:sim});
      }
    }
    render();
  }
  function schedule() {
    clearTimeout(timer);
    if (!monitoring || document.hidden) return;
    const interval = visible ? 2500 : 3000;
    timer = setTimeout(()=>refresh(), online ? interval : Math.min(15000, interval * 2 ** Math.min(failures,3)));
  }
  async function refresh(manual = false) {
    if (!monitoring || document.hidden || requestBusy || operation) return;
    requestBusy = true; const token = gate.begin();
    render();
    try {
      if (manual || !online) {
        if (!target) { const c = await api('/connection'); target = c.target || ''; }
        if (document.hidden || !gate.isCurrent(token)) return;
        const health = await api('/health'); if (health.ok !== true) throw new Error('실행 서버 상태가 정상이 아닙니다.');
      }
      if (document.hidden || !gate.isCurrent(token)) return;
      const result = await api('/api/status');
      if (document.hidden || !gate.isCurrent(token)) return;
      acceptStatus(result);
      if (visible && shouldRefreshJobDetail({selectedJob,currentJobId:sim.job_id,currentState:sim.state,
        lastObservedState:detailObservedState,detail,detailBusy})) loadDetail(selectedJob);
      if (visible && pendingCamera && pendingCamera.job_id === sim.job_id && ['running','playing','paused'].includes(sim.state) && sim.running) {
        const request = pendingCamera; pendingCamera = null;
        // The default view was chosen in the explicit build action for this exact job.
        if (sim.camera !== request.camera) await control('camera',{camera:request.camera},request.job_id);
      }
    } catch(e) {
      if (gate.isCurrent(token)) { online = false; failures++; error = e.message; disconnectStream(); render(); }
    } finally { requestBusy = false; render(); schedule(); }
  }
  function runtime() { return classifyRuntime(sim,{online,lastSuccessAt,now:Date.now(),streamLoaded:streamLoaded && Date.now()-lastClientFrameAt<=8000,frameProgressAt}); }
  function disconnectStream() {
    clearTimeout(frameTimer);
    streamGeneration++; $('live-stream').onload = null; $('live-stream').onerror = null;
    $('live-stream').removeAttribute('src'); $('live-stream').hidden = true; streamLoaded = false; streamJob = ''; lastClientFrameAt = 0;
    receivedFrames = []; receiveStartedAt = null;
  }
  function connectStream() {
    const image = $('live-stream'); const generation = ++streamGeneration; const id = sim.job_id;
    streamJob = id; streamLoaded = false; frameStartedAt = Date.now(); receiveStartedAt = frameStartedAt;
    const nextFrame = () => {
      if (generation !== streamGeneration || !visible || document.hidden || sim.job_id !== id) return;
      frameStartedAt = Date.now();
      image.src = `/isaac/frame.jpg?t=${Date.now()}`;
    };
    image.onload = () => {
      if (generation !== streamGeneration || !visible || mode !== 'live' || !online || !sim.running || sim.job_id !== id) return;
      streamLoaded = true; lastClientFrameAt = Date.now();
      receivedFrames = receivedFrames.filter(at=>at>lastClientFrameAt-3000);
      receivedFrames.push(lastClientFrameAt); renderStream();
      // Count completed JPEG deliveries, not unique rendered frames. Keep one
      // request in flight and let slower server/network delivery limit the rate.
      if (generation === streamGeneration) frameTimer = setTimeout(nextFrame, Math.max(0,1000/streamRate-(Date.now()-frameStartedAt)));
    };
    image.onerror = () => {
      if (generation !== streamGeneration) return;
      disconnectStream(); streamRetryAt = Date.now()+5000; renderStream();
    };
    nextFrame();
  }
  function renderCompatibility() {
    const layout = getLayout(), check = getIsaacCompatibility(layout);
    $('run-layout-name').textContent = layout.name;
    $('run-dimensions').textContent = `${num(layout.factory.width)} × ${num(layout.factory.depth)} m`;
    $('run-cell-count').textContent = `${layout.assets.filter(a=>a.type==='robot-cell').length}개`;
    $('compatibility-title').textContent = check.errors.length ? '실행 전 배치를 조정해 주세요':'현재 실행기에서 반영 가능한 배치';
    const notes = check.errors.length ? check.errors : ['로봇 셀 위치 · 공장 가로·세로 · 통로 · 작업자 구역을 반영합니다.'];
    $('compatibility-list').replaceChildren(...[...notes,...check.warnings.filter(x=>x.includes('겹'))].map(x=>line('li',x)));
    $('build-and-run').disabled = !online || !runtime().statusFresh || !!operation || requestBusy || sim.running || !!check.errors.length;
    $('build-and-run').textContent = operation === 'build' ? '환경 구성·실행 요청 중…':'이 배치로 환경 구성·실행 ↗';
    $('build-status').textContent = operation === 'build' ? '확정한 배치를 저장하고 실행 서버에 요청하고 있습니다.' :
      !online ? '연결을 자동 재확인하고 있습니다. 실행 요청은 자동으로 보내지 않습니다.' :
      sim.running ? '현재 작업이 실행 중입니다. 배치를 편집해도 실행 중인 장면은 바뀌지 않습니다.' :
      check.errors.length ? '지원 범위에 맞게 배치를 조정하면 실행할 수 있습니다.' : '버튼을 누르면 이 배치를 확정해 5090 PC에서 실제 시뮬레이션을 시작합니다.';
    const receipt = receipts[sim.job_id];
    const same = receipt && fingerprintLayout(receipt.layout) === fingerprintLayout(layout);
    $('run-provenance').textContent = receipt ? `${same ? '실행 당시 배치와 현재 초안이 같습니다.' : '현재 초안이 실행 당시 배치와 다릅니다. 영상·수치는 확정된 실행 배치의 결과입니다.'} 확정: ${stamp(receipt.requested_at)}` :
      sim.job_id ? '이 브라우저에 실행 당시 배치가 없습니다. 현재 초안과 같은 조건이라고 판단하지 않습니다.' : '실행 시 배치 사본을 별도로 보관합니다. 이후 편집은 실행 장면에 영향을 주지 않습니다.';
    $('run-provenance').classList.toggle('changed',!!receipt && !same);
  }
  function render() {
    const rt = runtime();
    const connectionLabel = rt.statusFresh ? '5090 연결됨' : online ? '연결 갱신 대기' : '5090 연결 확인 중';
    const connectionDot = $('global-connection-dot');
    if (connectionDot) {
      const state = !rt.statusFresh ? 'offline' : sim.running && !rt.identityMatches ? 'warning' : 'connected';
      connectionDot.dataset.state = state;
      for (const value of ['connected','warning','offline']) connectionDot.classList.toggle(`is-${value}`,state===value);
      connectionDot.title = `${connectionLabel} · 마지막 응답 ${stamp(lastSuccessAt)}`;
    }
    if ($('global-connection-label')) $('global-connection-label').textContent = connectionLabel;
    if ($('global-run-label')) {
      $('global-run-label').textContent = !rt.statusFresh ? '상태 확인 중' : sim.running && !rt.identityMatches ? '작업 번호 확인 필요' :
        `${states[sim.state] || '실행 대기'}${Number.isFinite(rt.metrics.sim_t) ? ` · ${num(rt.metrics.sim_t)}s` : ''}`;
      $('global-run-label').title = rt.statusFresh && sim.job_id ? `현재 서버 작업 ${sim.job_id}` : '최신 실행 상태를 확인합니다.';
    }
    $('check-connection').disabled = requestBusy || !!operation;
    $('connection-card').className = `connection-card ${rt.statusFresh ? 'connected':'offline'}`;
    $('connection-title').textContent = rt.statusFresh ? '5090 실행 서버 연결됨' : '실행 서버 연결 확인 중';
    $('connection-description').textContent = online ? `마지막 응답 ${stamp(lastSuccessAt)}` : error || '연결 상태를 확인합니다.';
    $('connection-target').textContent = target ? `연결 대상 ${target}` : '로컬 게이트웨이 설정 확인 중';
    $('run-job-id').textContent = online && sim.job_id ? sim.job_id : '아직 없음';
    $('run-state').textContent = !rt.statusFresh ? '상태 갱신 대기' : sim.running && !rt.identityMatches ? '작업 번호 확인 필요' : states[sim.state] || '상태 확인 필요';
    for (const [id,key,unit] of [['run-time','sim_t','s'],['run-good','good','개'],['run-ng','ng','개']]) {
      $(id).textContent = Number.isFinite(rt.metrics[key]) ? `${num(rt.metrics[key])} ${unit}` : '—';
    }
    $('sim-play').disabled = mode !== 'live' || !rt.controlsEnabled || !!operation || !(sim.paused || sim.state === 'paused');
    $('sim-pause').disabled = mode !== 'live' || !rt.controlsEnabled || !!operation || sim.paused || sim.state === 'paused';
    $('sim-camera').disabled = mode !== 'live' || !rt.controlsEnabled || !!operation;
    $('sim-stop').disabled = mode !== 'live' || !rt.canStop || !!operation;
    if ([...$('sim-camera').options].some(o=>o.value===sim.camera)) $('sim-camera').value = sim.camera;
    $('control-status').textContent = operation && operation !== 'build' ? '실행 서버가 제어 요청을 처리하고 있습니다.' :
      mode === 'recorded' ? '기존 영상은 현재 실행과 별개입니다. 아래 지표는 연결된 서버의 상태입니다.' :
      rt.frameHealth === 'stopping' ? rt.reason :
      !online ? '연결을 복구하면 상태를 다시 표시합니다.' : sim.message || '배치를 확인한 뒤 실행을 시작하세요.';
    const diagnostics = rt.statusFresh && (!sim.running || rt.identityMatches) ? getRuntimeDiagnostics(sim) : [];
    $('runtime-diagnostics').replaceChildren(...diagnostics.map(d=>line('li',typeof d==='string' ? d : d.message || d.label || JSON.stringify(d))));
    $('runtime-diagnostics').hidden = !diagnostics.length;
    $('validation-note').textContent = '이 화면의 상태·수량은 서버 관측값입니다. 물리·안전 검증 결과와 생산성 비교 결과는 아직 수신하지 않습니다.';
    renderStream(rt); renderCompatibility(); renderHistory();
  }
  function renderStream(rt = runtime()) {
    $('frame-status').textContent = rt.statusFresh && sim.running ? `프레임 ${num(sim.frame_id)} · 서버 프레임 경과 ${num(rt.frameAgeS)}s · 화면 수신 ${lastClientFrameAt ? `${num((Date.now()-lastClientFrameAt)/1000)}초 전`:'대기'} · 최대 ${streamRate}회/초${sim.paused ? ' · 시뮬레이션 일시정지':''}` : '현재 수신 중인 실행 프레임 없음';
    if (mode === 'live') {
      if (streamJob && Date.now()-(lastClientFrameAt || frameStartedAt)>8000) { disconnectStream(); streamRetryAt=Date.now()+2500; }
      const usable = visible && !document.hidden && rt.ready && ['connecting','live'].includes(rt.frameHealth);
      if (!usable && streamJob) disconnectStream();
      if (usable && !streamJob && Date.now() >= streamRetryAt) connectStream();
      const show = usable && runtime().isLive;
      $('live-stream').hidden = !show; $('live-placeholder').hidden = show;
      $('stream-badge').textContent = show ? (sim.paused ? '일시정지':'LIVE') : !online ? '연결 대기' : rt.frameHealth === 'stopping' ? '종료 대기' : sim.running ? '영상 확인 중':'실행 대기';
      $('stream-badge').className = `stream-badge${show ? ' is-live':''}`;
      $('live-placeholder-title').textContent = !online ? '실행 서버에 연결하고 있어요' : !sim.running ? '실행할 배치를 준비해 주세요' : rt.frameHealth === 'stopping' ? '실행 프로세스의 종료를 기다리고 있어요' : rt.frameHealth === 'loading' ? 'Isaac Sim 환경을 불러오고 있어요' : !rt.identityMatches ? '실행 작업 번호를 확인하고 있어요' : '최신 렌더 화면을 확인하고 있어요';
      $('live-placeholder-description').textContent = !online ? error || '잠시 후 자동으로 다시 확인합니다.' : !sim.running ? sim.message || '실행 가능한 배치를 확인하고 환경 구성·실행을 누르세요.' : rt.reason || '5090 PC의 최신 렌더를 기다립니다. 화면이 검으면 로봇 근접 또는 공장 조감도로 전환하세요.';
      $('live-source-note').textContent = `현재 서버 실행 ${sim.job_id || '없음'} · 편집 초안과 실행 당시 배치를 구분하세요.`;
    }
    const telemetry = $('stream-telemetry');
    if (telemetry) {
      const fps = getReceivedFps(receivedFrames,{startedAt:receiveStartedAt});
      telemetry.textContent = mode === 'recorded' ? '기존 영상 · 실시간 수신과 별개' : !streamLoaded ? `실시간 수신 대기 · 최대 ${streamRate}회/초` :
        `수신 ${fps === null ? '측정 중' : `${num(fps)} fps`} · 최대 ${streamRate}회/초 · 프레임 ${num(rt.frameAgeS)}s 전`;
      telemetry.title = '최근 3초 동안 이 브라우저에 도착한 JPEG 수신 속도입니다. 같은 렌더 이미지가 포함될 수 있으며 시뮬레이터 FPS와 다릅니다.';
      telemetry.dataset.state = mode === 'recorded' ? 'recorded' : runtime().frameHealth;
    }
  }
  function renderHistory() {
    const options = jobs.map(j=>({id:j.job_id,label:`${j.name || '이름 없음'} · ${states[j.state] || j.state || '상태 없음'} · ${j.job_id}`}));
    const key = JSON.stringify(options);
    if ($('job-history').dataset.options !== key) {
      $('job-history').replaceChildren(line('option','실행 기록 선택'),...options.map(o=>{const el=line('option',o.label);el.value=o.id;return el;}));
      $('job-history').options[0].value = ''; $('job-history').dataset.options = key;
    }
    $('job-history').value = selectedJob;
    $('refresh-job').disabled = !online || !selectedJob || detailBusy;
    $('export-run').disabled = !selectedJob || (!detail && !receipts[selectedJob]);
    $('restore-run-layout').disabled = !receipts[selectedJob]?.layout;
    const detailStatus = detailBusy ? '실행 기록을 조회하고 있습니다.' : detailError || (detail ? `${detail.job_id} · ${states[detail.state] || detail.state || '상태 없음'} · 조회 ${stamp(detail.fetched_at || detail.observed_at)}` : '서버의 실행 기록과 이 브라우저에서 확정한 배치를 확인할 수 있습니다.');
    $('job-detail-status').textContent = detailStatus + (storageBlocked ? ' 브라우저 실행 기록을 읽거나 저장하지 못했습니다. 기존 저장값은 덮어쓰지 않으며 새 기록은 이 탭에만 보관됩니다. 새로고침 전에 실행 근거 JSON으로 내려받으세요.' : '');
    if (detail) {
      const last = detail.live_status || {};
      const diagnostics = [...new Set((detail.diagnostics || []).map(d=>d.message).filter(Boolean))];
      $('job-detail-summary').textContent = `마지막 관측: ${num(last.sim_t ?? detail.sim_t)}s · 양품 ${num(last.good ?? detail.good)}개 · 불량 ${num(last.ng ?? detail.ng)}개.${diagnostics.length ? ` 기록된 문제: ${diagnostics.join(' ')}` : ''} 전체 검증 판정은 제공되지 않습니다.`;
      $('job-log').textContent = detail.log_tail || '이 작업의 로그가 아직 없거나 응답에 포함되지 않았습니다.';
    } else { $('job-detail-summary').textContent=''; $('job-log').textContent='실행 기록을 선택하세요.'; }
  }
  async function loadDetail(id) {
    if (!isRunId(id)) return;
    if (detailBusy && selectedJob === id) return;
    selectedJob = id; if (detail?.job_id !== id) detail = null;
    detailError = ''; detailBusy = true; const token = ++detailGeneration;
    const observedState = sim.job_id === id ? sim.state : null;
    renderHistory();
    try { const data = normalizeJobDetail(await api(`/api/jobs/${encodeURIComponent(id)}`),id); if (!data.ok) throw new Error(data.error); if (token !== detailGeneration) return; detail = {...data,fetched_at:new Date().toISOString()}; detailObservedState = observedState; }
    catch(e) { if(token===detailGeneration) detailError=e.message; }
    finally { if(token===detailGeneration){detailBusy=false;renderHistory();} }
  }
  async function ensureJob(id, stopping = false) {
    const status = await api('/api/status'); acceptStatus(status);
    if (!sim.running || sim.job_id !== id) throw new Error('실행 작업이 변경되거나 종료돼 제어 요청을 취소했습니다. 현재 작업을 다시 확인하세요.');
    const rt = runtime();
    if (!rt.identityMatches || !(stopping ? rt.canStop : rt.controlsEnabled)) throw new Error('작업 번호 또는 실행 준비 상태를 확인할 수 없어 제어 요청을 보류했습니다.');
  }
  async function control(cmd, extra = {}, intendedId = sim.job_id) {
    if (operation || !isRunId(intendedId)) return;
    operation=cmd; gate.invalidate(); error=''; $('operation-error').textContent=''; render();
    try { await ensureJob(intendedId); await api('/api/control',{cmd,...extra}); acceptStatus(await api('/api/status')); }
    catch(e) { notify(e.message); $('operation-error').textContent=e.message; }
    finally {operation='';render();refresh();schedule();}
  }
  async function stop(id) {
    if(operation || !isRunId(id))return; operation='stop'; pendingCamera=null; gate.invalidate(); $('operation-error').textContent=''; render();
    try {await ensureJob(id,true);await api(`/api/jobs/${id}/stop`,{});notify('선택한 작업의 종료를 요청했습니다.');acceptStatus(await api('/api/status'));loadDetail(id);}
    catch(e){notify(e.message);$('operation-error').textContent=e.message;}
    finally{operation='';render();refresh();schedule();}
  }
  async function build() {
    if(operation || requestBusy || !online || !runtime().statusFresh || sim.running)return;
    const snapshot=normalizeLayout(structuredClone(getLayout())), check=getIsaacCompatibility(snapshot);
    if(check.errors.length)return;
    operation='build';gate.invalidate();$('operation-error').textContent='';render();
    let configuredId='';
    try {
      acceptStatus(await api('/api/status'));
      if(sim.running)throw new Error('서버에서 다른 작업이 시작돼 새 실행을 중단했습니다.');
      const job=await api('/api/factory',check.payload), response=validateIsaacResponse(check.payload,job);
      $('server-notes').replaceChildren(...response.warnings.map(m=>line('li',m)));
      if(response.errors.length)throw new Error(response.errors.join(' '));
      configuredId=job.job_id;
      storeReceipt(job.job_id,{layout:snapshot,payload:check.payload,configured:job,requested_at:new Date().toISOString(),last_state:'configured'});
      selectedJob=job.job_id;
      await api(`/api/jobs/${job.job_id}/start`,{});
      pendingCamera={job_id:job.job_id,camera:$('preferred-camera').value};
      storeReceipt(job.job_id,{last_state:'starting'});
      setMode('live');acceptStatus(await api('/api/status'));loadDetail(job.job_id);
      notify('확정한 배치로 실제 실행을 요청했습니다.');
    }catch(e){$('operation-error').textContent=`${e.message}${configuredId ? ` 구성된 작업: ${configuredId}. 상태를 확인한 뒤 다시 시도하세요.`:''}`;notify(e.message);}
    finally{operation='';render();refresh();schedule();}
  }
  function setMode(next) {
    mode=next;const recorded=mode==='recorded';
    for(const [id,active] of [['show-live',!recorded],['show-recorded',recorded]]){$(id).classList.toggle('selected',active);$(id).setAttribute('aria-pressed',String(active));}
    $('recorded-video').hidden=!recorded;
    if(recorded){disconnectStream();$('live-placeholder').hidden=true;$('stream-badge').textContent='기존 실행 자료';$('stream-badge').className='stream-badge recorded';$('live-source-note').textContent='2026.11.02 실제 Isaac 사전 실행 영상 · 현재 배치 및 실행과 별개';}
    else $('recorded-video').pause();
    render();
  }
  $('check-connection').addEventListener('click',()=>refresh(true));$('retry-live').addEventListener('click',()=>{streamRetryAt=0;disconnectStream();refresh(true);});
  $('show-live').addEventListener('click',()=>setMode('live'));$('show-recorded').addEventListener('click',()=>setMode('recorded'));
  $('sim-play').addEventListener('click',()=>control('play'));$('sim-pause').addEventListener('click',()=>control('pause'));
  $('sim-camera').addEventListener('change',()=>{pendingCamera=null;control('camera',{camera:$('sim-camera').value});});
  if ($('stream-rate')) {
    $('stream-rate').value = String(streamRate);
    $('stream-rate').addEventListener('change',()=>{
      streamRate=normalizeStreamRate($('stream-rate').value);$('stream-rate').value=String(streamRate);
      receivedFrames=[];receiveStartedAt=streamJob ? Date.now() : null;
      renderStream();
    });
  }
  $('build-and-run').addEventListener('click',build);
  $('sim-stop').addEventListener('click',()=>{if(!runtime().canStop)return;$('stop-job-id').textContent=sim.job_id;$('stop-dialog').dataset.job=sim.job_id;$('stop-dialog').showModal();});
  $('cancel-stop').addEventListener('click',()=>$('stop-dialog').close());
  $('confirm-stop').addEventListener('click',()=>{const id=$('stop-dialog').dataset.job;$('stop-dialog').close();stop(id);});
  $('job-history').addEventListener('change',()=>{if($('job-history').value)loadDetail($('job-history').value);else{detailGeneration++;selectedJob='';detail=null;detailBusy=false;detailError='';renderHistory();}});
  $('refresh-job').addEventListener('click',()=>loadDetail(selectedJob));
  $('restore-run-layout').addEventListener('click',()=>{const r=receipts[selectedJob];if(r){onLoadLayout(r.layout);notify('실행 당시 배치를 편집 초안으로 불러왔습니다. 실행 장면은 바뀌지 않습니다.');}});
  $('export-run').addEventListener('click',()=>{
    const data={schema_version:'robocell-run-evidence/v1',exported_at:new Date().toISOString(),job_id:selectedJob,
      source:'existing Isaac platform API + this browser request snapshot',validation:'not_provided',
      note:'서버 관측값이며 공정·안전 검증 통과를 의미하지 않습니다. 미수신 값은 추정하지 않습니다.',
      request_snapshot:receipts[selectedJob] || null,job_detail:detail?.job_id===selectedJob ? detail:null,
      current_observation:online && sim.job_id===selectedJob ? sim:null};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`RoboCell_실행근거_${selectedJob}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){gate.invalidate();clearTimeout(timer);disconnectStream();}else if(monitoring){render();refresh();}});
  window.addEventListener('online',()=>{if(monitoring)refresh(true);});
  setMode('live');
  return {
    getRunEvidence(){return structuredClone({schema_version:'robocell-run-evidence/v1',exported_at:new Date().toISOString(),job_id:selectedJob,source:'existing Isaac platform API + this browser request snapshot',validation:'not_provided',request_snapshot:receipts[selectedJob]||null,job_detail:detail?.job_id===selectedJob?detail:null,current_observation:online&&sim.job_id===selectedJob?sim:null});},
    showRecorded(){setMode('recorded');},
    showLive(){setMode('live');},
    setLayout(){renderCompatibility();},
    setVisible(value){
      visible=Boolean(value);monitoring=true;clearTimeout(timer);clearInterval(watchdog);
      if(!visible){disconnectStream();$('recorded-video').pause();}
      render();refresh(visible);schedule();
      watchdog=setInterval(()=>{if(!document.hidden)render();},1000);
    },
  };
}
