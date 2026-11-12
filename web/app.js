// All numbers are presentation fixtures, not simulation results.
import { getSupabaseClient, isSupabaseConfigured } from './supabase-client.js';

async function updateAccountLinks() {
  const accountLinks = [...document.querySelectorAll('[data-account-link]')];
  if (!accountLinks.length || !isSupabaseConfigured()) return;

  try {
    const supabase = await getSupabaseClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return;

    const { data: memberships } = await supabase
      .from('company_memberships')
      .select('companies(name)')
      .eq('user_id', user.id)
      .limit(1);
    const companyName = memberships?.[0]?.companies?.name || user.user_metadata?.company_name || user.email;
    if (!companyName) return;

    accountLinks.forEach(link => {
      link.textContent = companyName;
      link.href = 'process.html';
      link.classList.add('is-signed-in');
      link.setAttribute('aria-label', `${companyName} 공정 조건 등록`);
    });
  } catch {
    // Keep the public Login link available if the session or company profile cannot be read.
  }
}

updateAccountLinks();

const siteHeader = document.querySelector('.site-header');
function updateHeaderSurface() {
  siteHeader?.classList.toggle('is-scrolled', window.scrollY > 24);
}
updateHeaderSurface();
window.addEventListener('scroll', updateHeaderSurface, { passive: true });

const scenarios = {
  baseline: { name: '기준안', output: 90, cycle: 40, wait: 20, energy: 30, focus: '현재 작업 순서와 이송 흐름을 비교 기준으로 설정', outcome: '현재 조건을 비교 기준으로 설정', title: '변화의 출발점, 현재 공정을 확인합니다.', description: '기준안은 다른 시나리오를 비교하는 출발점입니다. 이 화면에서는 후공정 앞의 대기시간을 살펴보는 상황을 예시로 제시합니다.', safety: { collision: '현재 로봇 동선과 지그의 간섭 구간을 확인', clearance: '작업자·설비 최소 이격거리 기준을 입력', limits: '기존 운전 속도와 관절 범위를 점검' } },
  speed: { name: '개선안 A · 속도 조정', output: 100, cycle: 36, wait: 16, energy: 31, focus: '로봇의 이송 속도를 높여 흐름을 빠르게 조정', outcome: '생산량 11.1% 증가 · 에너지 3.3% 증가', title: '빨라진 이송, 에너지도 함께 살펴보세요.', description: '이 예시에서는 이송 속도를 높이면 생산량이 늘지만 제품당 추정 에너지도 증가합니다. 생산량과 에너지 지표를 함께 비교하는 화면입니다.', safety: { collision: '속도 상향 시 교차 구간의 간섭을 다시 확인', clearance: '정지거리 변화를 고려해 최소 이격거리 재검토', limits: '속도·가속도 제한값을 시뮬레이션에 반영' } },
  timing: { name: '개선안 B · 주기 조정', output: 108, cycle: 33.3, wait: 8, energy: 24, focus: '후공정 준비 시점에 맞춰 이송 주기를 정렬', outcome: '대기시간 60% 감소 · 생산량 20% 증가', title: '속도보다, 이송 타이밍에 주목하세요.', description: '이 예시에서는 후공정의 준비 상태에 맞춘 이송이 대기시간을 줄였습니다. 실제 효과는 기업별 조건을 반영한 시뮬레이션으로 확인합니다.', safety: { collision: '이송 순서 변경에 따른 동시 접근 구간을 점검', clearance: '대기 위치와 설비 사이 최소 이격거리 확인', limits: '작업 순서와 관절 제한 조건을 함께 검토' } }
};
let currentScenario = 'timing';
const units = { output: '개/h', cycle: '초/개', wait: '초', energy: 'Wh/개' };
function selectScenario(key) {
  const selected = scenarios[key];
  if (!selected) return;
  currentScenario = key;
  document.querySelectorAll('[data-scenario]').forEach(button => {
    const active = button.dataset.scenario === key;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  for (const metric of Object.keys(units)) {
    const value = document.getElementById(`metric-${metric}`);
    value.replaceChildren(document.createTextNode(String(selected[metric])));
    const unit = document.createElement('small');
    unit.textContent = units[metric];
    value.append(unit);
    const delta = (selected[metric] / scenarios.baseline[metric] - 1) * 100;
    const deltaText = key === 'baseline' ? '비교의 기준이 되는 값' : `기준안 대비 ${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}%${metric === 'energy' && delta > 0 ? ' · 증가' : ''}`;
    document.getElementById(`delta-${metric}`).textContent = deltaText;
    document.querySelector(`[data-metric="${metric}"]`)?.classList.toggle('is-caution', metric === 'energy' && delta > 0);
    document.getElementById(`compare-${metric}`).textContent = String(selected[metric]);
    const compareDelta = document.getElementById(`compare-delta-${metric}`);
    compareDelta.textContent = key === 'baseline' ? '기준' : `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}%`;
    compareDelta.classList.toggle('is-caution', metric === 'energy' && delta > 0);
  }
  document.getElementById('selected-scenario-name').textContent = selected.name;
  document.getElementById('selected-scenario-focus').textContent = selected.focus;
  document.getElementById('selected-scenario-outcome').textContent = selected.outcome;
  document.getElementById('safety-collision').textContent = selected.safety.collision;
  document.getElementById('safety-clearance').textContent = selected.safety.clearance;
  document.getElementById('safety-limits').textContent = selected.safety.limits;
  document.getElementById('analysis-title').textContent = selected.title;
  document.getElementById('analysis-copy').textContent = selected.description;
  document.querySelectorAll('[data-compare]').forEach(row => row.classList.toggle('active', key !== 'baseline'));
}
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => selectScenario(button.dataset.scenario)));

const solutions = {
  transfer: {
    en: '이송 시뮬레이션', title: ['이송의 흐름을 바꾸면,', '공정의 가능성이 보입니다.'], description: '작업대 사이를 오가는 로봇의 속도와 이송 주기를 조정해 보세요. 다음 공정의 준비 상태까지 고려해 불필요한 대기를 찾아봅니다.', tags: ['이동 속도', '이송 주기', '작업 순서'], note: '작업대 A → 로봇 이송 → 작업대 B → 검사',
    visual: { label: '로봇 이송 시뮬레이션', step: 'CONCEPT / 01', src: 'assets/sim-transfer-cell-v1.png', alt: '작업대 사이에서 금속 부품을 이송하는 협동 로봇 3D 공정 개념 이미지', caption: '설명용 3D 공정 개념 이미지 · 실제 Isaac Sim 실행 결과가 아닙니다.' }
  },
  bottleneck: {
    en: '병목 분석', title: ['어디서 멈추는지 알면,', '다음 변화가 보입니다.'], description: '로봇이 빠르게 움직여도 검사 앞에 부품이 쌓일 수 있습니다. 작업·이동·대기 기록을 함께 보며 공정 전체의 흐름을 제한하는 구간을 찾습니다.', tags: ['대기시간', '후공정 적체', '처리시간'], note: '공정별 처리시간과 대기열을 함께 비교합니다.',
    visual: { label: '병목 분석 시뮬레이션', step: 'CONCEPT / 02', src: 'assets/sim-bottleneck-cell-v1.png', alt: '검사 장비 앞 컨베이어에 부품이 대기하는 협동 로봇 3D 공정 개념 이미지', caption: '설명용 3D 병목 분석 개념 이미지 · 실제 Isaac Sim 실행 결과가 아닙니다.' }
  },
  energy: {
    en: '에너지 관찰', title: ['하나를 만들 때 쓰는 에너지,', '시간과 함께 읽습니다.'], description: '설비의 작업·이동·대기 상태와 소비전력을 바탕으로 에너지를 추정합니다. 생산량이 바뀔 때 제품당 에너지는 어떻게 달라지는지 함께 확인합니다.', tags: ['상태별 소비전력', '가동시간', '추정값 구분'], note: '소비전력 × 상태 지속시간 → 추정 에너지',
    visual: { label: '에너지 상태 시뮬레이션', step: 'CONCEPT / 03', src: 'assets/sim-energy-cell-v1.png', alt: '로봇과 컨베이어, 설비 상태를 보여 주는 에너지 관찰용 3D 공정 개념 이미지', caption: '설명용 3D 에너지 상태 개념 이미지 · 실제 Isaac Sim 실행 결과가 아닙니다.' }
  },
  safety: {
    en: '안전 검토', title: ['움직이기 전에,', '충돌 조건부터 검토합니다.'], description: '로봇의 작업공간과 설비·지그 사이의 간섭을 가상 환경에서 살펴봅니다. 현장 기준을 반영해 최소 이격거리와 속도·관절 제한을 확인할 항목으로 정리합니다.', tags: ['충돌·간섭', '최소 이격거리', '속도·관절 제한'], note: '로봇 동선 · 설비 이격거리 · 속도·관절 제한',
    visual: { label: '로봇 셀 안전 검토', step: 'CONCEPT / 04', src: 'assets/sim-safety-cell-v1.png', alt: '로봇 작업공간과 안전 경계, 설비 간 간섭 구간을 보여 주는 3D 공정 안전 검토 개념 이미지', caption: '설명용 3D 안전 검토 개념 이미지 · 실제 안전성 검증 또는 Isaac Sim 실행 결과가 아닙니다.' }
  }
};
const solutionTabs = [...document.querySelectorAll('[data-solution]')];
function selectSolution(key) {
  const selected = solutions[key];
  solutionTabs.forEach(tab => {
    const active = tab.dataset.solution === key;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.getElementById('solution-panel').setAttribute('aria-labelledby', `tab-${key}`);
  document.getElementById('solution-en').textContent = selected.en;
  document.getElementById('solution-title').replaceChildren(document.createTextNode(selected.title[0]), document.createElement('br'), document.createTextNode(selected.title[1]));
  document.getElementById('solution-description').textContent = selected.description;
  document.getElementById('solution-tags').replaceChildren(...selected.tags.map(text => { const tag = document.createElement('span'); tag.textContent = text; return tag; }));
  document.getElementById('diagram-note').textContent = selected.note;
  document.getElementById('simulation-visual-panel').setAttribute('aria-label', selected.visual.alt);
  document.getElementById('simulation-label').textContent = selected.visual.label;
  document.getElementById('simulation-step').textContent = selected.visual.step;
  document.getElementById('solution-visual').src = selected.visual.src;
  document.getElementById('solution-visual').alt = selected.visual.alt;
  document.getElementById('simulation-caption').textContent = selected.visual.caption;
}
solutionTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectSolution(tab.dataset.solution));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % solutionTabs.length;
    if (event.key === 'ArrowLeft') next = (index + solutionTabs.length - 1) % solutionTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = solutionTabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectSolution(solutionTabs[next].dataset.solution);
    solutionTabs[next].focus();
  });
});

const menuToggle = document.querySelector('.menu-toggle');
const mobileNav = document.getElementById('mobile-nav');
function closeMenu() { mobileNav.hidden = true; menuToggle.setAttribute('aria-expanded', 'false'); menuToggle.setAttribute('aria-label', '메뉴 열기'); }
menuToggle.addEventListener('click', () => {
  const open = mobileNav.hidden;
  mobileNav.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
});
mobileNav.querySelectorAll('a,button').forEach(item => item.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !mobileNav.hidden) { closeMenu(); menuToggle.focus(); } });
window.matchMedia('(min-width: 981px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

let dialogOpener;
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => {
  dialogOpener = button;
  if (button.dataset.open === 'report-dialog') document.getElementById('report-interpretation').textContent = `${scenarios[currentScenario].name}: ${scenarios[currentScenario].description}`;
  const dialog = document.getElementById(button.dataset.open);
  dialog.showModal();
  document.body.classList.add('dialog-open');
}));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelector('.close-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => { document.body.classList.remove('dialog-open'); dialogOpener?.focus(); });
});
function downloadFile(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
document.getElementById('process-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const nameInput = form.elements.namedItem('processName');
  if (!nameInput.value.trim()) { nameInput.setCustomValidity('공정 이름을 입력해 주세요.'); nameInput.reportValidity(); return; }
  nameInput.setCustomValidity('');
  const fields = new FormData(form);
  const data = { schemaVersion: 1, status: 'local_design_draft', processName: String(fields.get('processName')).trim(), targetUnitsPerHour: Number(fields.get('target')), workHoursPerDay: Number(fields.get('hours')), improvementGoal: fields.get('goal'), description: String(fields.get('description')).trim(), note: '디자인 시안에서 작성한 로컬 초안입니다. 분석 요청이 접수되거나 시뮬레이션이 실행된 것이 아닙니다.' };
  downloadFile('robocell-process-draft.json', JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  document.getElementById('form-status').textContent = '초안 파일 다운로드를 요청했습니다. 분석 요청은 아직 접수되지 않았습니다.';
});
document.querySelector('[name="processName"]').addEventListener('input', event => event.target.setCustomValidity(''));
document.getElementById('download-report').addEventListener('click', () => {
  const selected = scenarios[currentScenario];
  const content = `RoboCell Studio — 디자인 시연용 보고서\n\n실제 시뮬레이션 및 AI 분석 결과가 아닙니다. 모든 수치는 화면 설명용 가정값입니다. 안전 검토 항목은 현장 위험성 평가나 안전 인증을 대신하지 않습니다.\n\n선택: ${selected.name}\n시간당 생산량: ${selected.output} 개/h\n평균 사이클타임: ${selected.cycle} 초/개\n제품당 대기시간: ${selected.wait} 초\n제품당 추정 에너지: ${selected.energy} Wh/개\n\n예시 해석\n${selected.description}\n\n안전 검토 항목\n- 충돌·간섭 구간: ${selected.safety.collision}\n- 최소 이격거리: ${selected.safety.clearance}\n- 속도·관절 제한: ${selected.safety.limits}\n\n현장 확인 사항\n- 검사공정 처리시간 및 대기 공간\n- 보호장치, 비상정지, 작업자 접근 조건\n- 상태별 소비전력 실측값\n`;
  downloadFile('robocell-example-report.txt', content, 'text/plain;charset=utf-8');
});
selectScenario(currentScenario);
