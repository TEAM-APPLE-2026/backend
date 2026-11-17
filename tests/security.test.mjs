import{test}from'node:test';import assert from'node:assert/strict';import{database}from'./support/database.mjs';
test('Schema ACLs: RLS everywhere, no direct client writes, private helper execution revoked',async()=>{
 const{db}=await database();try{
 const tables=(await db.query("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'and c.relkind='r'")).rows;
 assert.ok(tables.length>=20);assert.ok(tables.every(x=>x.relrowsecurity));
 const writes=(await db.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'and c.relkind='r'and(has_table_privilege('authenticated',c.oid,'INSERT')or has_table_privilege('authenticated',c.oid,'DELETE'))")).rows;
 assert.deepEqual(writes,[]);
 const helpers=(await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='hande_private'and has_function_privilege('authenticated',p.oid,'EXECUTE')")).rows;
 assert.deepEqual(helpers,[]);
 const publicLeaks=(await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.prosecdef and p.proname not in('get_group','list_groups')and has_function_privilege('anon',p.oid,'EXECUTE')")).rows;
 assert.deepEqual(publicLeaks,[]);
 for(const fn of ['close_vote(uuid)','close_due_votes(integer)','record_group_connection(uuid)','close_group(uuid,text)']){
 assert.equal((await db.query('select has_function_privilege($1,$2,$3)v',['authenticated','public.'+fn,'EXECUTE'])).rows[0].v,false);
 assert.equal((await db.query('select has_function_privilege($1,$2,$3)v',['service_role','public.'+fn,'EXECUTE'])).rows[0].v,true);
 }
 const defs=(await db.query("select p.proname,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','hande_private')and p.prosecdef")).rows;
 assert.ok(defs.every(p=>p.proconfig?.some(c=>c==='search_path=""')));
 }finally{await db.close();}
});
