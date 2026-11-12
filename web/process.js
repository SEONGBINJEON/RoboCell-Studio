import { getAuthErrorMessage, getSupabaseClient, isSupabaseConfigured } from './supabase-client.js';

const form = document.getElementById('process-start-form');
const status = document.getElementById('process-status');
const processName = document.getElementById('process-name');
const targetInput = document.getElementById('process-target');
const hoursInput = document.getElementById('process-hours');
const submitButton = document.getElementById('process-submit');
const accountContext = document.getElementById('process-account-context');
const loginNote = document.getElementById('process-login-note');
const requestSection = document.getElementById('process-requests');
const requestList = document.getElementById('process-request-list');
const requestsStatus = document.getElementById('process-requests-status');
const refreshButton = document.getElementById('refresh-requests');
const studioButton = document.getElementById('process-open-studio');

const requestContext = { supabase: null, user: null, company: null };
const requestLabels = {
  submitted: '접수됨',
  needs_review: '조건 확인',
  queued: 'Isaac Sim 실행 대기',
  running: 'Isaac Sim 실행 중',
  review: '결과 검토 중',
  completed: '결과 준비 완료',
  failed: '실행 확인 필요'
};

const goalLabels = {
  waiting: '공정 사이의 대기시간',
  production: '시간당 생산량',
  energy: '제품당 에너지 사용량',
  automation: '로봇 자동화 도입 검토'
};

async function prepareProcessRegistration() {
  if (!isSupabaseConfigured()) {
    showGuestMode('저장소 연결 정보를 확인하는 중입니다. 현재는 기기에만 초안을 저장할 수 있습니다.');
    return;
  }

  try {
    const supabase = await getSupabaseClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      showGuestMode('Login하면 입력한 조건을 우리 기업의 분석 요청으로 저장하고 Isaac Sim 실행 대기 상태를 확인할 수 있습니다.');
      return;
    }

    const { data: memberships, error: membershipError } = await supabase
      .from('company_memberships')
      .select('company_id, role, companies(name)')
      .eq('user_id', user.id)
      .limit(1);
    if (membershipError) throw membershipError;

    const membership = memberships?.[0];
    if (!membership?.company_id) {
      showGuestMode('기업 소속 정보를 아직 찾지 못했습니다. Login을 다시 시도하거나 관리자에게 문의해 주세요.');
      return;
    }

    requestContext.supabase = supabase;
    requestContext.user = user;
    requestContext.company = {
      id: membership.company_id,
      name: membership.companies?.name || user.user_metadata?.company_name || '우리 기업'
    };
    showMemberMode();
    await loadRequests();
  } catch {
    showGuestMode('로그인 상태를 확인하지 못했습니다. 현재는 기기에만 초안을 저장할 수 있습니다.');
  }
}

function showGuestMode(message) {
  requestContext.supabase = null;
  requestContext.user = null;
  requestContext.company = null;
  accountContext.textContent = message;
  accountContext.classList.remove('is-ready');
  submitButton.innerHTML = '공정 초안 저장하기 <span aria-hidden="true">↓</span>';
  loginNote.hidden = false;
  requestSection.hidden = true;
}

function showMemberMode() {
  accountContext.textContent = `${requestContext.company.name}의 분석 요청으로 저장됩니다. 등록 뒤에는 Isaac Sim 실행 대기 상태를 여기에서 확인할 수 있습니다.`;
  accountContext.classList.add('is-ready');
  submitButton.innerHTML = '분석 요청 등록하기 <span aria-hidden="true">↗</span>';
  loginNote.hidden = true;
  requestSection.hidden = false;
}

prepareProcessRegistration();

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = `auth-status${type ? ` is-${type}` : ''}`;
}

function downloadDraft(data) {
  const file = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'robocell-process-draft.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function getProcessPayload() {
  const fields = new FormData(form);
  return {
    schemaVersion: 1,
    source: 'customer-entered',
    processName: String(fields.get('processName')).trim(),
    productName: String(fields.get('productName')).trim(),
    targetUnitsPerHour: Number(fields.get('target')),
    workHoursPerDay: Number(fields.get('hours')),
    improvementGoal: String(fields.get('goal')),
    improvementGoalLabel: goalLabels[String(fields.get('goal'))] || String(fields.get('goal')),
    description: String(fields.get('description')).trim()
  };
}

studioButton.addEventListener('click', () => {
  if (!processName.value.trim()) {
    setStatus('공정 이름을 입력해 주세요.', 'error');
    processName.focus();
    return;
  }
  if (!form.reportValidity()) {
    setStatus('목표 생산량과 하루 작업시간 등 입력한 조건을 확인해 주세요.', 'error');
    return;
  }
  try {
    localStorage.setItem('robocell-process-context', JSON.stringify(getProcessPayload()));
  } catch {
    setStatus('이 브라우저에 공정 초안을 저장하지 못했습니다. 브라우저 저장소 설정을 확인해 주세요. 입력한 내용은 그대로 남아 있습니다.', 'error');
    return;
  }
  window.location.assign('studio.html');
});

function formatRequestDate(value) {
  if (!value) return '방금 등록됨';
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function renderRequests(requests) {
  requestList.replaceChildren();
  if (!requests?.length) {
    const empty = document.createElement('li');
    empty.className = 'process-request-empty';
    empty.textContent = '아직 등록한 분석 요청이 없습니다. 공정 조건을 입력하고 첫 요청을 등록해 보세요.';
    requestList.append(empty);
    return;
  }

  for (const request of requests) {
    const job = Array.isArray(request.simulation_jobs) ? request.simulation_jobs[0] : request.simulation_jobs;
    const state = job?.status || request.status;
    const item = document.createElement('li');
    item.className = 'process-request-item';

    const copy = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'process-request-name';
    name.textContent = request.process_name;
    const meta = document.createElement('p');
    meta.className = 'process-request-meta';
    meta.textContent = `${request.target_units_per_hour}개/h · ${formatRequestDate(request.created_at)}`;
    copy.append(name, meta);

    const badge = document.createElement('span');
    badge.className = `process-request-state${state === 'queued' ? ' is-queued' : ''}${state === 'running' ? ' is-running' : ''}${state === 'failed' ? ' is-failed' : ''}`;
    badge.textContent = requestLabels[state] || '상태 확인 중';
    item.append(copy, badge);
    requestList.append(item);
  }
}

async function loadRequests() {
  if (!requestContext.supabase || !requestContext.company) return;
  requestsStatus.textContent = '등록한 요청을 불러오는 중입니다.';
  try {
    const { data, error } = await requestContext.supabase
      .from('process_requests')
      .select('id, process_name, target_units_per_hour, status, created_at, simulation_jobs(status, scenario_key)')
      .eq('company_id', requestContext.company.id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    renderRequests(data);
    requestsStatus.textContent = data?.length ? '최근 등록한 분석 요청입니다. 결과 수치는 Isaac Sim 실행 전까지 표시되지 않습니다.' : '아직 등록한 분석 요청이 없습니다.';
  } catch {
    requestList.replaceChildren();
    requestsStatus.textContent = '요청 목록을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.';
  }
}

async function submitProcessRequest(payload) {
  submitButton.disabled = true;
  submitButton.textContent = '분석 요청 등록 중…';
  try {
    const { error } = await requestContext.supabase
      .from('process_requests')
      .insert({
        company_id: requestContext.company.id,
        created_by: requestContext.user.id,
        process_name: payload.processName,
        product_name: payload.productName || null,
        target_units_per_hour: payload.targetUnitsPerHour,
        work_hours_per_day: payload.workHoursPerDay,
        improvement_goal: payload.improvementGoal,
        description: payload.description || null,
        input_snapshot: payload,
        status: 'submitted'
      });
    if (error) throw error;

    form.reset();
    setStatus('분석 요청을 등록했습니다. 지금은 Isaac Sim 실행 대기 상태이며, 실제 실행과 결과 등록은 개발팀이 별도 환경에서 진행합니다.', 'success');
    await loadRequests();
    processName.focus();
  } catch (error) {
    setStatus(getAuthErrorMessage(error, '분석 요청을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'), 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = '분석 요청 등록하기 <span aria-hidden="true">↗</span>';
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!processName.value.trim()) {
    setStatus('공정 이름을 입력해 주세요.', 'error');
    processName.focus();
    return;
  }
  if (!targetInput.validity.valid || !hoursInput.validity.valid) {
    setStatus('목표 생산량과 하루 작업시간을 확인해 주세요.', 'error');
    (!targetInput.validity.valid ? targetInput : hoursInput).focus();
    return;
  }

  const payload = getProcessPayload();
  if (requestContext.supabase && requestContext.user && requestContext.company) {
    await submitProcessRequest(payload);
    return;
  }

  downloadDraft({
    ...payload,
    status: 'local_process_draft',
    note: '로그인 전 RoboCell Studio 공정 설계 화면에서 만든 로컬 초안입니다. 분석 요청 접수와 Isaac Sim 실행은 아직 이루어지지 않았습니다.'
  });
  setStatus('공정 초안 파일을 준비했습니다. Login하면 기업별 분석 요청으로 저장할 수 있습니다.', 'success');
});

refreshButton.addEventListener('click', loadRequests);
processName.addEventListener('input', () => setStatus(requestContext.user ? '입력한 조건은 우리 기업의 분석 요청으로 저장됩니다.' : 'Login하면 기업별 분석 요청으로 저장할 수 있습니다.'));
