-- DEVELOPMENT hande_dev only. Synthetic rows and the firm_auto_approve value roll back. Never run against production.
begin;
create function pg_temp.uid(n integer) returns uuid language sql immutable as $$ select ('57000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.use_user(n integer) returns text language sql as $$ select set_config('request.jwt.claim.sub',pg_temp.uid(n)::text,true) $$;
create function pg_temp.v(k text) returns uuid language sql as $$ select current_setting('test.'||k)::uuid $$;
create function pg_temp.ok(b boolean,label text) returns void language plpgsql as $$ begin if b is distinct from true then raise exception 'FAIL: %',label; end if; end $$;
create function pg_temp.rejects(q text,expected text) returns void language plpgsql as $$ begin begin execute q; exception when others then if sqlerrm=expected or sqlstate=expected then return; end if; raise; end; raise exception 'FAIL: expected %',expected; end $$;
create function pg_temp.mode(m text) returns void language sql as $$ update hande_private.app_settings set value=m where key='firm_auto_approve' $$;
create function pg_temp.approve() returns text language sql as $$ select hande_private.try_auto_approve_firm(pg_temp.v('firm'))->>'approval_status' $$;
create function pg_temp.reset(stt text,valid text) returns void language sql as $$
 update public.firms set approval_status='pending',reject_reason=null,reviewed_at=null,biz_status=stt,biz_valid=valid where id=pg_temp.v('firm') $$;

select pg_temp.ok((select count(*)=1 from hande_private.app_settings where key='firm_auto_approve' and value in('off','validate','status')),'setting row exists');
select pg_temp.rejects($q$update hande_private.app_settings set value='on' where key='firm_auto_approve'$q$,'23514');

insert into auth.users(id,email) values(pg_temp.uid(30),'hosted-auto-firm-30@example.invalid'),(pg_temp.uid(1),'hosted-auto-user-1@example.invalid');
insert into storage.objects(bucket_id,name,owner_id,metadata)
 values('firm-certs',pg_temp.uid(30)::text||'/11111111-1111-4111-8111-111111111111.pdf',pg_temp.uid(30)::text,'{"mimetype":"application/pdf","size":100}');
set local role authenticated;
select pg_temp.use_user(1);select public.complete_signup('user','Hosted Auto User','Synthetic','01000000000');
select pg_temp.use_user(30);select public.complete_signup('firm','Hosted Auto Firm');
-- lawyers omitted → allowed
select set_config('test.firm',public.create_firm_application(firm_name=>'Hosted Auto Firm',biz_no=>'0000000057',
 cert_path=>pg_temp.uid(30)::text||'/11111111-1111-4111-8111-111111111111.pdf',rep_name=>'Synthetic Rep',open_date=>'2020-01-02')->>'id',true);
select pg_temp.ok((select public.get_my_firm()->>'biz_valid')='unchecked','biz_valid default');
-- users: no settings, no approval function, no approval/verification column writes
select pg_temp.rejects('select * from hande_private.app_settings','42501');
select pg_temp.rejects($q$select public.try_auto_approve_firm(pg_temp.v('firm'))$q$,'42501');
select pg_temp.rejects($q$update public.firms set approval_status='approved'$q$,'42501');
select pg_temp.rejects($q$update public.firms set biz_valid='valid'$q$,'42501');
reset role;
set local role anon;
select pg_temp.rejects($q$select public.try_auto_approve_firm('00000000-0000-4000-8000-000000000000')$q$,'42501');
reset role;

select pg_temp.reset('active','valid');select pg_temp.mode('off');
select pg_temp.ok(pg_temp.approve()='pending','off never approves');
select pg_temp.mode('validate');
select pg_temp.reset('active','invalid');select pg_temp.ok(pg_temp.approve()='pending','validate: invalid stays pending');
select pg_temp.reset('suspended','valid');select pg_temp.ok(pg_temp.approve()='pending','validate: suspended stays pending');
select pg_temp.reset('active','valid');select pg_temp.ok(pg_temp.approve()='approved','validate: valid+active approves');
select pg_temp.mode('status');
select pg_temp.reset('closed','valid');select pg_temp.ok(pg_temp.approve()='pending','status: closed stays pending');
select pg_temp.reset('active','unchecked');select pg_temp.ok(pg_temp.approve()='approved','status: active approves');
update public.firms set approval_status='rejected',reject_reason='Synthetic reason' where id=pg_temp.v('firm');
select pg_temp.ok(pg_temp.approve()='rejected','rejected never changes');

-- service role: RPC only, no settings or approval column access
select pg_temp.reset('active','valid');
set local role service_role;
select pg_temp.rejects('select * from hande_private.app_settings','42501');
select pg_temp.rejects($q$update public.firms set approval_status='approved' where id=pg_temp.v('firm')$q$,'42501');
select pg_temp.ok((public.try_auto_approve_firm(pg_temp.v('firm'))->>'approval_status')='approved','service role RPC approves in status mode');
reset role;
rollback;
select 'PASS: hosted firm_auto_approve off/validate/status, rejected immutable, ACLs; synthetic fixtures and setting rolled back' as result;
