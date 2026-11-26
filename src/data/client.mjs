// Only known API projection keys are transformed. AI fields and opaque payloads are preserved.
const projectionKeys = {"is_finalized":"isFinalized","group_id": "groupId", "harm_type": "harmType", "sub_status": "subStatus", "member_count": "memberCount", "period_start": "periodStart", "period_end": "periodEnd", "required_evidence": "requiredEvidence", "proposal_deadline": "proposalDeadline", "selected_firm_name": "selectedFirmName", "is_rep": "isRep", "joined_at": "joinedAt", "left_at": "leftAt", "firm_name": "firmName", "approval_status": "approvalStatus", "biz_status": "bizStatus", "biz_valid": "bizValid", "rep_name": "repName", "open_date": "openDate", "reject_reason": "rejectReason", "retainer_fee": "retainerFee", "success_fee_pct": "successFeePct", "lawyer_count": "lawyerCount", "lead_lawyer": "leadLawyer", "submitted_at": "submittedAt", "updated_at": "updatedAt", "created_at": "createdAt", "next_cursor": "nextCursor", "damage_level": "damageLevel", "secondary_yes_count": "secondaryYesCount", "secondary_known_count": "secondaryKnownCount", "secondary_unknown_count": "secondaryUnknownCount", "secondary_ratio": "secondaryRatio", "evidence_holder_count": "evidenceHolderCount", "evidence_ratio": "evidenceRatio", "as_of": "asOf", "poll_id": "pollId", "opens_at": "opensAt", "closes_at": "closesAt", "server_time": "serverTime", "total_votes": "totalVotes", "option_id": "optionId", "vote_count": "voteCount", "my_option_id": "myOptionId", "winner_option_id": "winnerOptionId", "applied_at": "appliedAt", "my_proposal_id": "myProposalId", "my_vote_count": "myVoteCount", "consent_id": "consentId", "granted_at": "grantedAt", "revoked_at": "revokedAt", "real_name": "realName", "requires_reconsent": "requiresReconsent", "notice_id": "noticeId", "read_at": "readAt", "notification_id": "notificationId", "firm_id": "firmId", "proposal_id": "proposalId", "method_code": "methodCode", "candidate_user_id": "candidateUserId"};
function projection(value) {
  if (Array.isArray(value)) return value.map(projection);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [projectionKeys[key] ?? key,
    ['fields','payload'].includes(key) ? item : projection(item)]));
}
// Inject an initialized @supabase/supabase-js client. No service-role key belongs here.
const messages = {
  INVALID_EMAIL: '이메일 주소를 확인해 주세요. 인증 메일을 받을 수 있는 주소가 필요합니다.',
  AUTH_RATE_LIMIT: '인증 요청 또는 인증 메일 전송 횟수가 제한됐습니다. 반복 요청을 멈추고 나중에 다시 시도해 주세요.',
  WEAK_PASSWORD: '비밀번호가 보안 조건을 충족하지 않습니다. 더 긴 비밀번호를 사용해 주세요.',
  ACCOUNT_EXISTS: '이미 등록된 계정입니다. 로그인해 주세요.',
  EMAIL_SIGNUP_DISABLED: '현재 이메일 가입이 비활성화되어 있습니다. 개발 프로젝트 설정을 확인해 주세요.',
  AUTH_REQUIRED: '로그인이 필요합니다.', LOGIN_FAILED: '이메일과 비밀번호를 확인해 주세요.',
  PROFILE_INCOMPLETE: '프로필 입력을 완료해 주세요.', FORBIDDEN: '접근 권한이 없습니다.',
  NOT_FOUND: '사례를 찾을 수 없습니다.', INVALID_INPUT: '입력값을 확인해 주세요.',
  CONFLICT: '상태가 변경되었습니다. 다시 조회해 주세요.',
  NOT_ELIGIBLE: '현재 참여 조건을 충족하지 않습니다.', FIRM_NOT_APPROVED: '로펌 승인 상태를 확인해 주세요.',
  POLL_NOT_OPEN: '아직 투표할 수 있는 시간이 아닙니다.', POLL_CLOSED: '투표가 마감되었습니다.',
  PROPOSAL_CLOSED: '제안 접수 기간이 아닙니다.',
  NETWORK_ERROR: '연결을 확인하고 다시 시도해 주세요.', INTERNAL_ERROR: '처리 중 오류가 발생했습니다.',
};
const failure = code => ({ error: { code, message: messages[code] } });
function mapError(error, login = false) {
  if (['email_address_invalid', 'email_address_not_authorized'].includes(error?.code)) return failure('INVALID_EMAIL');
  if (['over_email_send_rate_limit', 'over_request_rate_limit'].includes(error?.code) || error?.status === 429) return failure('AUTH_RATE_LIMIT');
  if (error?.code === 'weak_password') return failure('WEAK_PASSWORD');
  if (['user_already_exists', 'email_exists'].includes(error?.code)) return failure('ACCOUNT_EXISTS');
  if (error?.code === 'signup_disabled') return failure('EMAIL_SIGNUP_DISABLED');
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
  const rpc = async (name, args, convert, allowAnonymous = false) => {
    if (!allowAnonymous && typeof supabase.auth?.getSession === 'function') {
      const session = await supabase.auth.getSession();
      if (session.error) return mapError(session.error);
      if (!session.data?.session) return failure('AUTH_REQUIRED');
    }
    const { data, error } = await supabase.rpc(name, args);
    if (error) return mapError(error);
    return { data: convert(data) };
  };
  // Edge Function call with the same {data}/{error} normalization. The SDK attaches the user's access token.
  const invoke = async (name, body) => {
    if (typeof supabase.auth?.getSession === 'function') {
      const session = await supabase.auth.getSession();
      if (session.error) return mapError(session.error);
      if (!session.data?.session) return failure('AUTH_REQUIRED');
    }
    const { data, error } = await supabase.functions.invoke(name, { body });
    if (error) {
      if (error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError') return failure('NETWORK_ERROR');
      let code;
      try { code = (await error.context?.json?.())?.error?.code; } catch { code = undefined; }
      if (Object.hasOwn(messages, code)) return failure(code);
      return failure(error.context?.status === 401 ? 'AUTH_REQUIRED' : 'INTERNAL_ERROR');
    }
    if (data?.error) return failure(Object.hasOwn(messages, data.error.code) ? data.error.code : 'INTERNAL_ERROR');
    return { data: data?.data };
  };
  const evidenceView = data => ({ evidenceId: data.evidence_id, reportId: data.report_id, kind: data.kind,
    bucketId: data.bucket_id, objectPath: data.object_path, originalName: data.original_name, mimeType: data.mime_type,
    sizeBytes: data.size_bytes, status: data.status, createdAt: data.created_at, uploadedAt: data.uploaded_at });
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
    getMyProfile: () => run(async () => {
      const result = await rpc('get_my_profile', {}, data => ({profile: data.profile, realName: data.real_name, phone: data.phone, firm: null}));
      if (result.error || result.data.profile.role !== 'firm') return result;
      const firm = await rpc('get_my_firm', {}, projection);
      return firm.error ? firm : {data: {...result.data, firm: firm.data}};
    }),
    saveReport: ({ reportId = null, rawText, fields } = {}) => run(() => rpc('save_report', {
      report_id: reportId, raw_text: rawText, fields,
    }, reportReceipt)),
    getReport: ({ reportId } = {}) => run(() => rpc('get_report', { report_id: reportId }, data => ({
      id: data.id, rawText: data.raw_text, status: data.status, fields: data.fields,
      updatedAt: data.updated_at, finalizedAt: data.finalized_at,
    }))),
    finalizeReport: ({ reportId } = {}) => run(() => rpc('finalize_report', { report_id: reportId }, reportReceipt)),
    createGroup: (input = {}) => run(() => rpc('create_group', {report_id: input.reportId ?? null, name: input.name ?? null, company: input.company ?? null, description: input.description ?? null, conditions: input.conditions ?? "", harm_type: input.harmType ?? "privacy_leak", period_start: input.periodStart ?? null, period_end: input.periodEnd ?? null, required_evidence: input.requiredEvidence ?? [], goal: input.goal ?? null, deadline: input.deadline ?? null}, projection, false)),
    joinGroup: (input = {}) => run(() => rpc('join_group', {group_id: input.groupId ?? null, report_id: input.reportId ?? null}, projection, false)),
    leaveGroup: (input = {}) => run(() => rpc('leave_group', {group_id: input.groupId ?? null}, projection, false)),
    getMyMembership: (input = {}) => run(() => rpc('get_my_membership', {group_id: input.groupId ?? null}, projection, false)),
    getGroup: (input = {}) => run(() => rpc('get_group', {group_id: input.groupId ?? null}, projection, true)),
    listGroups: (input = {}) => run(() => rpc('list_groups', {company: input.company ?? null, harm_type: input.harmType ?? null, status: input.status ?? null, cursor: input.cursor ?? null, limit: input.limit ?? 20}, projection, true)),
    getGroupMembers: (input = {}) => run(() => rpc('get_group_members', {group_id: input.groupId ?? null, cursor: input.cursor ?? null, limit: input.limit ?? 20}, projection, false)),
    // openDate is 'YYYY-MM-DD'. lawyers is optional (0~20); the lead lawyer is entered per proposal.
    createFirmApplication: (input = {}) => run(() => rpc('create_firm_application', {firm_name: input.firmName ?? null, biz_no: input.bizNo ?? null, cert_path: input.certPath ?? null, rep_name: input.repName ?? null, open_date: input.openDate ?? null, lawyers: input.lawyers ?? []}, projection, false)),
    getMyFirm: (input = {}) => run(() => rpc('get_my_firm', {}, projection, false)),
    submitProposal: (input = {}) => run(() => rpc('submit_proposal', {group_id: input.groupId ?? null, proposal: input.proposal ?? null}, projection, false)),
    updateProposal: (input = {}) => run(() => rpc('update_proposal', {proposal_id: input.proposalId ?? null, proposal: input.proposal ?? null}, projection, false)),
    withdrawProposal: (input = {}) => run(() => rpc('withdraw_proposal', {proposal_id: input.proposalId ?? null}, projection, false)),
    listProposals: (input = {}) => run(() => rpc('list_proposals', {group_id: input.groupId ?? null, cursor: input.cursor ?? null, limit: input.limit ?? 20}, projection, false)),
    getGroupStats: (input = {}) => run(() => rpc('get_group_stats', {group_id: input.groupId ?? null}, projection, false)),
    openPoll: (input = {}) => run(() => rpc('open_poll', {group_id: input.groupId ?? null, kind: input.kind ?? null, opens_at: input.opensAt ?? null, closes_at: input.closesAt ?? null}, projection, false)),
    applyRepresentative: (input = {}) => run(() => rpc('apply_representative', {poll_id: input.pollId ?? null}, projection, false)),
    castRepresentativeVote: (input = {}) => run(() => rpc('cast_representative_vote', {poll_id: input.pollId ?? null, option_id: input.optionId ?? null}, projection, false)),
    castMethodVote: (input = {}) => run(() => rpc('cast_method_vote', {poll_id: input.pollId ?? null, choice: input.choice ?? null}, projection, false)),
    castFirmVote: (input = {}) => run(() => rpc('cast_firm_vote', {poll_id: input.pollId ?? null, proposal_id: input.proposalId ?? null}, projection, false)),
    getVoteSummary: (input = {}) => run(() => rpc('get_vote_summary', {poll_id: input.pollId ?? null}, projection, false)),
    getMyProposalVoteSummary: (input = {}) => run(() => rpc('get_my_proposal_vote_summary', {poll_id: input.pollId ?? null}, projection, false)),
    setProposalDeadline: (input = {}) => run(() => rpc('set_proposal_deadline', {group_id: input.groupId ?? null, deadline: input.deadline ?? null}, projection, false)),
    grantContactConsent: (input = {}) => run(() => rpc('grant_contact_consent', {group_id: input.groupId ?? null, selected_proposal_id: input.selectedProposalId ?? null, consent_version: input.consentVersion ?? null}, projection, false)),
    revokeContactConsent: (input = {}) => run(() => rpc('revoke_contact_consent', {group_id: input.groupId ?? null}, projection, false)),
    getSelectedContacts: (input = {}) => run(() => rpc('get_selected_contacts', {group_id: input.groupId ?? null, cursor: input.cursor ?? null, limit: input.limit ?? 20}, projection, false)),
    updatePrivateProfile: (input = {}) => run(() => rpc('update_private_profile', {real_name: input.realName ?? null, phone: input.phone ?? null}, projection, false)),
    createNotice: (input = {}) => run(() => rpc('create_notice', {group_id: input.groupId ?? null, title: input.title ?? null, body: input.body ?? null}, projection, false)),
    listNotices: (input = {}) => run(() => rpc('list_notices', {group_id: input.groupId ?? null, cursor: input.cursor ?? null, limit: input.limit ?? 20}, projection, false)),
    listGroupEvents: (input = {}) => run(() => rpc('list_group_events', {group_id: input.groupId ?? null, cursor: input.cursor ?? null, limit: input.limit ?? 20}, projection, false)),
    listNotifications: (input = {}) => run(() => rpc('list_notifications', {cursor: input.cursor ?? null, limit: input.limit ?? 20}, projection, false)),
    markNotificationRead: (input = {}) => run(() => rpc('mark_notification_read', {notification_id: input.notificationId ?? null}, projection, false)),
    // Evidence upload: 1) createEvidenceUpload → 2) storage upload to objectPath (upsert:false) → 3) confirmEvidence.
    createEvidenceUpload: (input = {}) => run(() => rpc('create_evidence_upload', {report_id: input.reportId ?? null, kind: input.kind ?? null, original_name: input.originalName ?? null, mime_type: input.mimeType ?? null, size_bytes: input.sizeBytes ?? null}, evidenceView, false)),
    confirmEvidence: (input = {}) => run(() => invoke('evidence-confirm', {evidenceId: input.evidenceId ?? null})),
    // Row first, then the object. objectRemoved=false means the file is orphaned; retry remove(objectPath) later.
    deleteEvidence: (input = {}) => run(async () => {
      const result = await rpc('delete_evidence', {evidence_id: input.evidenceId ?? null}, data => data, false);
      if (result.error) return result;
      const {evidence_id: evidenceId, bucket_id: bucketId, object_path: objectPath, deleted_at: deletedAt} = result.data;
      let objectRemoved = false;
      try { objectRemoved = !(await supabase.storage.from(bucketId).remove([objectPath])).error; } catch { objectRemoved = false; }
      return {data: {evidenceId, deletedAt, objectPath, objectRemoved}};
    }),
    // biz_no is read from the DB by the server; firmId/bizNo are optional consistency checks only.
    verifyBusiness: (input = {}) => run(() => invoke('nts-verify', {...(input.firmId === undefined ? {} : {firmId: input.firmId}), ...(input.bizNo === undefined ? {} : {bizNo: input.bizNo})})),
  };
}
