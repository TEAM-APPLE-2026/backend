import {test} from 'node:test';import assert from 'node:assert/strict';
import {database} from './support/database.mjs';import {actor,users,uid} from './support/actors.mjs';
import {firm} from './support/firms.mjs';import {pgClient,adminClient} from './support/pgclient.mjs';
import {verifyBusiness,mapNtsStatus,NTS_STATUS_URL} from '../supabase/functions/_shared/nts.mjs';
import {handle} from '../supabase/functions/_shared/http.mjs';

const KEY='synthetic-key/with+chars=';
const answer=(bNo,code)=>async()=>new Response(JSON.stringify({status_code:'OK',request_cnt:1,data:[{b_no:bNo,b_stt_cd:code,b_stt:'',tax_type:''}]}),{status:200});
const row=async(db,id)=>(await db.query('select biz_status,biz_checked_at,approval_status from public.firms where id=$1',[id])).rows[0];

test('NTS status mapping',()=>{
 assert.deepEqual(['01','02','03','',undefined,'99'].map(mapNtsStatus),['active','suspended','closed','unknown','unknown','unknown']);
});

test('nts-verify: own firm via DB biz_no, only biz_status/biz_checked_at, failures keep previous value',async()=>{
 const{db}=await database();try{
 await users(db,1);const fid=await firm(db,30,'1234567890');
 const admin=adminClient(db);
 const call=(n,body,fetchImpl)=>verifyBusiness({userId:uid(n),body,userDb:pgClient(db,'authenticated',uid(n)),admin,fetchImpl,serviceKey:KEY});
 const requests=[];
 const r=await call(30,{bizNo:'1234567890'},async(url,init)=>{requests.push({url,init});return answer('1234567890','01')();});
 assert.equal(r.data.firmId,fid);assert.equal(r.data.bizStatus,'active');assert.ok(r.data.bizCheckedAt);
 assert.equal(requests[0].url,`${NTS_STATUS_URL}?serviceKey=${encodeURIComponent(KEY)}`);
 assert.deepEqual(JSON.parse(requests[0].init.body),{b_no:['1234567890']});assert.equal(requests[0].init.method,'POST');
 assert.ok(!JSON.stringify(r).includes(KEY));
 const after=await row(db,fid);assert.equal(after.approval_status,'pending');

 for(const [code,status] of [['02','suspended'],['03','closed'],['','unknown']])
  assert.equal((await call(30,{},answer('1234567890',code))).data.bizStatus,status);
 const before=await row(db,fid);
 const never=async()=>{throw Error('must not call NTS');};
 for(const fetchImpl of [async()=>{throw new TypeError('fetch failed '+KEY);},async()=>new Response('err',{status:500}),
  async()=>new Response('not json'),async()=>new Response(JSON.stringify({status_code:'OK',data:[]})),answer('0000000000','01')]){
  const x=await call(30,{},fetchImpl);assert.equal(x.error.code,'NETWORK_ERROR');assert.ok(!JSON.stringify(x).includes(KEY));
 }
 assert.deepEqual(await row(db,fid),before);
 // Body values are never trusted: mismatch is rejected before calling NTS.
 assert.equal((await call(30,{bizNo:'0000000009'},never)).error.code,'CONFLICT');
 assert.equal((await call(30,{firmId:'11111111-1111-4111-8111-111111111111'},never)).error.code,'FORBIDDEN');
 assert.equal((await call(30,{bizNo:'12'},never)).error.code,'INVALID_INPUT');
 assert.equal((await call(1,{},never)).error.code,'FORBIDDEN'); // role=user
 await db.query('insert into auth.users(id,email) values($1,$2)',[uid(31),'firm-31@example.invalid']);
 await actor(db,31,"select public.complete_signup('firm','No application') v");
 assert.equal((await call(31,{},never)).error.code,'NOT_FOUND');
 // biz_no changed while waiting for NTS → no row matched → CONFLICT, nothing written.
 const raced=await call(30,{},async()=>{await db.query("update public.firms set biz_no='1234567891' where id=$1",[fid]);return answer('1234567890','03')();});
 assert.equal(raced.error.code,'CONFLICT');assert.deepEqual(await row(db,fid),before);
 assert.equal((await verifyBusiness({userId:uid(30),body:{},userDb:pgClient(db,'authenticated',uid(30)),admin,fetchImpl:never,serviceKey:''})).error.code,'INTERNAL_ERROR');
 // Service role cannot touch approval fields.
 assert.equal((await admin.from('firms').update({approval_status:'approved'}).eq('id',fid).select('id').maybeSingle()).error.code,'42501');
 }finally{await db.close();}
});

test('Edge HTTP wrapper: CORS, POST only, verified token required, contract errors',async()=>{
 const U='44000000-0000-4000-8000-000000000001';
 const deps={getUserId:async t=>t==='good'?U:null,context:()=>({})};
 const req=(init={})=>new Request('http://local/fn',{method:'POST',...init});
 const logic=async({userId,body})=>body.fail?{error:{code:body.fail}}:{data:{userId}};
 assert.equal((await handle(req({method:'OPTIONS'}),deps,logic)).status,204);
 assert.equal((await handle(req({method:'GET'}),deps,logic)).status,405);
 assert.equal((await handle(req(),deps,logic)).status,401);
 assert.equal((await handle(req({headers:{Authorization:'Bearer bad'}}),deps,logic)).status,401);
 assert.equal((await handle(req({headers:{Authorization:'Bearer good'},body:'{'}),deps,logic)).status,400);
 const ok=await handle(req({headers:{Authorization:'Bearer good'}}),deps,logic);
 assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{data:{userId:U}});
 const e=await handle(req({headers:{Authorization:'Bearer good'},body:JSON.stringify({fail:'CONFLICT'})}),deps,logic);
 assert.equal(e.status,409);assert.equal((await e.json()).error.code,'CONFLICT');
 const boom=await handle(req({headers:{Authorization:'Bearer good'}}),deps,async()=>{throw Error('secret detail');});
 assert.equal(boom.status,500);assert.ok(!(await boom.text()).includes('secret'));
});
