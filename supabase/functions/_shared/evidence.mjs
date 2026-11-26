import { fail, UUID } from './http.mjs';

// Real file signature check. The Content-Type header / DB mime_type string alone is not trusted.
export function detectMime(bytes) {
  const starts = sig => sig.every((b, i) => bytes[i] === b);
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length >= 5 && starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  return null;
}

const view = row => ({ evidenceId: row.id, status: row.status, uploadedAt: row.uploaded_at ?? null });
const columns = 'id,report_id,bucket_id,object_path,mime_type,size_bytes,status,uploaded_at';

/**
 * userDb: Supabase client carrying the caller's JWT (RLS proves ownership).
 * admin: service-role client, server-only. Used for the real object and status/uploaded_at update only.
 */
export async function confirmEvidence({ userId, body, userDb, admin }) {
  const evidenceId = body.evidenceId;
  if (typeof evidenceId !== 'string' || !UUID.test(evidenceId)) return fail('INVALID_INPUT');
  const own = await userDb.from('evidences').select(columns).eq('id', evidenceId).maybeSingle();
  if (own.error) return fail('INTERNAL_ERROR');
  const row = own.data;
  // RLS already hides foreign rows; the path prefix is re-checked explicitly.
  if (!row || row.bucket_id !== 'evidences' || !row.object_path.startsWith(`${userId}/${row.report_id}/`)) return fail('NOT_FOUND');
  if (row.status !== 'pending') return { data: view(row) }; // idempotent: already decided

  const file = await admin.storage.from(row.bucket_id).download(row.object_path);
  // Not uploaded yet (or Storage unavailable): keep pending so the client can upload/retry.
  if (file.error || !file.data) return fail('CONFLICT');
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  const ok = bytes.length === Number(row.size_bytes) && detectMime(bytes) === row.mime_type;

  const updated = await admin.from('evidences').update({ status: ok ? 'ready' : 'failed' })
    .eq('id', row.id).eq('status', 'pending').eq('object_path', row.object_path)
    .select(columns).maybeSingle();
  if (updated.error) return fail(updated.error.message === 'CONFLICT' ? 'CONFLICT' : 'INTERNAL_ERROR');
  if (!updated.data) return fail('CONFLICT'); // deleted or decided concurrently
  if (!ok) {
    // Best effort: do not keep unverified content. delete_evidence + client remove stays the retry path.
    try { await admin.storage.from(row.bucket_id).remove([row.object_path]); } catch { /* retryable */ }
  }
  return { data: view(updated.data) };
}
