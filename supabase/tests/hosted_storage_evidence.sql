-- DEVELOPMENT hande_dev only. Synthetic rows and Storage metadata roll back. Never run against production.
-- Storage DELETE is checked by the local PGlite suite; on hosted Storage, deletes go through the Storage API.
begin;
create function pg_temp.uid(n integer) returns uuid language sql immutable as $$ select ('56000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.use_user(n integer) returns text language sql as $$ select set_config('request.jwt.claim.sub',pg_temp.uid(n)::text,true) $$;
create function pg_temp.v(k text) returns text language sql as $$ select current_setting('test.'||k) $$;
create function pg_temp.ok(b boolean,label text) returns void language plpgsql as $$ begin if b is distinct from true then raise exception 'FAIL: %',label; end if; end $$;
create function pg_temp.rejects(q text,expected text) returns void language plpgsql as $$ begin begin execute q; exception when others then if sqlerrm=expected or sqlstate=expected then return; end if; raise; end; raise exception 'FAIL: expected %',expected; end $$;
create function pg_temp.fields() returns jsonb language sql as $$ select '[{"key":"company","aiValue":"Hosted Synthetic Co","quote":null,"userValue":null,"source":"ai","needsCheck":false},{"key":"type","aiValue":"privacy_leak","quote":null,"userValue":null,"source":"ai","needsCheck":false},{"key":"notice_date","aiValue":{"from":null,"to":null,"precision":"unknown"},"quote":null,"userValue":null,"source":"ai","needsCheck":false},{"key":"leaked","aiValue":[],"quote":null,"userValue":null,"source":"ai","needsCheck":false},{"key":"secondary","aiValue":"unknown","quote":null,"userValue":null,"source":"ai","needsCheck":false},{"key":"card","aiValue":"no","quote":null,"userValue":null,"source":"ai","needsCheck":false}]'::jsonb $$;

select pg_temp.ok((select count(*)=2 from storage.buckets where id in('evidences','firm-certs') and public=false and file_size_limit=10000000
 and allowed_mime_types @> array['image/jpeg','image/png','application/pdf'] and cardinality(allowed_mime_types)=3),'private buckets');

insert into auth.users(id,email) select pg_temp.uid(n),'hosted-storage-'||n||'@example.invalid' from generate_series(1,2)n;
insert into auth.users(id,email) values(pg_temp.uid(30),'hosted-storage-firm-30@example.invalid');
set local role authenticated;
do $$ declare n integer;r jsonb; begin for n in 1..2 loop
 perform pg_temp.use_user(n); perform public.complete_signup('user','Hosted Storage '||n,'Synthetic','01000000000');
 r:=public.save_report('Hosted Synthetic Co: storage test only.',pg_temp.fields());
 perform set_config('test.report'||n,r->>'report_id',true);
end loop;
 perform pg_temp.use_user(30); perform public.complete_signup('firm','Hosted Storage Firm');
end $$;

select pg_temp.use_user(1);
select set_config('test.path',public.create_evidence_upload(pg_temp.v('report1')::uuid,'screenshot','a.png','image/png',16)->>'object_path',true);
select set_config('test.eid',(select id::text from public.evidences where object_path=pg_temp.v('path')),true);
select pg_temp.ok(pg_temp.v('path')=pg_temp.uid(1)::text||'/'||pg_temp.v('report1')||'/'||pg_temp.v('eid')||'.png','server path');
select pg_temp.rejects($q$update public.evidences set status='ready'$q$,'42501');
select pg_temp.use_user(2);
select pg_temp.rejects($q$select public.create_evidence_upload(pg_temp.v('report1')::uuid,'screenshot','a.png','image/png',16)$q$,'NOT_FOUND');
select pg_temp.rejects($q$insert into storage.objects(bucket_id,name,owner_id,metadata) values('evidences',pg_temp.v('path'),pg_temp.uid(2)::text,'{}')$q$,'42501');
select pg_temp.use_user(30);
select pg_temp.rejects($q$insert into storage.objects(bucket_id,name,owner_id,metadata) values('evidences',pg_temp.v('path'),pg_temp.uid(30)::text,'{}')$q$,'42501');
select pg_temp.use_user(1);
select pg_temp.rejects($q$insert into storage.objects(bucket_id,name,owner_id,metadata) values('evidences',pg_temp.uid(1)::text||'/'||pg_temp.v('report2')||'/'||pg_temp.v('eid')||'.png',pg_temp.uid(1)::text,'{}')$q$,'42501');
select pg_temp.rejects($q$insert into storage.objects(bucket_id,name,owner_id,metadata) values('evidences',pg_temp.uid(1)::text||'/'||pg_temp.v('report1')||'/11111111-1111-4111-8111-111111111111.png',pg_temp.uid(1)::text,'{}')$q$,'42501');
insert into storage.objects(bucket_id,name,owner_id,metadata) values('evidences',pg_temp.v('path'),pg_temp.uid(1)::text,'{"size":16,"mimetype":"image/png"}');
select pg_temp.ok((select count(*)=1 from storage.objects where bucket_id='evidences' and name=pg_temp.v('path')),'owner reads own object');
do $$ declare c integer; begin update storage.objects set metadata='{}' where bucket_id='evidences' and name=pg_temp.v('path'); get diagnostics c=row_count; perform pg_temp.ok(c=0,'no overwrite'); end $$;
select pg_temp.use_user(2);
select pg_temp.ok((select count(*)=0 from storage.objects where bucket_id='evidences'),'other user reads nothing');
select pg_temp.rejects($q$select public.delete_evidence(pg_temp.v('eid')::uuid)$q$,'NOT_FOUND');
select pg_temp.use_user(30);
select pg_temp.ok((select count(*)=0 from storage.objects where bucket_id='evidences'),'firm reads no evidence');
insert into storage.objects(bucket_id,name,owner_id,metadata) values('firm-certs',pg_temp.uid(30)::text||'/22222222-2222-4222-8222-222222222222.pdf',pg_temp.uid(30)::text,'{}');
select pg_temp.use_user(1);
select pg_temp.ok((select count(*)=0 from storage.objects where bucket_id='firm-certs'),'user reads no certificate');
select pg_temp.rejects($q$insert into storage.objects(bucket_id,name,owner_id,metadata) values('firm-certs',pg_temp.uid(1)::text||'/22222222-2222-4222-8222-222222222222.pdf',pg_temp.uid(1)::text,'{}')$q$,'42501');
select pg_temp.ok((public.delete_evidence(pg_temp.v('eid')::uuid)->>'object_path')=pg_temp.v('path'),'own delete');
reset role;
-- Service role: status/uploaded_at only (column privileges).
select pg_temp.ok(not has_column_privilege('service_role','public.evidences','size_bytes','UPDATE') and has_column_privilege('service_role','public.evidences','status','UPDATE'),'service role evidences columns');
select pg_temp.ok(not has_column_privilege('service_role','public.firms','approval_status','UPDATE') and has_column_privilege('service_role','public.firms','biz_status','UPDATE'),'service role firm columns');
select 'PASS: hosted storage buckets, object policies and evidence RPCs (rolled back)' result;
rollback;
