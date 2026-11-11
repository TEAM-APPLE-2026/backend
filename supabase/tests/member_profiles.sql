-- Development/test database only. Run with a trusted DB owner, never in production.
-- Fixtures and temporary helpers are rolled back. No real personal data is used.
begin;
create function pg_temp.assert_true(ok boolean, label text) returns void
language plpgsql as $$
begin
    if ok is distinct from true then raise exception 'FAIL: %', label; end if;
    raise notice 'PASS: %', label;
end;
$$;
create function pg_temp.expect_error(statement text, expected text) returns void
language plpgsql as $$
begin
    begin
        execute statement;
    exception when others then
        if sqlerrm = expected or sqlstate = expected then
            raise notice 'PASS: rejected with %', expected;
            return;
        end if;
        raise;
    end;
    raise exception 'FAIL: expected % for %', expected, statement;
end;
$$;

-- An empty development DB is assumed. UUID conflicts intentionally stop the test.
insert into auth.users (id, email) values
 ('11000000-0000-4000-8000-000000000001', 'profile-a@example.invalid'),
 ('11000000-0000-4000-8000-000000000002', 'profile-b@example.invalid'),
 ('11000000-0000-4000-8000-000000000003', 'profile-firm@example.invalid'),
 ('11000000-0000-4000-8000-000000000004', 'profile-invalid@example.invalid');

select pg_temp.assert_true(
 (select count(*) = 2 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('profiles','profiles_private') and c.relrowsecurity),
 'RLS enabled on both tables');
select pg_temp.assert_true(
 not has_function_privilege('anon','public.complete_signup(text,text,text,text)','EXECUTE')
 and not has_function_privilege('anon','public.get_my_profile()','EXECUTE'),
 'anonymous RPC execution revoked');

set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.expect_error($q$select public.complete_signup('user','A','Test A','01000000001')$q$, 'AUTH_REQUIRED');
select pg_temp.expect_error('select public.get_my_profile()', 'AUTH_REQUIRED');
select set_config('request.jwt.claim.sub','11000000-0000-4000-8000-000000000001',true);
select pg_temp.expect_error('select public.get_my_profile()', 'PROFILE_INCOMPLETE');
select pg_temp.assert_true(
 public.complete_signup('user',' Test A ','Test Person A','010-0000-0001')->>'role' = 'user',
 'create user profile');
select pg_temp.assert_true(
 public.get_my_profile()->>'phone' = '01000000001', 'normalized contact saved');
select pg_temp.assert_true(
 (public.complete_signup('user','Test A','Test Person A','01000000001')->>'id')::uuid = auth.uid(),
 'exact signup retry is idempotent');
select pg_temp.expect_error($q$select public.complete_signup('firm','Test A','Test Person A','01000000001')$q$, 'CONFLICT');
select pg_temp.expect_error($q$select public.complete_signup('user','Test A','Changed','01000000001')$q$, 'CONFLICT');
select pg_temp.expect_error($q$select public.complete_signup('admin','Test A',null,null)$q$, 'INVALID_INPUT');
select pg_temp.expect_error($q$update public.profiles set role='firm' where id=auth.uid()$q$, '42501');
select pg_temp.expect_error($q$update public.profiles set id='11000000-0000-4000-8000-000000000002' where id=auth.uid()$q$, '42501');
select pg_temp.expect_error($q$update public.profiles_private set phone='01000000009' where user_id=auth.uid()$q$, '42501');
select pg_temp.expect_error($q$delete from public.profiles where id=auth.uid()$q$, '42501');
select pg_temp.expect_error($q$insert into public.profiles(id,role,nickname) values(auth.uid(),'firm','Fake')$q$, '42501');
update public.profiles set nickname='Changed Nickname' where id=auth.uid();
select pg_temp.assert_true(
 public.get_my_profile()->'profile'->>'nickname'='Changed Nickname', 'own nickname update allowed');
select pg_temp.expect_error($q$update public.profiles set nickname='' where id=auth.uid()$q$, '23514');

select set_config('request.jwt.claim.sub','11000000-0000-4000-8000-000000000002',true);
select public.complete_signup('user','Test B','Test Person B','01000000002');
select pg_temp.assert_true((select count(*)=1 from public.profiles), 'other profiles hidden by RLS');
select pg_temp.assert_true((select count(*)=1 from public.profiles_private), 'other contacts hidden by RLS');
select pg_temp.assert_true(
 not exists(select 1 from public.profiles where id='11000000-0000-4000-8000-000000000001'),
 'explicit foreign profile lookup hidden');
update public.profiles set nickname='Unauthorized' where id='11000000-0000-4000-8000-000000000001';

select set_config('request.jwt.claim.sub','11000000-0000-4000-8000-000000000003',true);
select public.complete_signup('firm','Test Firm');
select pg_temp.assert_true(
 public.get_my_profile()->>'real_name' is null and public.get_my_profile()->'profile'->>'role'='firm',
 'firm role has no approval power and contact is optional');

select set_config('request.jwt.claim.sub','11000000-0000-4000-8000-000000000004',true);
select pg_temp.expect_error($q$select public.complete_signup('user','No Contact',null,null)$q$, 'INVALID_INPUT');
select pg_temp.expect_error($q$select public.complete_signup('user','Bad Phone','Test','abc')$q$, 'INVALID_INPUT');
select pg_temp.assert_true(not exists(select 1 from public.profiles), 'invalid signup leaves no partial profile');

reset role;
select pg_temp.assert_true(
 (select nickname='Changed Nickname' from public.profiles where id='11000000-0000-4000-8000-000000000001'),
 'foreign UPDATE did not modify target');
set local role anon;
select pg_temp.expect_error('select * from public.profiles', '42501');
select pg_temp.expect_error('select * from public.profiles_private', '42501');
select pg_temp.expect_error('select public.get_my_profile()', '42501');
reset role;
rollback;
