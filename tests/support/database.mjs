import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
export async function database() {
  const notices = [];
  const db = new PGlite({ onNotice: n => notices.push(n.message) });
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
    -- Minimal Supabase Storage stand-in (column order matches tests/support/firms.mjs inserts).
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,
      file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(bucket_id text not null,name text not null,owner_id text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;
  `);
  for (const file of (await readdir(new URL('supabase/migrations/',root))).filter(f=>f.endsWith('.sql')).sort())
    await db.exec(await readFile(new URL(`supabase/migrations/${file}`, root),'utf8'));
  return { db, notices };
}
