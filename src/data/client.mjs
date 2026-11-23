// Inject an initialized @supabase/supabase-js client. No service-role key belongs here.
const messages = {
  AUTH_REQUIRED: '로그인이 필요합니다.', LOGIN_FAILED: '이메일과 비밀번호를 확인해 주세요.',
  PROFILE_INCOMPLETE: '프로필 입력을 완료해 주세요.', FORBIDDEN: '접근 권한이 없습니다.',
  NOT_FOUND: '사례를 찾을 수 없습니다.', INVALID_INPUT: '입력값을 확인해 주세요.',
  CONFLICT: '상태가 변경되었거나 이미 확정한 사례입니다. 다시 조회해 주세요.',
  NETWORK_ERROR: '연결을 확인하고 다시 시도해 주세요.', INTERNAL_ERROR: '처리 중 오류가 발생했습니다.',
};
const failure = code => ({ error: { code, message: messages[code] } });
function mapError(error, login = false) {
  if (error?.name === 'AuthRetryableFetchError' || error instanceof TypeError)
    return failure('NETWORK_ERROR');
  if (login && ['invalid_credentials', 'email_not_confirmed'].includes(error?.code))
    return failure('LOGIN_FAILED');
  if (error?.code === 'P0001' && Object.hasOwn(messages, error.message))
    return failure(error.message);
  if (error?.code === 'PGRST301' || error?.code === 'PGRST303' || error?.status === 401)
    return failure('AUTH_REQUIRED');
  // PostgREST can reject anonymous EXECUTE before the function runs.
  if (error?.code === '42501') return failure('FORBIDDEN');
  if (['22P02', '22023', '23514'].includes(error?.code)) return failure('INVALID_INPUT');
  return failure('INTERNAL_ERROR');
}
export function createBackendClient(supabase) {
  const run = async (fn, login = false) => {
    try { return await fn(); } catch (error) { return mapError(error, login); }
  };
  const rpc = async (name, args, convert) => {
    if (typeof supabase.auth?.getSession === 'function') {
      const session = await supabase.auth.getSession();
      if (session.error) return mapError(session.error);
      if (!session.data?.session) return failure('AUTH_REQUIRED');
    }
    const { data, error } = await supabase.rpc(name, args);
    if (error) return mapError(error);
    return { data: convert(data) };
  };
  const reportReceipt = data => ({ reportId: data.report_id, status: data.status,
    updatedAt: data.updated_at, ...(Object.hasOwn(data, 'finalized_at') ? { finalizedAt: data.finalized_at } : {}) });
  return {
    signUp: ({ email, password }) => run(async () => {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) return mapError(error);
      return { data: { user: data.user, session: data.session,
        requiresEmailConfirmation: !data.session } };
    }),
    signIn: ({ email, password }) => run(async () => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? mapError(error, true) : { data };
    }, true),
    signOut: () => run(async () => {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      return error ? mapError(error) : { data: { signedOut: true } };
    }),
    completeSignup: ({ role, nickname, realName = null, phone = null, terms } = {}) => run(async () => {
      // Terms persistence is not implemented; never pretend to have recorded acceptance.
      if (terms !== undefined) return failure('INVALID_INPUT');
      return rpc('complete_signup', { role, nickname, real_name: realName, phone }, data => data);
    }),
    getMyProfile: () => run(() => rpc('get_my_profile', {}, data => ({
      profile: data.profile, realName: data.real_name, phone: data.phone, firm: null,
    }))),
    saveReport: ({ reportId = null, rawText, fields } = {}) => run(() => rpc('save_report', {
      report_id: reportId, raw_text: rawText, fields,
    }, reportReceipt)),
    getReport: ({ reportId } = {}) => run(() => rpc('get_report', { report_id: reportId }, data => ({
      id: data.id, rawText: data.raw_text, status: data.status, fields: data.fields,
      updatedAt: data.updated_at, finalizedAt: data.finalized_at,
    }))),
    finalizeReport: ({ reportId } = {}) => run(() => rpc('finalize_report', { report_id: reportId }, reportReceipt)),
  };
}
