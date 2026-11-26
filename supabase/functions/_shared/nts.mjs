import { fail, UUID } from './http.mjs';

export const NTS_STATUS_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/status';
export const NTS_VALIDATE_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/validate';
const codes = { '01': 'active', '02': 'suspended', '03': 'closed' };
const validCodes = { '01': 'valid', '02': 'invalid' };
// Valid NTS answer: 01/02/03 are mapped; anything else (e.g. unregistered number, empty code) is unknown.
export const mapNtsStatus = code => codes[code] ?? 'unknown';
// 진위확인: 01 일치 → valid, 02 불일치 → invalid, 그 밖의 유효 응답 → unknown.
export const mapNtsValid = code => validCodes[code] ?? 'unknown';

// One NTS POST. Returns the entry for bNo, or null on any failure (network, timeout, HTTP, JSON, missing entry).
async function ntsCall(fetchImpl, url, serviceKey, body, bNo, timeoutMs) {
  try {
    const res = await fetchImpl(`${url}?serviceKey=${encodeURIComponent(serviceKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    if (payload?.status_code !== 'OK' || !Array.isArray(payload.data)) return null;
    return payload.data.find(item => item?.b_no === bNo) ?? null;
  } catch {
    return null; // do not keep the error: it may contain the request URL with the key
  }
}

/**
 * Trust boundary (permissions-and-rpc.md 7장):
 * - caller identity from verified JWT, role/firm read through the caller's RLS-scoped client
 * - biz_no/rep_name/open_date/firm_name come from the DB row only; body firmId/bizNo are optional consistency checks
 * - each NTS call that fails keeps its previous columns; both failing returns NETWORK_ERROR with nothing written
 * - service role updates only biz_status/biz_checked_at/biz_valid/biz_validated_at, matching id+owner_id+biz_no
 * - approval goes only through try_auto_approve_firm (setting off by default → no change; rejected never changes)
 */
export async function verifyBusiness({ userId, body, userDb, admin, fetchImpl, serviceKey, now = () => new Date(), timeoutMs = 10000 }) {
  if (body.firmId !== undefined && (typeof body.firmId !== 'string' || !UUID.test(body.firmId))) return fail('INVALID_INPUT');
  if (body.bizNo !== undefined && (typeof body.bizNo !== 'string' || !/^[0-9]{10}$/.test(body.bizNo))) return fail('INVALID_INPUT');

  const profile = await userDb.from('profiles').select('id,role').eq('id', userId).maybeSingle();
  if (profile.error) return fail('INTERNAL_ERROR');
  if (profile.data?.role !== 'firm') return fail('FORBIDDEN');
  const own = await userDb.from('firms').select('id,owner_id,biz_no,firm_name,rep_name,open_date').eq('owner_id', userId).maybeSingle();
  if (own.error) return fail('INTERNAL_ERROR');
  const firm = own.data;
  if (!firm) return fail('NOT_FOUND');
  if (firm.owner_id !== userId) return fail('FORBIDDEN');
  if (body.firmId !== undefined && body.firmId !== firm.id) return fail('FORBIDDEN');
  if (body.bizNo !== undefined && body.bizNo !== firm.biz_no) return fail('CONFLICT');
  if (!serviceKey) return fail('INTERNAL_ERROR');

  // Rows created before rep_name/open_date existed cannot be validated; their biz_valid stays as is.
  const openDate = typeof firm.open_date === 'string' ? firm.open_date.slice(0, 10) : null;
  const canValidate = Boolean(firm.rep_name) && /^\d{4}-\d{2}-\d{2}$/.test(openDate ?? '');
  const [statusEntry, validEntry] = await Promise.all([
    ntsCall(fetchImpl, NTS_STATUS_URL, serviceKey, { b_no: [firm.biz_no] }, firm.biz_no, timeoutMs),
    canValidate ? ntsCall(fetchImpl, NTS_VALIDATE_URL, serviceKey, { businesses: [{
      b_no: firm.biz_no, start_dt: openDate.replaceAll('-', ''), p_nm: firm.rep_name, b_nm: firm.firm_name,
    }] }, firm.biz_no, timeoutMs) : null,
  ]);
  const statusOk = Boolean(statusEntry);
  const validOk = Boolean(validEntry) && typeof validEntry.valid === 'string';
  if (!statusOk && !validOk) return fail('NETWORK_ERROR');

  const at = now().toISOString();
  const changes = {
    ...(statusOk ? { biz_status: mapNtsStatus(statusEntry.b_stt_cd), biz_checked_at: at } : {}),
    ...(validOk ? { biz_valid: mapNtsValid(validEntry.valid), biz_validated_at: at } : {}),
  };
  const updated = await admin.from('firms').update(changes)
    .eq('id', firm.id).eq('owner_id', userId).eq('biz_no', firm.biz_no)
    .select('id,biz_status,biz_checked_at,biz_valid,biz_validated_at').maybeSingle();
  if (updated.error) return fail('INTERNAL_ERROR');
  if (!updated.data) return fail('CONFLICT'); // biz_no changed during lookup

  const approval = await admin.rpc('try_auto_approve_firm', { firm_id: firm.id });
  if (approval.error || !approval.data) return fail('INTERNAL_ERROR');
  return { data: {
    firmId: updated.data.id,
    bizStatus: updated.data.biz_status, bizCheckedAt: updated.data.biz_checked_at,
    bizValid: updated.data.biz_valid, bizValidatedAt: updated.data.biz_validated_at,
    approvalStatus: approval.data.approval_status,
  } };
}
