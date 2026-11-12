import { getAuthErrorMessage, getRedirectUrl, getSupabaseClient, isSupabaseConfigured } from './supabase-client.js';

const form = document.getElementById('login-form');
const email = document.getElementById('login-email');
const password = document.getElementById('login-password');
const status = document.getElementById('login-status');
const passwordToggle = document.getElementById('password-toggle');

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = `auth-status${type ? ` is-${type}` : ''}`;
}

function showEmailVerificationNotice() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('verified') === '1') {
    setStatus('이메일 인증이 완료되었습니다. 등록한 이메일과 비밀번호로 Login해 주세요.', 'success');
    window.history.replaceState({}, document.title, getRedirectUrl('login.html'));
    return;
  }

  if (params.get('verification') === 'failed') {
    setStatus('이메일 인증 링크를 확인하지 못했습니다. 이메일에서 가장 최근 링크를 다시 열어 주세요.', 'error');
    window.history.replaceState({}, document.title, getRedirectUrl('login.html'));
  }
}

showEmailVerificationNotice();

passwordToggle.addEventListener('click', () => {
  const visible = password.type === 'text';
  password.type = visible ? 'password' : 'text';
  passwordToggle.textContent = visible ? '표시' : '숨기기';
  passwordToggle.setAttribute('aria-label', visible ? '비밀번호 표시' : '비밀번호 숨기기');
  passwordToggle.setAttribute('aria-pressed', String(!visible));
});

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!email.validity.valid) {
    setStatus('이메일 주소 형식을 확인해 주세요.', 'error');
    email.focus();
    return;
  }
  if (!password.validity.valid) {
    setStatus('비밀번호는 8자 이상 입력해 주세요.', 'error');
    password.focus();
    return;
  }
  signIn();
});

async function signIn() {
  if (!isSupabaseConfigured()) {
    setStatus('Supabase 연결 정보를 설정하면 실제 로그인할 수 있습니다.', 'error');
    return;
  }

  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Login 확인 중…';

  try {
    const supabase = await getSupabaseClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
    if (error) throw error;
    window.location.assign(getRedirectUrl('process.html'));
  } catch (error) {
    setStatus(getAuthErrorMessage(error, '로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.'), 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Login <span aria-hidden="true">↗</span>';
  }
}

document.getElementById('forgot-password').addEventListener('click', async () => {
  if (!email.validity.valid) {
    setStatus('비밀번호 재설정 링크를 받을 이메일 주소를 먼저 입력해 주세요.', 'error');
    email.focus();
    return;
  }
  if (!isSupabaseConfigured()) {
    setStatus('Supabase 연결 정보를 설정하면 비밀번호 재설정 이메일을 보낼 수 있습니다.', 'error');
    return;
  }

  try {
    const supabase = await getSupabaseClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: getRedirectUrl('reset-password.html') });
    if (error) throw error;
    setStatus('등록 여부와 관계없이, 가능한 경우 재설정 안내를 이메일로 보냈습니다.', 'success');
  } catch (error) {
    setStatus(getAuthErrorMessage(error, '비밀번호 재설정 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'), 'error');
  }
});

email.addEventListener('input', () => setStatus('업무용 이메일과 비밀번호로 로그인합니다.'));
password.addEventListener('input', () => setStatus('업무용 이메일과 비밀번호로 로그인합니다.'));
