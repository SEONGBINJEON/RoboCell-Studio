import { getAuthErrorMessage, getRedirectUrl, getSupabaseClient, isSupabaseConfigured } from './supabase-client.js';

const form = document.getElementById('reset-password-form');
const password = document.getElementById('new-password');
const passwordConfirm = document.getElementById('new-password-confirm');
const status = document.getElementById('reset-status');
const passwordToggle = document.getElementById('reset-password-toggle');

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = `auth-status${type ? ` is-${type}` : ''}`;
}

passwordToggle.addEventListener('click', () => {
  const visible = password.type === 'text';
  password.type = visible ? 'password' : 'text';
  passwordConfirm.type = visible ? 'password' : 'text';
  passwordToggle.textContent = visible ? '표시' : '숨기기';
  passwordToggle.setAttribute('aria-label', visible ? '비밀번호 표시' : '비밀번호 숨기기');
  passwordToggle.setAttribute('aria-pressed', String(!visible));
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!password.validity.valid) {
    setStatus('비밀번호는 8자 이상 입력해 주세요.', 'error');
    password.focus();
    return;
  }
  if (password.value !== passwordConfirm.value) {
    setStatus('비밀번호가 서로 일치하지 않습니다.', 'error');
    passwordConfirm.focus();
    return;
  }
  if (!isSupabaseConfigured()) {
    setStatus('Supabase 연결 정보를 먼저 설정해 주세요.', 'error');
    return;
  }

  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = '변경 중…';
  try {
    const supabase = await getSupabaseClient();
    const { error } = await supabase.auth.updateUser({ password: password.value });
    if (error) throw error;
    setStatus('새 비밀번호로 변경했습니다. 작업 공간으로 이동합니다.', 'success');
    window.location.assign(getRedirectUrl('workspace.html'));
  } catch (error) {
    setStatus(getAuthErrorMessage(error, '비밀번호를 변경하지 못했습니다. 재설정 이메일의 링크를 다시 열어 주세요.'), 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = '비밀번호 변경하기 <span aria-hidden="true">↗</span>';
  }
});
