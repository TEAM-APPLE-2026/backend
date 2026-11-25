// Same cases as apple_frontend tests/auth-errors.test.mjs (client.mjs is kept identical in both repos).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBackendClient} from '../src/data/client.mjs';
const client=(error)=>createBackendClient({auth:{signUp:async()=>({data:null,error}),signInWithPassword:async()=>({data:null,error})}});
test('Auth errors explain invalid email and rate limits without echoing raw provider details',async()=>{
 for(const [error,code] of [
  [{code:'email_address_invalid'},'INVALID_EMAIL'],[{code:'email_address_not_authorized'},'INVALID_EMAIL'],
  [{code:'over_email_send_rate_limit',status:429},'AUTH_RATE_LIMIT'],[{code:'over_request_rate_limit'},'AUTH_RATE_LIMIT'],
  [{code:'unrecognized_provider_code',status:429},'AUTH_RATE_LIMIT'],[{code:'weak_password'},'WEAK_PASSWORD'],
  [{code:'user_already_exists'},'ACCOUNT_EXISTS'],[{code:'signup_disabled'},'EMAIL_SIGNUP_DISABLED']
 ]){
  const response=await client({...error,message:'RAW_PRIVATE_MARKER'}).signUp({email:'synthetic@example.invalid',password:'synthetic-only'});
  assert.equal(response.error.code,code);assert.ok(!JSON.stringify(response).includes('RAW_PRIVATE_MARKER'));
 }
 assert.equal((await client({code:'invalid_credentials'}).signIn({email:'synthetic@example.invalid',password:'synthetic-only'})).error.code,'LOGIN_FAILED');
 assert.equal((await client({code:'unknown',message:'RAW_PRIVATE_MARKER'}).signUp({email:'synthetic@example.invalid',password:'synthetic-only'})).error.code,'INTERNAL_ERROR');
});
