import { fail, UUID } from './http.mjs';

export const NTS_STATUS_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/status';
const codes = { '01': 'active', '02': 'suspended', '03': 'closed' };
// Valid NTS answer: 01/02/03 are mapped; anything else (e.g. unregistered number, empty code) is unknown.
export const mapNtsStatus = code => codes[code] ?? 'unknown';

/**
 * Trust boundary (permissions-and-rpc.md 7장):
 * - caller identity from verified JWT, role/firm read through the caller's RLS-scoped client
 * - biz_no comes from the DB row only; body firmId/bizNo are optional consistency checks
 * - network/upstream failure keeps biz_status/biz_checked_at and returns an error
 * - service role updates only biz_status/biz_checked_at, matching id+owner_id+biz_no
 */
export async function verifyBusiness({ userId, body, userDb, admin, fetchImpl, serviceKey, now = () => new Date(), timeoutMs = 10000 }) {
  if (body.firmId !== undefined && (typeof body.firmId !== 'string' || !UUID.test(body.firmId))) return fail('INVALID_INPUT');
  if (body.bizNo !== undefined && (typeof body.bizNo !== 'string' || !/^[0-9]{10}$/.test(body.bizNo))) return fail('INVALID_INPUT');

  const profile = await userDb.from('profiles').select('id,role').eq('id', userId).maybeSingle();
  if (profile.error) return fail('INTERNAL_ERROR');
  if (profile.data?.role !== 'firm') return fail('FORBIDDEN');
  const own = await userDb.from('firms').select('id,owner_id,biz_no,biz_status,biz_checked_at').eq('owner_id', userId).maybeSingle();
  if (own.error) return fail('INTERNAL_ERROR');
  const firm = own.data;
  if (!firm) return fail('NOT_FOUND');
  if (firm.owner_id !== userId) return fail('FORBIDDEN');
  if (body.firmId !== undefined && body.firmId !== firm.id) return fail('FORBIDDEN');
  if (body.bizNo !== undefined && body.bizNo !== firm.biz_no) return fail('CONFLICT');
  if (!serviceKey) return fail('INTERNAL_ERROR');

  let payload;
  try {
    const res = await fetchImpl(`${NTS_STATUS_URL}?serviceKey=${encodeURIComponent(serviceKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ b_no: [firm.biz_no] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return fail('NETWORK_ERROR');
    payload = await res.json();
  } catch {
    return fail('NETWORK_ERROR'); // timeout, DNS, invalid JSON: keep the previous result
  }
  const entry = payload?.status_code === 'OK' && Array.isArray(payload.data)
    ? payload.data.find(item => item?.b_no === firm.biz_no) : undefined;
  if (!entry) return fail('NETWORK_ERROR'); // not a valid answer for this number

  const updated = await admin.from('firms')
    .update({ biz_status: mapNtsStatus(entry.b_stt_cd), biz_checked_at: now().toISOString() })
    .eq('id', firm.id).eq('owner_id', userId).eq('biz_no', firm.biz_no)
    .select('id,biz_status,biz_checked_at').maybeSingle();
  if (updated.error) return fail('INTERNAL_ERROR');
  if (!updated.data) return fail('CONFLICT'); // biz_no changed during lookup
  return { data: { firmId: updated.data.id, bizStatus: updated.data.biz_status, bizCheckedAt: updated.data.biz_checked_at } };
}
