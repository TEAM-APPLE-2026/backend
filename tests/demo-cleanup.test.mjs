// supabase/operations/dev-demo-cleanup.sql: 시연 계정(demo-*@example.invalid)과 그 계정이 만든 그룹의 전체 흐름 데이터만 지운다.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {database} from './support/database.mjs';
import {actor,users,report,group,uid} from './support/actors.mjs';
import {firm,proposal} from './support/firms.mjs';
const due=(db,pid)=>db.query("update public.polls set opens_at=now()-interval '2 days',closes_at=now()-interval '1 day' where id=$1",[pid]);
const count=async(db,sql,args=[])=>(await db.query(`select count(*)::int n from ${sql}`,args)).rows[0].n;

test('Demo cleanup SQL removes demo accounts and demo groups through firm selection, keeping other accounts',async()=>{
 const{db}=await database();try{
  await users(db,12);
  // 1~10: 시연 피해자, 30: 시연 로펌, 31: 시연 중 직접 가입한 로펌(유지), 11: 다른 그룹 개설자(유지), 12: 무관 계정(유지)
  for(let n=1;n<=10;n++)await db.query('update auth.users set email=$2 where id=$1',[uid(n),`demo-victim-${n}@example.invalid`]);
  const gid=await group(db);
  for(let n=2;n<=10;n++)await actor(db,n,'select public.join_group($1,$2)v',[gid,await report(db,n)]);
  const other=await group(db,11);
  const rep=(await actor(db,1,"select public.open_poll($1,'representative',now()+interval '1 hour',now()+interval '2 hours')v",[gid])).poll_id;
  await actor(db,1,'select public.apply_representative($1)v',[rep]);
  await db.query("update public.polls set opens_at=now()-interval '1 second' where id=$1",[rep]);
  const ro=(await actor(db,1,'select public.get_vote_summary($1)v',[rep])).options[0].option_id;
  await actor(db,2,'select public.cast_representative_vote($1,$2)v',[rep,ro]);await due(db,rep);await db.query('select public.close_due_votes()');
  const mp=(await actor(db,1,"select public.open_poll($1,'method',now(),now()+interval '1 hour')v",[gid])).poll_id;
  await actor(db,3,"select public.cast_method_vote($1,'suit')v",[mp]);await due(db,mp);await db.query('select public.close_due_votes()');
  await actor(db,1,"select public.set_proposal_deadline($1,now()+interval '1 day')v",[gid]);
  const demoFirm=await firm(db,30,'9990000011'),liveFirm=await firm(db,31,'9990000033');
  await db.query('update auth.users set email=$2 where id=$1',[uid(30),'demo-firm-c@example.invalid']);
  await db.query("update public.firms set approval_status='approved',biz_status='active' where id=any($1::uuid[])",[[demoFirm,liveFirm]]);
  const p30=await actor(db,30,'select public.submit_proposal($1,$2::jsonb)v',[gid,JSON.stringify(proposal)]);
  await actor(db,31,'select public.submit_proposal($1,$2::jsonb)v',[gid,JSON.stringify(proposal)]);
  await db.query("update public.groups set proposal_deadline=now()-interval '1 second' where id=$1",[gid]);
  const fp=(await actor(db,1,"select public.open_poll($1,'firm',now(),now()+interval '1 hour')v",[gid])).poll_id;
  await actor(db,4,'select public.cast_firm_vote($1,$2)v',[fp,p30.id]);await due(db,fp);await db.query('select public.close_due_votes()');
  await db.exec("insert into hande_private.contact_consent_versions values('synthetic-v1',true)");
  await actor(db,4,"select public.grant_contact_consent($1,$2,'synthetic-v1')v",[gid,p30.id]);
  await actor(db,1,"select public.create_notice($1,'[예시] 공지','[예시] 본문')v",[gid]);
  assert.equal((await db.query('select status from public.groups where id=$1',[gid])).rows[0].status,'in_progress');

  await db.exec(await readFile(new URL('../supabase/operations/dev-demo-cleanup.sql',import.meta.url),'utf8'));

  assert.equal(await count(db,"auth.users where email like 'demo-%@example.invalid'"),0);
  assert.equal(await count(db,'public.profiles where id=any($1::uuid[])',[[uid(1),uid(30)]]),0);
  assert.equal(await count(db,'public.groups where id=$1',[gid]),0);
  for(const t of ['polls','poll_options','ballots','poll_results','poll_electors','representative_candidates','group_selections','group_contact_consents','proposals','notices','group_events'])
   assert.equal(await count(db,`public.${t}`),0,t);
  assert.equal(await count(db,'public.firms where id=$1',[demoFirm]),0);
  assert.equal(await count(db,'public.firms where id=$1',[liveFirm]),1,'live firm kept');
  assert.equal(await count(db,'public.groups where id=$1',[other]),1,'other group kept');
  assert.equal(await count(db,'auth.users where id=any($1::uuid[])',[[uid(11),uid(12),uid(31)]]),3);
  assert.equal(await count(db,'public.reports where user_id=$1',[uid(11)]),1);
 }finally{await db.close();}
});
