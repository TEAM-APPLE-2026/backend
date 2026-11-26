import {test} from 'node:test';import assert from 'node:assert/strict';
import {database} from './support/database.mjs';import {actor,users,uid,reject} from './support/actors.mjs';
import {firm} from './support/firms.mjs';import {pgClient,adminClient} from './support/pgclient.mjs';
import {verifyBusiness,mapNtsValid,NTS_STATUS_URL,NTS_VALIDATE_URL} from '../supabase/functions/_shared/nts.mjs';
import {createBackendClient} from '../src/data/client.mjs';

const KEY='synthetic-key/with+chars=';
const BIZ='1234567890';
const json=v=>new Response(JSON.stringify(v),{status:200});
// NTS stand-in: dispatch by endpoint. null → that endpoint fails (network error).
const nts=({stt='01',valid='01'}={},log=[])=>async(url,init)=>{
 log.push({url,body:JSON.parse(init.body)});
 if(url.startsWith(NTS_STATUS_URL)){if(stt===null)throw new TypeError('fetch failed '+KEY);
  return json({status_code:'OK',data:[{b_no:BIZ,b_stt_cd:stt}]});}
 if(url.startsWith(NTS_VALIDATE_URL)){if(valid===null)return new Response('err',{status:500});
  return json({status_code:'OK',data:[{b_no:BIZ,valid,request_param:{}}]});}
 throw Error('unexpected url');
};
const row=async(db,id)=>(await db.query('select biz_status,biz_valid,biz_checked_at,biz_validated_at,approval_status from public.firms where id=$1',[id])).rows[0];
const setMode=(db,v)=>db.query("update hande_private.app_settings set value=$1 where key='firm_auto_approve'",[v]);
async function setup(){
 const{db}=await database();await users(db,1);const fid=await firm(db,30,BIZ);
 const admin=adminClient(db);
 const call=(fetchImpl,n=30)=>verifyBusiness({userId:uid(n),body:{},userDb:pgClient(db,'authenticated',uid(n)),admin,fetchImpl,serviceKey:KEY});
 return{db,fid,admin,call};
}

test('Firm application: rep_name/open_date required, lawyers optional 0~20, strict date',async()=>{
 const{db}=await database();try{
 await db.query('insert into auth.users(id,email)values($1,$2)',[uid(31),'apply@example.invalid']);
 await actor(db,31,"select public.complete_signup('firm','Applicant')v");
 const path=`${uid(31)}/11111111-1111-4111-8111-111111111111.pdf`;
 await db.query('insert into storage.objects values($1,$2,$3,$4)',['firm-certs',path,uid(31),JSON.stringify({mimetype:'application/pdf',size:100})]);
 const apply=(rep,open,lawyers)=>actor(db,31,'select public.create_firm_application(firm_name=>$1,biz_no=>$2,cert_path=>$3,rep_name=>$4,open_date=>$5'+(lawyers===undefined?'':',lawyers=>$6::jsonb')+')v',
  ['Applicant Firm','0000000031',path,rep,open,...(lawyers===undefined?[]:[lawyers])]);
 for(const[rep,open]of[[null,'2020-01-02'],['  ','2020-01-02'],['Rep',null],['Rep','20200102'],['Rep','2020-02-30'],['Rep','2999-01-01'],['Rep','1899-12-31']])
  await reject(apply(rep,open),'INVALID_INPUT');
 await reject(apply('Rep','2020-01-02',JSON.stringify(Array.from({length:21},(_,i)=>({name:'L',regNo:'R'+i})))),'INVALID_INPUT');
 await reject(apply('Rep','2020-01-02',JSON.stringify([{name:'L',regNo:'R'},{name:'M',regNo:'R'}])),'INVALID_INPUT');
 await reject(apply('Rep','2020-01-02','{}'),'INVALID_INPUT');
 const f=await apply(' Rep Name ','2020-01-02'); // lawyers omitted → []
 assert.equal(f.rep_name,'Rep Name');assert.equal(f.open_date,'2020-01-02');assert.equal(f.biz_valid,'unchecked');assert.equal(f.approval_status,'pending');
 assert.equal((await db.query('select count(*)::int n from public.firm_lawyers where firm_id=$1',[f.id])).rows[0].n,0);
 assert.equal((await actor(db,31,'select public.get_my_firm()v')).rep_name,'Rep Name');
 // Old 4-argument signature no longer exists.
 assert.equal((await db.query("select to_regprocedure('public.create_firm_application(text,text,text,jsonb)') v")).rows[0].v,null);
 }finally{await db.close();}
});

test('nts-verify validate: DB values only, 01/02/other mapping, each failure keeps its own columns',async()=>{
 const{db,fid,call}=await setup();try{
 assert.deepEqual(['01','02','',undefined,'99'].map(mapNtsValid),['valid','invalid','unknown','unknown','unknown']);
 const log=[];
 const r=await call(nts({},log));
 assert.equal(r.data.bizValid,'valid');assert.equal(r.data.bizStatus,'active');assert.equal(r.data.approvalStatus,'pending');
 assert.ok(r.data.bizValidatedAt&&r.data.bizCheckedAt);assert.ok(!JSON.stringify(r).includes(KEY));
 const v=log.find(x=>x.url.startsWith(NTS_VALIDATE_URL));
 assert.equal(v.url,`${NTS_VALIDATE_URL}?serviceKey=${encodeURIComponent(KEY)}`);
 assert.deepEqual(v.body,{businesses:[{b_no:BIZ,start_dt:'20200102',p_nm:'Synthetic Rep',b_nm:'Firm 30'}]});
 assert.equal((await call(nts({valid:'02'}))).data.bizValid,'invalid');
 assert.equal((await call(nts({valid:'03'}))).data.bizValid,'unknown');
 // validate fails → biz_valid/biz_validated_at unchanged, status still updated
 let before=await row(db,fid);
 const a=await call(nts({stt:'02',valid:null}));
 assert.equal(a.data.bizStatus,'suspended');assert.equal(a.data.bizValid,'unknown');
 let after=await row(db,fid);assert.deepEqual([after.biz_valid,after.biz_validated_at],[before.biz_valid,before.biz_validated_at]);
 // status fails → biz_status/biz_checked_at unchanged, validate still updated
 before=after;
 const b=await call(nts({stt:null,valid:'01'}));
 assert.equal(b.data.bizStatus,'suspended');assert.equal(b.data.bizValid,'valid');
 after=await row(db,fid);assert.deepEqual([after.biz_status,after.biz_checked_at],[before.biz_status,before.biz_checked_at]);
 // both fail → NETWORK_ERROR, nothing written
 before=after;
 assert.equal((await call(nts({stt:null,valid:null}))).error.code,'NETWORK_ERROR');
 assert.deepEqual(await row(db,fid),before);
 // Legacy row without rep_name/open_date: validate is skipped, status still works.
 await db.query('update public.firms set rep_name=null,open_date=null where id=$1',[fid]);
 const legacy=[];const c=await call(nts({},legacy));
 assert.equal(c.data.bizStatus,'active');assert.equal(legacy.some(x=>x.url.startsWith(NTS_VALIDATE_URL)),false);
 }finally{await db.close();}
});

test('Auto approval: off never approves; status/validate conditions; rejected and approved never change',async()=>{
 const{db,fid,call}=await setup();try{
 assert.equal((await db.query("select value from hande_private.app_settings where key='firm_auto_approve'")).rows[0].value,'off');
 // off (default): active + valid stays pending
 assert.equal((await call(nts())).data.approvalStatus,'pending');assert.equal((await row(db,fid)).approval_status,'pending');
 // validate: needs valid AND active
 await setMode(db,'validate');
 assert.equal((await call(nts({stt:'01',valid:'02'}))).data.approvalStatus,'pending');
 assert.equal((await call(nts({stt:'02',valid:'01'}))).data.approvalStatus,'pending');
 assert.equal((await call(nts({stt:'01',valid:'03'}))).data.approvalStatus,'pending');
 const ok=await call(nts({stt:'01',valid:'01'}));
 assert.equal(ok.data.approvalStatus,'approved');
 const approved=(await db.query('select reviewed_at from public.firms where id=$1',[fid])).rows[0];assert.ok(approved.reviewed_at);
 // approval notification fires through the existing trigger
 assert.equal((await db.query("select count(*)::int n from public.notifications where user_id=$1 and type='firm_reviewed'",[uid(30)])).rows[0].n,1);
 // already approved: later bad result does not auto-revoke (manual operator decision)
 assert.equal((await call(nts({stt:'03',valid:'02'}))).data.approvalStatus,'approved');

 // status: active alone is enough
 await db.query("update public.firms set approval_status='pending',reviewed_at=null where id=$1",[fid]);
 await setMode(db,'status');
 assert.equal((await call(nts({stt:'02',valid:'01'}))).data.approvalStatus,'pending');
 assert.equal((await call(nts({stt:'01',valid:'02'}))).data.approvalStatus,'approved');

 // rejected is never changed, in either mode
 for(const mode of['status','validate']){
  await setMode(db,mode);
  await db.query("update public.firms set approval_status='rejected',reject_reason='Synthetic reason' where id=$1",[fid]);
  const x=await call(nts({stt:'01',valid:'01'}));
  assert.equal(x.data.approvalStatus,'rejected');assert.equal((await row(db,fid)).approval_status,'rejected');
 }
 // unknown/missing setting behaves as off
 await db.query("update public.firms set approval_status='pending',reject_reason=null where id=$1",[fid]);
 await db.query("delete from hande_private.app_settings where key='firm_auto_approve'");
 assert.equal((await call(nts())).data.approvalStatus,'pending');
 await assert.rejects(db.query("insert into hande_private.app_settings values('firm_auto_approve','on')"),e=>e.code==='23514');
 }finally{await db.close();}
});

test('Users and service role cannot change settings or approval directly',async()=>{
 const{db,fid,admin}=await setup();try{
 await setMode(db,'status');
 await db.query("update public.firms set biz_status='active' where id=$1",[fid]);
 for(const n of[0,1,30]){
  for(const sql of["select value v from hande_private.app_settings","update hande_private.app_settings set value='status'",
   "select hande_private.try_auto_approve_firm('"+fid+"') v","select public.try_auto_approve_firm('"+fid+"') v"])
   await assert.rejects(actor(db,n,sql),e=>e.code==='42501',sql);
 }
 await reject(actor(db,30,"update public.firms set approval_status='approved'"),'permission denied for table firms');
 await reject(actor(db,30,"update public.firms set biz_valid='valid'"),'permission denied for table firms');
 assert.equal((await row(db,fid)).approval_status,'pending');
 // service role: no settings access, no approval column, only the RPC can approve
 await db.exec('begin;set local role service_role;');
 try{await assert.rejects(db.exec("update hande_private.app_settings set value='status'"),e=>e.code==='42501');}finally{await db.exec('rollback');}
 assert.equal((await admin.from('firms').update({approval_status:'approved'}).eq('id',fid).select('id').maybeSingle()).error.code,'42501');
 assert.equal((await admin.from('firms').update({reviewed_at:new Date().toISOString()}).eq('id',fid).select('id').maybeSingle()).error.code,'42501');
 const viaRpc=await admin.rpc('try_auto_approve_firm',{firm_id:fid});
 assert.equal(viaRpc.data.approval_status,'approved');
 assert.equal((await db.query("select value from hande_private.app_settings where key='firm_auto_approve'")).rows[0].value,'status');
 }finally{await db.close();}
});

test('Data module: createFirmApplication repName/openDate, optional lawyers, verifyBusiness extended',async()=>{
 const calls=[];
 const supabase={auth:{getSession:async()=>({data:{session:{}},error:null})},
  rpc:async(name,args)=>{calls.push([name,args]);return{data:{id:'f',firm_name:'F',rep_name:'R',open_date:'2020-01-02',approval_status:'pending',biz_status:'unchecked',biz_valid:'unchecked',reject_reason:null},error:null};},
  functions:{invoke:async()=>({data:{data:{firmId:'f',bizStatus:'active',bizCheckedAt:'t',bizValid:'valid',bizValidatedAt:'t',approvalStatus:'approved'}},error:null})}};
 const api=createBackendClient(supabase);
 const f=await api.createFirmApplication({firmName:'F',bizNo:'0000000001',certPath:'p',repName:'R',openDate:'2020-01-02'});
 assert.deepEqual(calls.at(-1),['create_firm_application',{firm_name:'F',biz_no:'0000000001',cert_path:'p',rep_name:'R',open_date:'2020-01-02',lawyers:[]}]);
 assert.deepEqual(f.data,{id:'f',firmName:'F',repName:'R',openDate:'2020-01-02',approvalStatus:'pending',bizStatus:'unchecked',bizValid:'unchecked',rejectReason:null});
 await api.createFirmApplication({firmName:'F',bizNo:'0000000001',certPath:'p',repName:'R',openDate:'2020-01-02',lawyers:[{name:'L',regNo:'1'}]});
 assert.deepEqual(calls.at(-1)[1].lawyers,[{name:'L',regNo:'1'}]);
 const v=await api.verifyBusiness();
 assert.deepEqual(v,{data:{firmId:'f',bizStatus:'active',bizCheckedAt:'t',bizValid:'valid',bizValidatedAt:'t',approvalStatus:'approved'}});
});
