// POST {firmId?,bizNo?} with the firm owner's access token → {data:{firmId,bizStatus,bizCheckedAt}}
// NTS_SERVICE_KEY (data.go.kr "Decoding" key) is set with `supabase secrets set`, never committed.
import { handle } from '../_shared/http.mjs';
import { verifyBusiness } from '../_shared/nts.mjs';
import { admin, getUserId, userDb } from '../_shared/clients.ts';

Deno.serve(req => handle(req, {
  getUserId,
  context: (token: string) => ({
    userDb: userDb(token), admin, fetchImpl: fetch, serviceKey: Deno.env.get('NTS_SERVICE_KEY') ?? '',
  }),
}, verifyBusiness));
