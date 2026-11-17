import {test} from 'node:test';import assert from 'node:assert/strict';
import {database} from './support/database.mjs';import {actor,users,group,uid,reject} from './support/actors.mjs';
import {firm,proposal} from './support/firms.mjs';
test('Firms: certificate ownership, approval separation, proposals freeze and anonymous stats',async()=>{
 const {db}=await database();try{
 await users(db,2);const gid=await group(db);const fid=await firm(db,30);
 assert.equal((await actor(db,30,'select public.get_my_firm() v')).approval_status,'pending');
 await reject(actor(db,30,'select public.submit_proposal($1,$2::jsonb) v',[gid,JSON.stringify(proposal)]),'FIRM_NOT_APPROVED');
 await db.query("update public.firms set approval_status='approved',biz_status='active',reviewed_at=now() where id=$1",[fid]);
 await reject(actor(db,30,"update public.firms set approval_status='approved'"),'permission denied for table firms');
 await db.query("update public.groups set method='suit',status='connecting',sub_status='proposal_collection',proposal_deadline=now()+interval '1 day' where id=$1",[gid]);
 const p=await actor(db,30,'select public.submit_proposal($1,$2::jsonb) v',[gid,JSON.stringify(proposal)]);
 await reject(actor(db,30,'select public.submit_proposal($1,$2::jsonb) v',[gid,JSON.stringify(proposal)]),'CONFLICT');
 assert.equal((await actor(db,1,'select public.list_proposals($1) v',[gid])).items.length,1);
 await reject(actor(db,2,'select public.list_proposals($1) v',[gid]),'FORBIDDEN');
 const stats=await actor(db,30,'select public.get_group_stats($1) v',[gid]);assert.equal(stats.member_count,1);assert.equal(stats.secondary_ratio,null);
 assert.equal('raw_text' in stats,false);assert.equal('user_id' in stats,false);
 await reject(actor(db,30,'select public.update_proposal($1,$2::jsonb) v',[p.id,JSON.stringify({...proposal,retainerFee:1.5})]),'INVALID_INPUT');
 assert.equal((await actor(db,30,'select public.withdraw_proposal($1) v',[p.id])).status,'withdrawn');
 assert.equal((await actor(db,30,'select public.update_proposal($1,$2::jsonb) v',[p.id,JSON.stringify(proposal)])).status,'submitted');
 await db.query("update public.groups set sub_status='firm_vote' where id=$1",[gid]);
 await reject(actor(db,30,'select public.withdraw_proposal($1) v',[p.id]),'PROPOSAL_CLOSED');
 await db.exec('begin;set local role service_role;');
 try{await assert.rejects(db.exec("update public.firms set approval_status='approved'"),e=>e.code==='42501');}finally{await db.exec('rollback');}
 }finally{await db.close();}
});
test('Firm application rejects foreign certificate ownership, missing MIME and oversize metadata',async()=>{
 const{db}=await database();try{
 await firm(db,30);
 await db.query('insert into auth.users(id,email)values($1,$2)',[uid(31),'certificate@example.invalid']);
 await actor(db,31,"select public.complete_signup('firm','Certificate applicant')v");
 const path=`${uid(31)}/11111111-1111-4111-8111-111111111111.pdf`;
 await db.query('insert into storage.objects values($1,$2,$3,$4)',['firm-certs',path,uid(30),JSON.stringify({mimetype:'application/pdf',size:100})]);
 const args=['Certificate applicant','0000000002',path,JSON.stringify([{name:'Synthetic',regNo:'TEST-2'}])];
 const apply=()=>actor(db,31,'select public.create_firm_application($1,$2,$3,$4::jsonb)v',args);
 await reject(apply(),'INVALID_INPUT');
 await db.query("update storage.objects set owner_id=$1,metadata='{}'where name=$2",[uid(31),path]);
 await reject(apply(),'INVALID_INPUT');
 await db.query('update storage.objects set metadata=$1 where name=$2',[JSON.stringify({mimetype:'application/pdf',size:10000001}),path]);
 await reject(apply(),'INVALID_INPUT');
 assert.equal((await actor(db,31,'select public.get_my_firm()v')),null);
 }finally{await db.close();}
});
