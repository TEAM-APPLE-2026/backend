import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './support/database.mjs';
import {actor,users,report,group,reject} from './support/actors.mjs';
test('Groups: atomic creation, private report ownership, public projection, join/leave and pagination',async()=>{
 const {db}=await database();try{
  await users(db,3);const gid=await group(db),rid=await report(db,2);
  const publicGroup=await actor(db,0,'select public.get_group($1) v',[gid]);
  assert.equal(publicGroup.member_count,1);assert.equal('created_by' in publicGroup,false);assert.equal('raw_text' in publicGroup,false);
  await reject(actor(db,3,'select public.join_group($1,$2) v',[gid,rid]),'NOT_FOUND');
  const m=await actor(db,2,'select public.join_group($1,$2) v',[gid,rid]);
  assert.deepEqual(await actor(db,2,'select public.join_group($1,$2) v',[gid,rid]),m);
  assert.equal((await actor(db,0,'select public.get_group($1) v',[gid])).member_count,2);
  await reject(actor(db,1,'select public.leave_group($1) v',[gid]),'CONFLICT');
  const left=await actor(db,2,'select public.leave_group($1) v',[gid]);assert.ok(left.left_at);
  assert.deepEqual(await actor(db,2,'select public.leave_group($1) v',[gid]),left);
  await reject(actor(db,2,'select public.join_group($1,$2) v',[gid,rid]),'CONFLICT');
  await group(db,3);
  const page=await actor(db,0,'select public.list_groups("limit"=>1) v');assert.equal(page.items.length,1);assert.ok(page.next_cursor);
  const next=await actor(db,0,'select public.list_groups(cursor=>$1,"limit"=>1) v',[page.next_cursor]);
  assert.notEqual(page.items[0].id,next.items[0].id);assert.equal(next.next_cursor,null);
  await reject(actor(db,0,"select public.list_groups(cursor=>'bad') v"),'INVALID_INPUT');
  await reject(actor(db,0,'select * from public.group_members'),'permission denied for table group_members');
  await reject(actor(db,0,'select * from public.groups'),'permission denied for table groups');
 }finally{await db.close();}
});
test('Group scope: finalized report company/type must match the group',async()=>{
 const{db}=await database();try{
 await users(db,2);const rid=await report(db,1);
 await reject(actor(db,1,"select public.create_group($1,'Mismatch','Different Co','Description')v",[rid]),'NOT_ELIGIBLE');
 assert.equal((await db.query('select count(*)::int n from public.groups')).rows[0].n,0);
 const gid=await group(db,2);
 await db.query("update public.groups set company='Different Co'where id=$1",[gid]);
 await reject(actor(db,1,'select public.join_group($1,$2)v',[gid,rid]),'NOT_ELIGIBLE');
 }finally{await db.close();}
});
