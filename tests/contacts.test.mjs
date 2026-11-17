import{test}from'node:test';import assert from'node:assert/strict';
import{database}from'./support/database.mjs';import{actor,users,report,group,uid,reject}from'./support/actors.mjs';import{firm,proposal}from'./support/firms.mjs';
test('Contacts: only selected approved firm sees consenting active members, revoke and profile edits remove access',async()=>{
 const{db}=await database();try{
 await users(db,3);const gid=await group(db);await actor(db,2,'select public.join_group($1,$2)v',[gid,await report(db,2)]);
 const f1=await firm(db,30),f2=await firm(db,31,'0000000002');
 await db.query("update public.firms set approval_status='approved',biz_status='active'where id=any($1::uuid[])",[[f1,f2]]);
 await db.query("update public.groups set method='suit',status='connecting',sub_status='proposal_collection',proposal_deadline=now()+interval '1 day'where id=$1",[gid]);
 const pr=await actor(db,30,'select public.submit_proposal($1,$2::jsonb)v',[gid,JSON.stringify(proposal)]);
 await reject(actor(db,30,'select public.get_selected_contacts($1)v',[gid]),'FORBIDDEN');
 const pid=(await db.query("insert into public.polls(group_id,kind,round_no,opens_at,closes_at,opened_by,state)values($1,'firm',1,now()-interval '2 days',now()-interval '1 day',$2,'closed')returning id",[gid,uid(1)])).rows[0].id;
 await db.query('insert into public.group_selections(group_id,proposal_id,firm_poll_id)values($1,$2,$3)',[gid,pr.id,pid]);
 assert.equal((await actor(db,30,'select public.get_selected_contacts($1)v',[gid])).items.length,0);
 await reject(actor(db,1,"select public.grant_contact_consent($1,$2,'unregistered')v",[gid,pr.id]),'INVALID_INPUT');
 await db.exec("insert into hande_private.contact_consent_versions values('synthetic-v1',true)");
 const c=await actor(db,1,"select public.grant_contact_consent($1,$2,'synthetic-v1')v",[gid,pr.id]);
 assert.deepEqual(await actor(db,1,"select public.grant_contact_consent($1,$2,'synthetic-v1')v",[gid,pr.id]),c);
 assert.equal((await actor(db,30,'select public.get_selected_contacts($1)v',[gid])).items.length,1);
 await reject(actor(db,31,'select public.get_selected_contacts($1)v',[gid]),'FORBIDDEN');
 await actor(db,1,'select public.revoke_contact_consent($1)v',[gid]);assert.equal((await actor(db,30,'select public.get_selected_contacts($1)v',[gid])).items.length,0);
 await actor(db,1,"select public.grant_contact_consent($1,$2,'synthetic-v1')v",[gid,pr.id]);
 assert.equal((await actor(db,1,"select public.update_private_profile('Changed Synthetic','01000000009')v")).requires_reconsent,true);
 assert.equal((await actor(db,30,'select public.get_selected_contacts($1)v',[gid])).items.length,0);
 await actor(db,1,"select public.grant_contact_consent($1,$2,'synthetic-v1')v",[gid,pr.id]);
 await db.query("update public.firms set approval_status='rejected',reject_reason='Synthetic reason'where id=$1",[f1]);
 await reject(actor(db,30,'select public.get_selected_contacts($1)v',[gid]),'FIRM_NOT_APPROVED');
 const members=await actor(db,1,'select public.get_group_members($1,"limit"=>1)v',[gid]);assert.equal(members.items.length,1);assert.ok(members.next_cursor);
 assert.equal('user_id'in members.items[0],false);assert.equal('report_id'in members.items[0],false);
 const next=await actor(db,1,'select public.get_group_members($1,cursor=>$2,"limit"=>1)v',[gid,members.next_cursor]);assert.equal(next.next_cursor,null);
 await reject(actor(db,3,'select public.get_group_members($1)v',[gid]),'FORBIDDEN');
 await db.query('update public.group_members set is_rep=true where group_id=$1 and user_id=$2',[gid,uid(1)]);
 await actor(db,1,"select public.create_notice($1,'Update','Synthetic body')v",[gid]);
 assert.equal((await actor(db,2,'select public.list_notices($1)v',[gid])).items.length,1);
 await reject(actor(db,2,"select public.create_notice($1,'Fake','Fake')v",[gid]),'FORBIDDEN');
 const notifications=await actor(db,2,'select public.list_notifications()v');assert.ok(notifications.items.length>=2);
 const note=notifications.items[0].id;
 await reject(actor(db,3,'select public.mark_notification_read($1)v',[note]),'NOT_FOUND');
 const read=await actor(db,2,'select public.mark_notification_read($1)v',[note]);assert.ok(read.read_at);
 assert.deepEqual(await actor(db,2,'select public.mark_notification_read($1)v',[note]),read);
 }finally{await db.close();}
});
test('Server-only actual connection and closure: private events, no automatic connection for non-suit methods',async()=>{
 const{db}=await database();try{
 await users(db,2);const gid=await group(db);
 await db.query("update public.groups set method='med',status='connecting',sub_status='method_vote'where id=$1",[gid]);
 await reject(actor(db,1,'select public.record_group_connection($1)v',[gid]),'permission denied for function record_group_connection');
 await reject(actor(db,1,"select public.close_group($1,'done')v",[gid]),'permission denied for function close_group');
 assert.equal((await db.query('select public.record_group_connection($1)v',[gid])).rows[0].v.status,'in_progress');
 assert.equal((await db.query("select public.close_group($1,'Synthetic closure')v",[gid])).rows[0].v.status,'closed');
 await db.query("select public.close_group($1,'retry')v",[gid]);
 assert.equal((await actor(db,1,'select public.list_group_events($1)v',[gid])).items.length,2);
 await reject(actor(db,2,'select public.list_group_events($1)v',[gid]),'FORBIDDEN');
 }finally{await db.close();}
});
