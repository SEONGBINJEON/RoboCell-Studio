import { getAuthErrorMessage, getRedirectUrl, getSupabaseClient, isSupabaseConfigured } from './supabase-client.js';

const title = document.getElementById('workspace-title');
const lead = document.getElementById('workspace-lead');
const status = document.getElementById('workspace-status');
const signoutButton = document.getElementById('signout-button');

function setWorkspace(titleText, leadText, statusText, type = '') {
  title.textContent = titleText;
  lead.textContent = leadText;
  status.textContent = statusText;
  status.className = `auth-status${type ? ` is-${type}` : ''}`;
}

function getConfirmationCallback() {
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const error = query.get('error') || fragment.get('error');

  if (error) return 'failed';
  if (query.has('code') || query.get('type') === 'signup' || fragment.get('type') === 'signup') {
    return 'signup';
  }
  return null;
}

async function finishEmailConfirmation() {
  const callback = getConfirmationCallback();
  if (!callback) return false;

  if (callback === 'failed') {
    window.location.replace(getRedirectUrl('login.html?verification=failed'));
    return true;
  }

  try {
    const supabase = await getSupabaseClient();
    // Supabase consumes the callback token when the client is created. Clear that
    // temporary browser session so the user completes the normal Login step.
    await supabase.auth.getSession();
    await supabase.auth.signOut({ scope: 'local' });
    window.location.replace(getRedirectUrl('login.html?verified=1'));
  } catch {
    window.location.replace(getRedirectUrl('login.html?verification=failed'));
  }

  return true;
}

async function loadWorkspace() {
  if (await finishEmailConfirmation()) return;

  if (!isSupabaseConfigured()) {
    setWorkspace('연결 정보가 필요해요', 'Supabase 프로젝트 정보를 넣으면 로그인과 기업별 작업 공간을 확인할 수 있습니다.', '현재는 연결 설정 전 상태입니다.', 'error');
    return;
  }

  try {
    const supabase = await getSupabaseClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      window.location.replace('login.html');
      return;
    }

    const { data: profile } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
    const { data: memberships } = await supabase
      .from('company_memberships')
      .select('companies(name)')
      .eq('user_id', user.id)
      .limit(1);
    const companyName = memberships?.[0]?.companies?.name;
    const greeting = profile?.display_name || user.email;

    if (!companyName) {
      setWorkspace('이메일 인증을 확인해 주세요', `${greeting}님, 인증을 마친 뒤 다시 로그인하면 기업 작업 공간을 준비할 수 있습니다.`, '기업 소속 정보를 찾지 못했습니다. 관리자에게 문의해 주세요.', 'error');
      return;
    }
    setWorkspace(`${companyName} 작업 공간`, `${greeting}님, 기업별 공정 검토 공간에 로그인했습니다.`, '공정 조건 등록과 요청 상태 확인 기능을 다음 단계에서 연결합니다.', 'success');
  } catch (error) {
    setWorkspace('작업 공간을 준비 중이에요', '로그인은 확인했지만 기업 작업 공간 정보를 아직 불러오지 못했습니다.', getAuthErrorMessage(error, '데이터 구조를 적용한 뒤 다시 확인해 주세요.'), 'error');
  }
}

signoutButton.addEventListener('click', async () => {
  if (!isSupabaseConfigured()) {
    window.location.assign('login.html');
    return;
  }
  const supabase = await getSupabaseClient();
  await supabase.auth.signOut();
  window.location.assign('login.html');
});

loadWorkspace();
