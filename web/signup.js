import { getAuthErrorMessage, getRedirectUrl, getSupabaseClient, isSupabaseConfigured } from './supabase-client.js';

const form = document.getElementById('signup-form');
const companyName = document.getElementById('company-name');
const contactName = document.getElementById('contact-name');
const email = document.getElementById('signup-email');
const password = document.getElementById('signup-password');
const passwordConfirm = document.getElementById('signup-password-confirm');
const status = document.getElementById('signup-status');
const passwordToggle = document.getElementById('signup-password-toggle');
const submitButton = form.querySelector('[type="submit"]');

const signupMessage = '이메일 인증 후 기업 담당자 작업 공간이 만들어집니다.';
const submitLabel = '기업 계정 생성 계속하기 <span aria-hidden="true">↗</span>';
let cooldownTimer;
let cooldownActive = false;

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = `auth-status${type ? ` is-${type}` : ''}`;
}

function restoreSubmitButton() {
  window.clearInterval(cooldownTimer);
  cooldownTimer = undefined;
  cooldownActive = false;
  submitButton.disabled = false;
  submitButton.innerHTML = submitLabel;
}

function startConfirmationCooldown(seconds = 60) {
  window.clearInterval(cooldownTimer);
  cooldownActive = true;
  let remaining = seconds;

  const updateButton = () => {
    if (remaining <= 0) {
      restoreSubmitButton();
      return;
    }
    submitButton.disabled = true;
    submitButton.textContent = `인증 메일 확인 중 · ${remaining}초`;
    remaining -= 1;
  };

  updateButton();
  cooldownTimer = window.setInterval(updateButton, 1000);
}

passwordToggle.addEventListener('click', () => {
  const visible = password.type === 'text';
  password.type = visible ? 'password' : 'text';
  passwordConfirm.type = visible ? 'password' : 'text';
  passwordToggle.textContent = visible ? '표시' : '숨기기';
  passwordToggle.setAttribute('aria-label', visible ? '비밀번호 표시' : '비밀번호 숨기기');
  passwordToggle.setAttribute('aria-pressed', String(!visible));
});

form.addEventListener('submit', event => {
  event.preventDefault();

  if (!companyName.value.trim()) {
    setStatus('기업명을 입력해 주세요.', 'error');
    companyName.focus();
    return;
  }
  if (!contactName.value.trim()) {
    setStatus('담당자 이름을 입력해 주세요.', 'error');
    contactName.focus();
    return;
  }
  if (!email.validity.valid) {
    setStatus('업무용 이메일 주소 형식을 확인해 주세요.', 'error');
    email.focus();
    return;
  }
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

  createAccount();
});

async function createAccount() {
  if (!isSupabaseConfigured()) {
    setStatus('Supabase 연결 정보를 설정하면 실제 기업 계정을 만들 수 있습니다.', 'error');
    return;
  }

  let confirmationEmailSent = false;
  submitButton.disabled = true;
  submitButton.textContent = '계정 생성 중…';

  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.auth.signUp({
      email: email.value.trim(),
      password: password.value,
      options: {
        // workspace.html is the already allow-listed, short-lived confirmation bridge.
        // It clears the confirmation session and sends the user to Login with a success notice.
        emailRedirectTo: getRedirectUrl('workspace.html'),
        data: {
          company_name: companyName.value.trim(),
          display_name: contactName.value.trim()
        }
      }
    });
    if (error) throw error;

    if (data.session) {
      window.location.assign(getRedirectUrl('process.html'));
      return;
    }
    confirmationEmailSent = true;
    setStatus('인증 이메일을 보냈습니다. 받은편지함에서 가장 최근 메일의 인증 링크를 열어 주세요. 다시 요청하면 이전 링크가 만료될 수 있습니다.', 'success');
    startConfirmationCooldown();
  } catch (error) {
    setStatus(getAuthErrorMessage(error, '기업 계정을 만들지 못했습니다. 입력 내용을 확인한 뒤 다시 시도해 주세요.'), 'error');
  } finally {
    if (!confirmationEmailSent) {
      restoreSubmitButton();
    }
  }
}

[companyName, contactName, email, password, passwordConfirm].forEach(input => {
  input.addEventListener('input', () => {
    if (!cooldownActive) {
      setStatus(signupMessage);
    }
  });
});
