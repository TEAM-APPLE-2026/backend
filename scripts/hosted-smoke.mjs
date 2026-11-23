// Explicitly opt-in against a development Supabase project only.
// Uses existing test accounts; never signs up accounts or stores credentials.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createBackendClient } from '../src/data/client.mjs';
const env=process.env;
if(env.HANDE_ALLOW_TEST_WRITES!=='yes') throw Error('Set HANDE_ALLOW_TEST_WRITES=yes for a development project only.');
for(const key of ['SUPABASE_URL','SUPABASE_ANON_KEY','TEST_USER_A_EMAIL','TEST_USER_A_PASSWORD','TEST_USER_B_EMAIL','TEST_USER_B_PASSWORD'])
 if(!env[key])throw Error(`Missing ${key}`);
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
const a=createBackendClient(createClient(env.SUPABASE_URL,env.SUPABASE_ANON_KEY,options));
const b=createBackendClient(createClient(env.SUPABASE_URL,env.SUPABASE_ANON_KEY,options));
try{
 assert.ok((await a.signIn({email:env.TEST_USER_A_EMAIL,password:env.TEST_USER_A_PASSWORD})).data,'test user A login');
 assert.ok((await b.signIn({email:env.TEST_USER_B_EMAIL,password:env.TEST_USER_B_PASSWORD})).data,'test user B login');
 const profileA=await a.getMyProfile(),profileB=await b.getMyProfile();
 assert.equal(profileA.data?.profile.role,'user','A must have a completed test profile');
 assert.equal(profileB.data?.profile.role,'user','B must have a completed test profile');
 assert.notEqual(profileA.data.profile.id,profileB.data.profile.id,'use two different accounts');
 const fields=['company','type','notice_date','leaked','secondary','card'].map((key,i)=>({key,
  aiValue:['Synthetic Example Co','privacy_leak',{from:null,to:null,precision:'unknown'},[],'unknown','no'][i],
  userValue:null,quote:null,source:'ai',needsCheck:false}));
 const result=await a.saveReport({rawText:'Synthetic Example Co: development smoke fixture.',fields});
 assert.ok(result.data?.reportId,'save failed; migration must be applied to the development project');
 const reportId=result.data.reportId;
 assert.equal((await a.getReport({reportId})).data?.fields.length,6);
 assert.equal((await b.getReport({reportId})).error?.code,'NOT_FOUND');
 assert.equal((await b.finalizeReport({reportId})).error?.code,'NOT_FOUND');
 assert.ok((await a.finalizeReport({reportId})).data?.finalizedAt);
 console.log('PASS: Auth login, profile, report save/read/confirmation and cross-user denial.');
 console.log('A synthetic confirmed report remains in the DEVELOPMENT project; remove via trusted DB admin after review.');
}finally{await a.signOut();await b.signOut();}
