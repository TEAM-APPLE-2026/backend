// Tiny PostgREST stand-in backed by PGlite: runs each query under a real DB role (RLS + column grants apply).
const ident = name => { if (!/^[a-z_]+$/.test(name)) throw Error(`bad identifier ${name}`); return `"${name}"`; };
const run = async (db, role, sub, sql, args) => {
  await db.exec(`begin; set local role ${role};`);
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
    const rows = (await db.query(sql, args)).rows; await db.exec('commit');
    return { rows };
  } catch (e) { await db.exec('rollback'); return { error: { code: e.code, message: e.message } }; }
};
// PostgREST returns date columns as 'YYYY-MM-DD'; PGlite gives Date objects.
const dateText = v => `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
export function pgClient(db, role, sub = '') {
  return {
  async rpc(name, args = {}) {
    // PGlite cannot infer parameter types for named arguments; read them from the catalog (like PostgREST's schema cache).
    const types = Object.fromEntries((await db.query(`select a.n, format_type(a.t, null) t from pg_proc p,
      unnest(p.proargnames, p.proargtypes::oid[]) a(n, t) where p.oid = $1::regproc`, [`public.${name}`])).rows.map(r => [r.n, r.t]));
    const values = []; const named = Object.entries(args).map(([k, v]) => {
      if (!/^[a-z ]+$/.test(types[k] ?? '')) throw Error(`bad arg ${k}`);
      values.push(v); return `${ident(k)}=>$${values.length}::${types[k]}`;
    });
    const r = await run(db, role, sub, `select public.${ident(name)}(${named.join(',')}) v`, values);
    return r.error ? { data: null, error: r.error } : { data: r.rows[0]?.v ?? null, error: null };
  },
  from(table) {
    const q = { filters: [], update: null, cols: '*' };
    const b = {
      select(cols) { q.cols = cols; return b; },
      update(values) { q.update = values; return b; },
      eq(col, value) { q.filters.push([col, value]); return b; },
      async maybeSingle() {
        const args = []; const p = v => { args.push(v); return `$${args.length}`; };
        const cols = q.cols === '*' ? '*' : q.cols.split(',').map(ident).join(',');
        const where = q.filters.map(([c, v]) => `${ident(c)}::text=${p(String(v))}`).join(' and ') || 'true';
        const sql = q.update
          ? `update public.${ident(table)} set ${Object.entries(q.update).map(([c, v]) => `${ident(c)}=${p(v)}`).join(',')} where ${where} returning ${cols}`
          : `select ${cols} from public.${ident(table)} where ${where}`;
        await db.exec(`begin; set local role ${role};`);
        try {
          await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
          const rows = (await db.query(sql, args)).rows; await db.exec('commit');
          for (const row of rows) for (const [k, v] of Object.entries(row)) if (v instanceof Date) row[k] = k.endsWith('_date') ? dateText(v) : v.toISOString();
          return { data: rows[0] ?? null, error: null };
        } catch (e) { await db.exec('rollback'); return { data: null, error: { code: e.code, message: e.message } }; }
      },
    };
    return b;
  } };
}
// Service-role admin: PG role service_role + in-memory Storage object bytes.
export function adminClient(db, objects = new Map()) {
  const dropped = [];
  return { ...pgClient(db, 'service_role'), dropped, objects,
    storage: { from: bucket => ({
      download: async path => objects.has(`${bucket}/${path}`)
        ? { data: new Blob([objects.get(`${bucket}/${path}`)]), error: null }
        : { data: null, error: { message: 'Object not found' } },
      remove: async paths => {
        for (const x of paths) { dropped.push(`${bucket}/${x}`); objects.delete(`${bucket}/${x}`); }
        return { data: [], error: null };
      },
    }) } };
}
