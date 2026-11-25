// Server-only clients. Keys come from the Edge runtime environment; never from the request or the repository.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

const authClient = createClient(url, anonKey, options);
export const admin = createClient(url, serviceRoleKey, options);

// Validates the access token with Supabase Auth (signature + expiry + revoked session).
export async function getUserId(token: string): Promise<string | null> {
  const { data, error } = await authClient.auth.getUser(token);
  return error ? null : data.user?.id ?? null;
}

// Caller-scoped client: PostgREST applies RLS as the logged-in user.
export const userDb = (token: string) => createClient(url, anonKey, {
  ...options, global: { headers: { Authorization: `Bearer ${token}` } },
});
