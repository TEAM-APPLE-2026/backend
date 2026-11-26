// POST {evidenceId} with the user's access token → {data:{evidenceId,status,uploadedAt}}
import { handle } from '../_shared/http.mjs';
import { confirmEvidence } from '../_shared/evidence.mjs';
import { admin, getUserId, userDb } from '../_shared/clients.ts';

Deno.serve(req => handle(req, {
  getUserId,
  context: (token: string) => ({ userDb: userDb(token), admin }),
}, confirmEvidence));
