-- Isolated development database only; all synthetic fixtures roll back.
begin;
create function pg_temp.check_true(ok boolean, label text) returns void language plpgsql as $$
begin
 if ok is distinct from true then raise exception 'FAIL: %',label; end if;
 raise notice 'PASS: %',label;
end; $$;
create function pg_temp.rejects(statement text, expected text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then
  if sqlerrm=expected or sqlstate=expected then raise notice 'PASS: rejected %',expected; return; end if;
  raise;
 end;
 raise exception 'FAIL: expected %',expected;
end; $$;
insert into auth.users(id,email) values
 ('22000000-0000-4000-8000-000000000001','report-a@example.invalid'),
 ('22000000-0000-4000-8000-000000000002','report-b@example.invalid'),
 ('22000000-0000-4000-8000-000000000003','report-firm@example.invalid'),
 ('22000000-0000-4000-8000-000000000004','report-incomplete@example.invalid');
-- Helpers use only synthetic text and transaction-local settings.
create function pg_temp.fields() returns jsonb language sql as $$
 select '[
 {"key":"company","aiValue":"Example Co","quote":"Example Co","userValue":null,"source":"ai","needsCheck":false},
 {"key":"type","aiValue":"privacy_leak","quote":null,"userValue":null,"source":"ai","needsCheck":false},
 {"key":"notice_date","aiValue":{"from":"2026-11-01","to":"2026-11-30","precision":"month"},"quote":null,"userValue":null,"source":"ai","needsCheck":false},
 {"key":"leaked","aiValue":["name"],"quote":null,"userValue":null,"source":"ai","needsCheck":false},
 {"key":"secondary","aiValue":"unknown","quote":null,"userValue":null,"source":"ai","needsCheck":false},
 {"key":"card","aiValue":"no","quote":null,"userValue":null,"source":"ai","needsCheck":false},
 {"key":"secondary_detail","aiValue":null,"quote":null,"userValue":null,"source":"ai","needsCheck":true}
 ]'::jsonb
$$;
select pg_temp.check_true((select count(*)=2 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('reports','report_fields') and c.relrowsecurity),'report RLS enabled');
set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.rejects($q$select public.save_report('Example Co','[]')$q$,'AUTH_REQUIRED');
select pg_temp.rejects($q$select public.get_report(gen_random_uuid())$q$,'AUTH_REQUIRED');
select pg_temp.rejects($q$select public.finalize_report(gen_random_uuid())$q$,'AUTH_REQUIRED');
select set_config('request.jwt.claim.sub','22000000-0000-4000-8000-000000000004',true);
select pg_temp.rejects($q$select public.save_report('Example Co','[]')$q$,'PROFILE_INCOMPLETE');
select set_config('request.jwt.claim.sub','22000000-0000-4000-8000-000000000003',true);
select public.complete_signup('firm','Example Firm');
select pg_temp.rejects($q$select public.save_report('Example Co','[]')$q$,'FORBIDDEN');
select set_config('request.jwt.claim.sub','22000000-0000-4000-8000-000000000002',true);
select public.complete_signup('user','B','Synthetic B','01000000002');
select set_config('request.jwt.claim.sub','22000000-0000-4000-8000-000000000001',true);
select public.complete_signup('user','A','Synthetic A','01000000001');
select pg_temp.check_true(public.get_my_profile()->'profile'->>'role'='user','profile RPC linked to reports');
select set_config('test.draft_id',public.save_report('Example Co incident','[]')->>'report_id',true);
select pg_temp.check_true(public.get_report(current_setting('test.draft_id')::uuid)->>'status'='draft','raw-only draft round trip');
select pg_temp.rejects($q$select public.finalize_report(current_setting('test.draft_id')::uuid)$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('', '[]')$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report(repeat('가',2001), '[]')$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('x', '{}')$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('x', '[1]')$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('x', '[{"key":"company"}]')$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co', pg_temp.fields()||jsonb_build_array(pg_temp.fields()->0))$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('x', pg_temp.fields())$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co',jsonb_set(pg_temp.fields(),'{0,key}','"warnings"'))$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co',jsonb_set(pg_temp.fields(),'{0,extra}','true'))$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co',jsonb_set(pg_temp.fields(),'{1,aiValue}','"phishing"'))$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co',jsonb_set(pg_temp.fields(),'{2,aiValue,from}','"2026-02-30"'))$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co',jsonb_set(pg_temp.fields(),'{2,aiValue,to}','"2026-11-15"'))$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co',jsonb_set(pg_temp.fields(),'{3,aiValue}','[1]'))$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co',jsonb_set(pg_temp.fields(),'{4,aiValue}','"maybe"'))$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co',jsonb_set(pg_temp.fields(),'{0,source}','"user"'))$q$,'INVALID_INPUT');
select pg_temp.rejects($q$select public.save_report('Example Co',jsonb_set(pg_temp.fields(),'{0,aiValue}','null'))$q$,'INVALID_INPUT');
select pg_temp.check_true((select count(*)=1 from public.reports),'invalid inputs create no partial rows');
select set_config('test.ready_id',public.save_report('Example Co incident',pg_temp.fields())->>'report_id',true);
select pg_temp.check_true(public.get_report(current_setting('test.ready_id')::uuid)->>'status'='organized','all six reviewed fields organized; optional null detail allowed');
select pg_temp.check_true(public.get_report(current_setting('test.ready_id')::uuid)->>'finalized_at' is null,'organized is not explicit confirmation');
select pg_temp.rejects($q$select public.save_report('Example Co incident',jsonb_set(pg_temp.fields(),'{0,aiValue}','"tampered"'),current_setting('test.ready_id')::uuid)$q$,'CONFLICT');
select pg_temp.rejects($q$select public.save_report('Example Co incident',jsonb_set(pg_temp.fields(),'{0,quote}','null'),current_setting('test.ready_id')::uuid)$q$,'CONFLICT');
select public.save_report('Example Co incident',
 jsonb_set(jsonb_set(pg_temp.fields(),'{0,source}','"user"'),'{0,userValue}','"Corrected Co"'),current_setting('test.ready_id')::uuid);
select pg_temp.check_true((select ai_value='"Example Co"'::jsonb and user_value='"Corrected Co"'::jsonb
 from public.report_fields where report_id=current_setting('test.ready_id')::uuid and key='company'),'user correction retains original AI value');
select pg_temp.rejects($q$select public.save_report('Example Co incident', '[]',current_setting('test.ready_id')::uuid)$q$,'CONFLICT');
select set_config('test.finalized',public.finalize_report(current_setting('test.ready_id')::uuid)->>'finalized_at',true);
select pg_temp.check_true(public.finalize_report(current_setting('test.ready_id')::uuid)->>'finalized_at'=current_setting('test.finalized'),'confirmation retry is idempotent');
select pg_temp.rejects($q$select public.save_report('Example Co incident',pg_temp.fields(),current_setting('test.ready_id')::uuid)$q$,'CONFLICT');
select public.save_report('Changed text','[]',current_setting('test.draft_id')::uuid);
select pg_temp.check_true(public.get_report(current_setting('test.draft_id')::uuid)->'fields'='[]'::jsonb,'changed raw text clears extraction');
select pg_temp.rejects($q$insert into public.reports(user_id,raw_text) values(auth.uid(),'bypass')$q$,'42501');
select pg_temp.rejects($q$update public.reports set status='submitted'$q$,'42501');
select pg_temp.rejects($q$delete from public.report_fields$q$,'42501');
select set_config('request.jwt.claim.sub','22000000-0000-4000-8000-000000000002',true);
select pg_temp.check_true((select count(*)=0 from public.reports),'other owner reports hidden');
select pg_temp.check_true((select count(*)=0 from public.report_fields),'other owner fields hidden');
select pg_temp.rejects($q$select public.get_report(current_setting('test.ready_id')::uuid)$q$,'NOT_FOUND');
select pg_temp.rejects($q$select public.finalize_report(current_setting('test.ready_id')::uuid)$q$,'NOT_FOUND');
select pg_temp.rejects($q$select public.save_report('x','[]',current_setting('test.ready_id')::uuid)$q$,'NOT_FOUND');
select pg_temp.rejects($q$select public.get_report('99999999-0000-4000-8000-000000000000')$q$,'NOT_FOUND');
reset role;
set local role anon;
select pg_temp.rejects('select * from public.reports','42501');
select pg_temp.rejects('select * from public.report_fields','42501');
select pg_temp.rejects($q$select public.save_report('x','[]')$q$,'42501');
select pg_temp.rejects($q$select public.get_report(gen_random_uuid())$q$,'42501');
select pg_temp.rejects($q$select public.finalize_report(gen_random_uuid())$q$,'42501');
reset role;
rollback;
