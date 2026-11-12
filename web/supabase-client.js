const SUPABASE_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
let clientPromise;

function getConfig() {
  const config = window.ROBOCELL_SUPABASE_CONFIG || {};
  const url = typeof config.url === 'string' ? config.url.trim() : '';
  const publishableKey = typeof config.publishableKey === 'string' ? config.publishableKey.trim() : '';

  if (!url || !publishableKey) {
    throw new Error('SUPABASE_NOT_CONFIGURED');
  }

  return { url, publishableKey };
}

export function isSupabaseConfigured() {
  try {
    getConfig();
    return true;
  } catch {
    return false;
  }
}

export async function getSupabaseClient() {
  if (!clientPromise) {
    const { url, publishableKey } = getConfig();
    clientPromise = import(SUPABASE_MODULE_URL).then(({ createClient }) => createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }));
  }

  return clientPromise;
}

export function getRedirectUrl(path) {
  return new URL(path, window.location.origin).toString();
}

export function getAuthErrorMessage(error, fallback) {
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';

  if (error?.message === 'SUPABASE_NOT_CONFIGURED') {
    return 'Supabase 연결 정보를 먼저 설정해 주세요.';
  }
  if (code === 'over_email_send_rate_limit' || message.includes('email rate limit')) {
    return '인증 이메일 발송 한도에 도달했습니다. 방금 받은 메일이 있다면 가장 최근 인증 링크만 열어 주세요. 한도가 풀린 뒤 다시 시도할 수 있습니다.';
  }
  if (message.includes('invalid login credentials')) {
    return '이메일 또는 비밀번호를 다시 확인해 주세요.';
  }
  if (message.includes('email not confirmed')) {
    return '이메일 인증을 완료한 뒤 로그인해 주세요.';
  }
  return fallback;
}
