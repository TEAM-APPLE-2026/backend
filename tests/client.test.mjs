import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackendClient } from '../src/data/client.mjs';
import { database } from './support/database.mjs';

test('Auth mapping: email confirmation, login failure, logout, unimplemented terms',async()=>{
 const client=createBackendClient({auth:{
  signUp:async()=>({data:{user:{id:'example'},session:null},error:null}),
  signInWithPassword:async()=>({error:{code:'invalid_credentials',message:'private server detail'}}),
  signOut:async input=>{assert.equal(input.scope,'local');return {error:null};},
 },rpc:()=>{throw Error('must not persist unsupported terms');}});
 assert.equal((await client.signUp({email:'synthetic@example.invalid',password:'synthetic'})).data.requiresEmailConfirmation,true);
 assert.equal((await client.signIn({email:'x',password:'y'})).error.code,'LOGIN_FAILED');
 assert.deepEqual(await client.signOut(),{data:{signedOut:true}});
 assert.equal((await client.completeSignup({terms:[]})).error.code,'INVALID_INPUT');
});
test('RPC errors are sanitized and transient exceptions become NETWORK_ERROR',async()=>{
 for(const [error,code] of [
  [{code:'P0001',message:'PROFILE_INCOMPLETE'},'PROFILE_INCOMPLETE'],
  [{code:'P0001',message:'NOT_FOUND'},'NOT_FOUND'],
  [{code:'PGRST301',message:'private token'},'AUTH_REQUIRED'],
  [{code:'42501',message:'private SQL'},'FORBIDDEN'],
  [{code:'XX000',message:'private raw text'},'INTERNAL_ERROR'],
 ]){
  const result=await createBackendClient({rpc:async()=>({error})}).getMyProfile();
  assert.equal(result.error.code,code);assert.ok(!result.error.message.includes('private'));
 }
 const result=await createBackendClient({rpc:async()=>{throw new TypeError('fetch failed');}}).getMyProfile();
 assert.equal(result.error.code,'NETWORK_ERROR');
});
test('JS adapter + real PostgreSQL: signup, get profile, save, edit, confirm, cross-user deny',async()=>{
 const {db}=await database();
 const a='33000000-0000-4000-8000-000000000001',b='33000000-0000-4000-8000-000000000002';
 await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)',[a,'adapter-a@example.invalid',b,'adapter-b@example.invalid']);
 let caller=a;
 const names={complete_signup:['role','nickname','real_name','phone'],get_my_profile:[],
  save_report:['raw_text','fields','report_id'],get_report:['report_id'],finalize_report:['report_id']};
 const client=createBackendClient({rpc:async(name,args)=>{
  const keys=names[name];assert.ok(keys);
  await db.exec('begin; set local role authenticated;');
  try{
   await db.query("select set_config('request.jwt.claim.sub',$1,true)",[caller]);
   const values=keys.map(k=>k==='fields'?JSON.stringify(args[k]):args[k]);
   const row=(await db.query(`select public.${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)).rows[0];
   await db.exec('commit;');return {data:row.result,error:null};
  }catch(e){await db.exec('rollback;');return {error:{code:e.code,message:e.message}};}
 }});
 try{
  assert.equal((await client.getMyProfile()).error.code,'PROFILE_INCOMPLETE');
  assert.equal((await client.completeSignup({role:'user',nickname:'A',realName:'Synthetic A',phone:'010-0000-0001'})).data.id,a);
  const profile=(await client.getMyProfile()).data;assert.equal(profile.phone,'01000000001');assert.equal(profile.firm,null);
  const fields=['company','type','notice_date','leaked','secondary','card'].map((key,i)=>({key,
   aiValue:['Example Co','privacy_leak',{from:null,to:null,precision:'unknown'},['name'],'unknown','no'][i],
   quote:null,userValue:null,source:'ai',needsCheck:false}));
  const saved=await client.saveReport({rawText:'Example Co incident',fields});assert.ok(saved.data?.reportId,JSON.stringify(saved));
  const reportId=saved.data.reportId;
  assert.equal((await client.getReport({reportId})).data.rawText,'Example Co incident');
  fields[0]={...fields[0],source:'user',userValue:'Corrected Co'};
  assert.equal((await client.saveReport({reportId,rawText:'Example Co incident',fields})).data.status,'organized');
  assert.ok((await client.finalizeReport({reportId})).data.finalizedAt);
  assert.equal((await client.saveReport({reportId,rawText:'Example Co incident',fields})).error.code,'CONFLICT');
  caller=b;
  assert.equal((await client.getReport({reportId})).error.code,'NOT_FOUND');
  assert.equal((await client.completeSignup({role:'user',nickname:'B',realName:'Synthetic B',phone:'01000000002'})).data.id,b);
  assert.equal((await client.finalizeReport({reportId})).error.code,'NOT_FOUND');
 }finally{await db.close();}
});
test('No session routes to login without attempting an anonymous RPC',async()=>{
 const client=createBackendClient({auth:{getSession:async()=>({data:{session:null},error:null})},
  rpc:()=>{throw Error('anonymous RPC must not run');}});
 assert.equal((await client.getMyProfile()).error.code,'AUTH_REQUIRED');
});
test('Workflow adapters: anonymous public reads, nested snake_case mapping and firm profile approval refresh',async()=>{
 const calls=[];
 const client=createBackendClient({auth:{getSession:async()=>({data:{session:{access_token:'synthetic'}},error:null})},
  rpc:async(name,args)=>{
   calls.push({name,args});
   const data={
    get_my_profile:{profile:{id:'firm-user',role:'firm',nickname:'Firm'},real_name:null,phone:null},
    get_my_firm:{id:'firm',firm_name:'Synthetic firm',approval_status:'pending',biz_status:'unchecked',reject_reason:null},
    get_vote_summary:{poll_id:'poll',options:[{option_id:'option',label:'Firm',vote_count:2,proposal_id:'proposal',method_code:null,candidate_user_id:null}],my_option_id:'option',winner_option_id:null},
    save_report:{report_id:'report',status:'draft',updated_at:'time'},
   }[name];return{data,error:null};
  }});
 assert.equal((await client.getMyProfile()).data.firm.approvalStatus,'pending');
 const summary=(await client.getVoteSummary({pollId:'poll'})).data;
 assert.equal(summary.options[0].voteCount,2);assert.equal(summary.myOptionId,'option');
 assert.deepEqual(summary.options[0],{optionId:'option',label:'Firm',voteCount:2,proposalId:'proposal',methodCode:null,candidateUserId:null});
 assert.deepEqual(calls.at(-1),{name:'get_vote_summary',args:{poll_id:'poll'}});
 const anon=createBackendClient({auth:{getSession:async()=>{throw Error('public read must not require a session');}},
  rpc:async(name,args)=>({data:{items:[{id:'g',harm_type:'privacy_leak',member_count:10}],next_cursor:null},error:null})});
 assert.equal((await anon.listGroups()).data.items[0].memberCount,10);
});
