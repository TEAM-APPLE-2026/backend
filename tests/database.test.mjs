import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { database } from './support/database.mjs';
const root = new URL('../', import.meta.url);
test('PostgreSQL 17: migrations and owner/foreign/anonymous SQL regressions', async () => {
  const { db, notices } = await database();
  try {
    for (const file of ['member_profiles.sql','reports.sql'])
      await db.exec(await readFile(new URL(`supabase/tests/${file}`,root),'utf8'));
    assert.equal((await db.query('select count(*)::int n from auth.users')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from public.reports')).rows[0].n,0);

    console.log('Profile and report SQL regressions passed; synthetic fixtures rolled back.');
  } finally { await db.close(); }
});
