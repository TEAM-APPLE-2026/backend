import {test} from 'node:test';import assert from 'node:assert/strict';
import {createBackendClient} from '../src/data/client.mjs';

const session={getSession:async()=>({data:{session:{}},error:null})};
test('createEvidenceUpload/deleteEvidence map RPC args and remove the object after the row',async()=>{
 const calls=[];
 const client=createBackendClient({auth:session,
  rpc:async(name,args)=>{calls.push([name,args]);return name==='create_evidence_upload'
   ?{data:{evidence_id:'e',report_id:'r',kind:'screenshot',bucket_id:'evidences',object_path:'u/r/e.png',original_name:'a.png',mime_type:'image/png',size_bytes:3,status:'pending',created_at:'t',uploaded_at:null},error:null}
   :{data:{evidence_id:'e',bucket_id:'evidences',object_path:'u/r/e.png',deleted_at:'t'},error:null};},
  storage:{from:bucket=>({remove:async paths=>{calls.push(['remove',bucket,paths]);return {error:null};}})}});
 const up=await client.createEvidenceUpload({reportId:'r',kind:'screenshot',originalName:'a.png',mimeType:'image/png',sizeBytes:3});
 assert.deepEqual(calls[0],['create_evidence_upload',{report_id:'r',kind:'screenshot',original_name:'a.png',mime_type:'image/png',size_bytes:3}]);
 assert.equal(up.data.objectPath,'u/r/e.png');assert.equal(up.data.evidenceId,'e');assert.equal(up.data.status,'pending');
 assert.deepEqual(await client.deleteEvidence({evidenceId:'e'}),{data:{evidenceId:'e',deletedAt:'t',objectPath:'u/r/e.png',objectRemoved:true}});
 assert.deepEqual(calls.slice(1),[['delete_evidence',{evidence_id:'e'}],['remove','evidences',['u/r/e.png']]]);
 const failing=createBackendClient({auth:session,rpc:async()=>({data:{evidence_id:'e',bucket_id:'evidences',object_path:'p',deleted_at:'t'},error:null}),
  storage:{from:()=>({remove:async()=>{throw new TypeError('offline');}})}});
 assert.equal((await failing.deleteEvidence({evidenceId:'e'})).data.objectRemoved,false);
 const denied=createBackendClient({auth:session,rpc:async()=>({error:{code:'P0001',message:'NOT_FOUND'}}),storage:{from:()=>{throw Error('must not remove');}}});
 assert.equal((await denied.deleteEvidence({evidenceId:'e'})).error.code,'NOT_FOUND');
});

test('confirmEvidence/verifyBusiness use Edge Functions with normalized errors',async()=>{
 const invoked=[];
 const fn=result=>createBackendClient({auth:session,functions:{invoke:async(name,opts)=>{invoked.push([name,opts.body]);return result();}}});
 assert.deepEqual(await fn(()=>({data:{data:{evidenceId:'e',status:'ready',uploadedAt:'t'}},error:null})).confirmEvidence({evidenceId:'e'}),
  {data:{evidenceId:'e',status:'ready',uploadedAt:'t'}});
 assert.deepEqual(invoked.at(-1),['evidence-confirm',{evidenceId:'e'}]);
 await fn(()=>({data:{data:{}},error:null})).verifyBusiness();assert.deepEqual(invoked.at(-1),['nts-verify',{}]);
 await fn(()=>({data:{data:{}},error:null})).verifyBusiness({bizNo:'1234567890'});assert.deepEqual(invoked.at(-1),['nts-verify',{bizNo:'1234567890'}]);
 const http=(status,body)=>()=>({data:null,error:{name:'FunctionsHttpError',context:new Response(JSON.stringify(body),{status})}});
 assert.equal((await fn(http(403,{error:{code:'FORBIDDEN',message:'x'}})).verifyBusiness()).error.code,'FORBIDDEN');
 assert.equal((await fn(http(502,{error:{code:'NETWORK_ERROR'}})).verifyBusiness()).error.code,'NETWORK_ERROR');
 assert.equal((await fn(http(500,{error:{code:'RAW_SQL'}})).confirmEvidence({evidenceId:'e'})).error.code,'INTERNAL_ERROR');
 assert.equal((await fn(()=>({data:null,error:{name:'FunctionsHttpError',context:new Response('html',{status:401})}})).confirmEvidence({})).error.code,'AUTH_REQUIRED');
 assert.equal((await fn(()=>({data:null,error:{name:'FunctionsFetchError'}})).confirmEvidence({})).error.code,'NETWORK_ERROR');
 const anon=createBackendClient({auth:{getSession:async()=>({data:{session:null},error:null})},functions:{invoke:()=>{throw Error('must not call');}}});
 assert.equal((await anon.verifyBusiness()).error.code,'AUTH_REQUIRED');
});
