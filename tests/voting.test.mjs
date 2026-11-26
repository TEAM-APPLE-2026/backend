import {test}from'node:test';import assert from'node:assert/strict';
import {database}from'./support/database.mjs';import {actor,users,report,group,uid,reject}from'./support/actors.mjs';
import {firm,proposal}from'./support/firms.mjs';
async function due(db,pid){await db.query("update public.polls set opens_at=now()-interval '2 days',closes_at=now()-interval '1 day' where id=$1",[pid]);}
async function live(db,pid){await db.query("update public.polls set opens_at=now()-interval '1 second' where id=$1",[pid]);}
async function open(db,gid,kind){return(await actor(db,1,"select public.open_poll($1,$2,now()+interval '1 hour',now()+interval '2 hours')v",[gid,kind])).poll_id;}
async function elect(db){
 await users(db,12);const gid=await group(db);
 await reject(actor(db,1,"select public.open_poll($1,'representative',now()+interval '1 hour',now()+interval '2 hours')v",[gid]),'NOT_ELIGIBLE');
 for(let n=2;n<=10;n++)await actor(db,n,'select public.join_group($1,$2)v',[gid,await report(db,n)]);
 const pid=await open(db,gid,'representative');await actor(db,1,'select public.apply_representative($1)v',[pid]);await actor(db,2,'select public.apply_representative($1)v',[pid]);
 const summary=await actor(db,1,'select public.get_vote_summary($1)v',[pid]);
 const option=summary.options.find(x=>x.label==='User 1').option_id;
 for(const o of summary.options){assert.equal(o.candidate_user_id,o.label==='User 1'?uid(1):uid(2));assert.equal(o.proposal_id,null);assert.equal(o.method_code,null);}
 await reject(actor(db,1,'select public.cast_representative_vote($1,$2)v',[pid,option]),'POLL_NOT_OPEN');
 await live(db,pid);await actor(db,1,'select public.cast_representative_vote($1,$2)v',[pid,option]);
 await actor(db,1,'select public.cast_representative_vote($1,$2)v',[pid,summary.options.find(x=>x.option_id!==option).option_id]);
 await actor(db,1,'select public.cast_representative_vote($1,$2)v',[pid,option]);
 assert.equal((await actor(db,2,'select public.get_vote_summary($1)v',[pid])).total_votes,1);
 await reject(actor(db,11,'select public.cast_representative_vote($1,$2)v',[pid,option]),'FORBIDDEN');
 await reject(actor(db,2,'select public.close_vote($1)v',[pid]),'permission denied for function close_vote');
 await due(db,pid);await reject(actor(db,2,'select public.cast_representative_vote($1,$2)v',[pid,option]),'POLL_CLOSED');
 const result=(await db.query('select public.close_vote($1)v',[pid])).rows[0].v;assert.equal(result.state,'closed');
 assert.deepEqual((await db.query('select public.close_vote($1)v',[pid])).rows[0].v,result);
 assert.equal((await actor(db,1,'select public.get_my_membership($1)v',[gid])).is_rep,true);return gid;
}
test('Voting lifecycle: 10-person election, time bounds, one ballot, suit decision, firm selection and idempotent notifications',async()=>{
 const{db}=await database();try{
 const gid=await elect(db);await reject(actor(db,2,"select public.open_poll($1,'method',now(),now()+interval '1 day')v",[gid]),'FORBIDDEN');
 const mp=await open(db,gid,'method');
 const ms=await actor(db,1,'select public.get_vote_summary($1)v',[mp]);
 assert.deepEqual(ms.options.map(o=>o.method_code).sort(),['collective','consumer','med','suit']);
 assert.ok(ms.options.every(o=>o.proposal_id===null&&o.candidate_user_id===null&&o.label===o.method_code));await live(db,mp);await actor(db,1,"select public.cast_method_vote($1,'suit')v",[mp]);await due(db,mp);
 assert.equal((await db.query('select public.close_due_votes()v')).rows[0].v.processed,1);
 await actor(db,1,"select public.set_proposal_deadline($1,now()+interval '1 day')v",[gid]);
 const fid=await firm(db,30),fid2=await firm(db,31,'0000000002');
 await db.query("update public.firms set approval_status='approved',biz_status='active'where id=any($1::uuid[])",[[fid,fid2]]);
 const p1=await actor(db,30,'select public.submit_proposal($1,$2::jsonb)v',[gid,JSON.stringify(proposal)]);
 const p2=await actor(db,31,'select public.submit_proposal($1,$2::jsonb)v',[gid,JSON.stringify(proposal)]);
 await reject(actor(db,1,"select public.open_poll($1,'firm',now(),now()+interval '1 day')v",[gid]),'PROPOSAL_CLOSED');
 await db.query("update public.groups set proposal_deadline=now()-interval '1 second'where id=$1",[gid]);
 const fp=await open(db,gid,'firm');await live(db,fp);
 await reject(actor(db,30,'select public.withdraw_proposal($1)v',[p1.id]),'PROPOSAL_CLOSED');
 const before=await actor(db,2,'select public.get_vote_summary($1)v',[fp]);
 assert.deepEqual(before.options.map(o=>o.proposal_id).sort(),[p1.id,p2.id].sort());
 assert.ok(before.options.every(o=>o.method_code===null&&o.candidate_user_id===null&&o.vote_count===0));
 assert.deepEqual(Object.keys(before.options[0]).sort(),['candidate_user_id','label','method_code','option_id','proposal_id','vote_count']);
 await actor(db,1,'select public.cast_firm_vote($1,$2)v',[fp,p1.id]);
 const after=await actor(db,2,'select public.get_vote_summary($1)v',[fp]);
 assert.equal(after.total_votes,1);assert.equal(after.my_option_id,null);
 assert.equal(after.options.find(o=>o.proposal_id===p1.id).vote_count,1);
 const voted=await actor(db,1,'select public.get_vote_summary($1)v',[fp]);
 assert.equal(voted.my_option_id,voted.options.find(o=>o.proposal_id===p1.id).option_id);
 assert.equal((await actor(db,31,'select public.get_my_proposal_vote_summary($1)v',[fp])).my_vote_count,0);
 await reject(actor(db,31,'select public.get_vote_summary($1)v',[fp]),'FORBIDDEN');
 await due(db,fp);await db.query('select public.close_vote($1)',[fp]);
 const final=await actor(db,1,'select public.get_vote_summary($1)v',[fp]);
 assert.equal(final.is_finalized,true);assert.equal(final.winner_option_id,final.options.find(o=>o.proposal_id===p1.id).option_id);
 assert.equal(final.options.find(o=>o.proposal_id===p1.id).vote_count,1);assert.equal(final.options.find(o=>o.proposal_id===p2.id).vote_count,0);
 assert.equal((await db.query('select proposal_id from public.group_selections where group_id=$1',[gid])).rows[0].proposal_id,p1.id);
 const count=(await db.query('select count(*)::int n from public.notifications')).rows[0].n;
 await db.query('select public.close_vote($1)',[fp]);assert.equal((await db.query('select count(*)::int n from public.notifications')).rows[0].n,count);
 assert.equal((await actor(db,0,'select public.get_group($1)v',[gid])).status,'in_progress');
 }finally{await db.close();}
});
test('Ties and zero votes: no invented winner, new round for revote',async()=>{
 const{db}=await database();try{
 const gid=await elect(db);const pid=await open(db,gid,'method');await live(db,pid);
 await actor(db,1,"select public.cast_method_vote($1,'suit')v",[pid]);await actor(db,2,"select public.cast_method_vote($1,'med')v",[pid]);
 await due(db,pid);assert.equal((await db.query('select public.close_vote($1)v',[pid])).rows[0].v.state,'tied');
 const next=await open(db,gid,'method');await due(db,next);const r=(await db.query('select public.close_vote($1)v',[next])).rows[0].v;
 assert.equal(r.state,'no_votes');assert.equal(r.winner_option_id,null);
 assert.equal((await db.query('select round_no from public.polls where id=$1',[next])).rows[0].round_no,2);
 }finally{await db.close();}
});
test('Firm approval revoked before closing cancels selection instead of disclosing contacts',async()=>{
 const{db}=await database();try{
 const gid=await elect(db),fid=await firm(db,30);
 await db.query("update public.firms set approval_status='approved',biz_status='active'where id=$1",[fid]);
 await db.query("update public.groups set method='suit',sub_status='proposal_collection',proposal_deadline=now()+interval '1 day'where id=$1",[gid]);
 const p=await actor(db,30,'select public.submit_proposal($1,$2::jsonb)v',[gid,JSON.stringify(proposal)]);
 await db.query("update public.groups set proposal_deadline=now()-interval '1 second'where id=$1",[gid]);
 const pid=await open(db,gid,'firm');await live(db,pid);await actor(db,1,'select public.cast_firm_vote($1,$2)v',[pid,p.id]);
 await db.query("update public.firms set approval_status='rejected',reject_reason='Synthetic rejection'where id=$1",[fid]);
 await due(db,pid);assert.equal((await db.query('select public.close_vote($1)v',[pid])).rows[0].v.state,'cancelled');
 assert.equal((await db.query('select count(*)::int n from public.group_selections where group_id=$1',[gid])).rows[0].n,0);
 }finally{await db.close();}
});
