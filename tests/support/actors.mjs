import assert from 'node:assert/strict';
export const uid=n=>`44000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export async function actor(db,n,sql,args=[]) {
 await db.exec(`begin; set local role ${n===0?'anon':'authenticated'};`);
 try {
  await db.query("select set_config('request.jwt.claim.sub',$1,true)",[n?uid(n):'']);
  const result=await db.query(sql,args);await db.exec('commit');return result.rows[0]?.v;
 }catch(e){await db.exec('rollback');throw e;}
}
export async function users(db,count=12){
 for(let n=1;n<=count;n++){
  await db.query('insert into auth.users(id,email) values($1,$2)',[uid(n),`workflow-${n}@example.invalid`]);
  await actor(db,n,"select public.complete_signup('user',$1,'Synthetic','01000000000') v",[`User ${n}`]);
 }
}
export const fields=()=>['company','type','notice_date','leaked','secondary','card'].map((key,i)=>({key,
 aiValue:['Example Co','privacy_leak',{from:null,to:null,precision:'unknown'},[],'unknown','no'][i],
 quote:null,userValue:null,source:'ai',needsCheck:false}));
export async function report(db,n){
 const r=await actor(db,n,'select public.save_report($1,$2::jsonb) v',['Example Co synthetic case',JSON.stringify(fields())]);
 await actor(db,n,'select public.finalize_report($1) v',[r.report_id]);return r.report_id;
}
export async function group(db,n=1){
 return (await actor(db,n,"select public.create_group($1,'Example group','Example Co','Public description') v",[await report(db,n)])).group_id;
}
export async function reject(promise,message){await assert.rejects(promise,e=>e.message===message);}
