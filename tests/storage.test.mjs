import {test} from 'node:test';import assert from 'node:assert/strict';
import {database} from './support/database.mjs';import {actor,users,report,uid,reject} from './support/actors.mjs';
import {firm} from './support/firms.mjs';import {pgClient,adminClient} from './support/pgclient.mjs';
import {confirmEvidence,detectMime} from '../supabase/functions/_shared/evidence.mjs';

const RLS='new row violates row-level security policy for table "objects"';
const png=n=>{const b=new Uint8Array(n);b.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);return b;};
const upload=(db,n,bucket,name)=>actor(db,n,"insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,'{}') returning 1 v",[bucket,name,uid(n)]);
const count=(db,n,sql,args)=>actor(db,n,`with x as (${sql} returning 1) select count(*)::int v from x`,args);
const register=(db,n,reportId,over={})=>{const a={kind:'screenshot',name:'capture.PNG',mime:'image/png',size:16,...over};
 return actor(db,n,'select public.create_evidence_upload($1,$2,$3,$4,$5) v',[reportId,a.kind,a.name,a.mime,a.size]);};

test('Storage buckets are private with 10,000,000 bytes and JPEG/PNG/PDF only',async()=>{
 const{db}=await database();try{
 const rows=(await db.query("select id,public,file_size_limit::int l,allowed_mime_types m from storage.buckets order by id")).rows;
 assert.deepEqual(rows.map(r=>[r.id,r.public,r.l]),[['evidences',false,10000000],['firm-certs',false,10000000]]);
 for(const r of rows)assert.deepEqual(r.m,['image/jpeg','image/png','application/pdf']);
 }finally{await db.close();}
});

test('Evidence registration: own report only, server path, strict metadata',async()=>{
 const{db}=await database();try{
 await users(db,2);const r1=await report(db,1);
 const e=await register(db,1,r1);
 assert.equal(e.status,'pending');assert.equal(e.object_path,`${uid(1)}/${r1}/${e.evidence_id}.png`);assert.equal(e.original_name,'capture.PNG');
 await reject(register(db,2,r1),'NOT_FOUND');
 await reject(actor(db,0,'select public.create_evidence_upload($1,$2,$3,$4,$5) v',[r1,'screenshot','a.png','image/png',1]),'permission denied for function create_evidence_upload');
 for(const over of [{mime:'image/gif',name:'a.gif'},{size:10000001},{size:0},{name:'a.pdf'},{name:'../x.png'},{name:' '},{kind:'Bad Kind'},{name:'a.jpeg',mime:'image/png'}])
  await reject(register(db,1,r1,over),'INVALID_INPUT');
 assert.equal((await register(db,1,r1,{name:'photo.jpeg',mime:'image/jpeg'})).object_path.endsWith('.jpg'),true);
 // Client cannot set ready directly.
 await reject(actor(db,1,"update public.evidences set status='ready'"),'permission denied for table evidences');
 }finally{await db.close();}
});

test('Storage policies: own pending path upload, no overwrite, no foreign read/delete, row-first delete',async()=>{
 const{db}=await database();try{
 await users(db,2);const r1=await report(db,1),r2=await report(db,2);const f=await firm(db,30);assert.ok(f);
 const e=await register(db,1,r1);
 // Wrong owner prefix, foreign report under own prefix, no pending row, firm user: all denied.
 await reject(upload(db,2,'evidences',e.object_path),RLS);
 await reject(upload(db,1,'evidences',`${uid(1)}/${r2}/${e.evidence_id}.png`),RLS);
 await reject(upload(db,1,'evidences',`${uid(1)}/${r1}/11111111-1111-4111-8111-111111111111.png`),RLS);
 await reject(upload(db,30,'evidences',e.object_path),RLS);
 assert.equal(await upload(db,1,'evidences',e.object_path),1);
 // No UPDATE policy: cannot replace content/metadata of an uploaded object.
 assert.equal(await count(db,1,"update storage.objects set metadata='{\"size\":1}' where bucket_id='evidences'"),0);
 const read=n=>actor(db,n,"select count(*)::int v from storage.objects where bucket_id='evidences'");
 assert.equal(await read(1),1);assert.equal(await read(2),0);assert.equal(await read(30),0);
 // Object delete is blocked while the DB row exists; foreign users never delete.
 assert.equal(await count(db,1,"delete from storage.objects where bucket_id='evidences'"),0);
 await reject(actor(db,2,'select public.delete_evidence($1) v',[e.evidence_id]),'NOT_FOUND');
 const d=await actor(db,1,'select public.delete_evidence($1) v',[e.evidence_id]);assert.equal(d.object_path,e.object_path);
 assert.equal(await count(db,2,"delete from storage.objects where bucket_id='evidences'"),0);
 assert.equal(await count(db,1,"delete from storage.objects where bucket_id='evidences'"),1);
 await reject(actor(db,1,'select public.delete_evidence($1) v',[e.evidence_id]),'NOT_FOUND');
 }finally{await db.close();}
});

test('firm-certs policies: firm owner path only, referenced certificate kept',async()=>{
 const{db}=await database();try{
 await users(db,1);await firm(db,30);
 const cert=`${uid(30)}/11111111-1111-4111-8111-111111111111.pdf`; // referenced by the application (fixture)
 const spare=`${uid(30)}/22222222-2222-4222-8222-222222222222.png`;
 await reject(upload(db,1,'firm-certs',`${uid(1)}/22222222-2222-4222-8222-222222222222.png`),RLS); // role=user
 await reject(upload(db,30,'firm-certs',`${uid(1)}/22222222-2222-4222-8222-222222222222.png`),RLS);
 await reject(upload(db,30,'firm-certs',`${uid(30)}/not-a-uuid.png`),RLS);
 assert.equal(await upload(db,30,'firm-certs',spare),1);
 assert.equal(await actor(db,30,"select count(*)::int v from storage.objects where bucket_id='firm-certs'"),2);
 assert.equal(await actor(db,1,"select count(*)::int v from storage.objects where bucket_id='firm-certs'"),0);
 assert.equal(await count(db,30,"delete from storage.objects where bucket_id='firm-certs' and name=$1",[cert]),0);
 assert.equal(await count(db,30,"delete from storage.objects where bucket_id='firm-certs' and name=$1",[spare]),1);
 }finally{await db.close();}
});

test('detectMime checks real signatures',()=>{
 assert.equal(detectMime(png(8)),'image/png');assert.equal(detectMime(new Uint8Array([0xff,0xd8,0xff,0xe0])),'image/jpeg');
 assert.equal(detectMime(new TextEncoder().encode('%PDF-1.7')),'application/pdf');
 assert.equal(detectMime(new TextEncoder().encode('<html>')),null);assert.equal(detectMime(new Uint8Array()),null);
});

test('evidence-confirm: owner pending row → ready only when real size/signature match',async()=>{
 const{db}=await database();try{
 await users(db,2);const r1=await report(db,1);
 const admin=adminClient(db);const ctx=n=>({userId:uid(n),userDb:pgClient(db,'authenticated',uid(n)),admin});
 const good=await register(db,1,r1),bad=await register(db,1,r1),fake=await register(db,1,r1),missing=await register(db,1,r1);
 admin.objects.set(`evidences/${good.object_path}`,png(16));
 admin.objects.set(`evidences/${bad.object_path}`,png(15)); // size differs from row
 admin.objects.set(`evidences/${fake.object_path}`,new TextEncoder().encode('<html>evil</html>'));
 assert.equal((await confirmEvidence({...ctx(2),body:{evidenceId:good.evidence_id}})).error.code,'NOT_FOUND');
 assert.equal((await confirmEvidence({...ctx(1),body:{evidenceId:'x'}})).error.code,'INVALID_INPUT');
 assert.equal((await confirmEvidence({...ctx(1),body:{evidenceId:missing.evidence_id}})).error.code,'CONFLICT');
 const ok=await confirmEvidence({...ctx(1),body:{evidenceId:good.evidence_id}});
 assert.equal(ok.data.status,'ready');assert.ok(ok.data.uploadedAt);
 assert.deepEqual(await confirmEvidence({...ctx(1),body:{evidenceId:good.evidence_id}}),ok); // idempotent
 for(const e of [bad,fake]){
  const r=await confirmEvidence({...ctx(1),body:{evidenceId:e.evidence_id}});
  assert.equal(r.data.status,'failed');assert.equal(r.data.uploadedAt,null);assert.ok(admin.dropped.includes(`evidences/${e.object_path}`));
 }
 const rows=(await db.query('select id,status from public.evidences')).rows;
 assert.equal(rows.find(r=>r.id===missing.evidence_id).status,'pending');
 // Service role: only status/uploaded_at, only pending → ready/failed.
 assert.equal((await admin.from('evidences').update({size_bytes:1}).eq('id',good.evidence_id).select('id').maybeSingle()).error.code,'42501');
 assert.equal((await admin.from('evidences').update({status:'pending'}).eq('id',good.evidence_id).select('id').maybeSingle()).error.message,'CONFLICT');
 }finally{await db.close();}
});
