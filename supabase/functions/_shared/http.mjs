// Runtime-neutral (Deno + Node test) HTTP wrapper for Edge Functions.
// Responses follow the API contract: {data} or {error:{code,message}}. Never echo tokens, keys or raw upstream errors.
export const statusByCode = {
  AUTH_REQUIRED: 401, FORBIDDEN: 403, FIRM_NOT_APPROVED: 403, NOT_FOUND: 404,
  INVALID_INPUT: 400, CONFLICT: 409, NETWORK_ERROR: 502, INTERNAL_ERROR: 500,
};
const messages = {
  AUTH_REQUIRED: 'Login required.', FORBIDDEN: 'Forbidden.', FIRM_NOT_APPROVED: 'Firm not approved.',
  NOT_FOUND: 'Not found.', INVALID_INPUT: 'Invalid input.', CONFLICT: 'State changed. Reload and retry.',
  NETWORK_ERROR: 'Upstream unavailable. Retry later.', INTERNAL_ERROR: 'Internal error.',
};
export const fail = code => ({ error: { code, message: messages[code] } });
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (result, status) => new Response(JSON.stringify(result), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
});

/**
 * deps.getUserId(token) -> verified auth user id | null (validated by Supabase Auth, not decoded locally)
 * deps.context(token)   -> extra dependencies for logic (user-scoped client, admin client, ...)
 * logic({userId, body, ...context}) -> {data} | {error}
 */
export async function handle(req, deps, logic) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    if (req.method !== 'POST') return reply(fail('INVALID_INPUT'), 405);
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('Authorization') ?? '');
    if (!match) return reply(fail('AUTH_REQUIRED'), 401);
    const userId = await deps.getUserId(match[1]);
    if (typeof userId !== 'string' || !UUID.test(userId)) return reply(fail('AUTH_REQUIRED'), 401);
    let body = {};
    const text = await req.text();
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { return reply(fail('INVALID_INPUT'), 400); }
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return reply(fail('INVALID_INPUT'), 400);
    const result = await logic({ userId, body, ...deps.context(match[1]) });
    if (result?.error) return reply(fail(result.error.code in statusByCode ? result.error.code : 'INTERNAL_ERROR'),
      statusByCode[result.error.code] ?? 500);
    return reply({ data: result.data }, 200);
  } catch {
    // Do not log the error object: upstream errors may contain request URLs with keys.
    return reply(fail('INTERNAL_ERROR'), 500);
  }
}
