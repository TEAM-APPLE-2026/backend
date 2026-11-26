import {actor,uid} from './actors.mjs';
export const proposal={retainerFee:10000,successFeePct:10,period:'6 months',strategy:'Synthetic plan',lawyerCount:1,leadLawyer:'Synthetic lawyer'};
export async function firm(db,n,biz='0000000001',lawyers=[{name:'Synthetic Lawyer',regNo:'TEST-1'}]){
 await db.query('insert into auth.users(id,email) values($1,$2)',[uid(n),`firm-${n}@example.invalid`]);
 await actor(db,n,"select public.complete_signup('firm',$1) v",[`Firm ${n}`]);
 await db.exec('create schema if not exists storage; create table if not exists storage.objects(bucket_id text,name text,owner_id text,metadata jsonb);');
 const path=`${uid(n)}/11111111-1111-4111-8111-111111111111.pdf`;
 await db.query('insert into storage.objects values($1,$2,$3,$4)',['firm-certs',path,uid(n),JSON.stringify({mimetype:'application/pdf',size:100})]);
 return (await actor(db,n,"select public.create_firm_application($1,$2,$3,$4,$5,$6::jsonb) v",[`Firm ${n}`,biz,path,'Synthetic Rep','2020-01-02',JSON.stringify(lawyers)])).id;
}
