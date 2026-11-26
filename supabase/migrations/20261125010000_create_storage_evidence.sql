-- Private Storage buckets, object policies and evidence registration RPCs.
-- Apply to the DEVELOPMENT project first. main deploys to the shared DB: merge only after review.
-- ready is never client-settable: evidence-confirm (Edge Function) verifies the real object first.
begin;

-- 1. Private buckets. Bucket limits use the Content-Type header; the Edge Function re-checks real bytes.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('evidences','evidences',false,10000000,array['image/jpeg','image/png','application/pdf']),
 ('firm-certs','firm-certs',false,10000000,array['image/jpeg','image/png','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

-- 2. storage.objects policies. No UPDATE policy: an uploaded (and later verified) object can never be overwritten.
-- evidences/{user_id}/{report_id}/{file_id}.{ext}: upload only for an own pending evidence row of an own report.
create policy hande_evidences_insert_own on storage.objects for insert to authenticated with check(
 bucket_id='evidences'
 and name~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$'
 and split_part(name,'/',1)=(select auth.uid())::text
 and exists(select 1 from public.reports r where r.id::text=split_part(objects.name,'/',2) and r.user_id=(select auth.uid()))
 and exists(select 1 from public.evidences e where e.bucket_id='evidences' and e.object_path=objects.name and e.status='pending'));
create policy hande_evidences_select_own on storage.objects for select to authenticated using(
 bucket_id='evidences' and split_part(name,'/',1)=(select auth.uid())::text
 and exists(select 1 from public.reports r where r.id::text=split_part(objects.name,'/',2) and r.user_id=(select auth.uid())));
-- Delete the DB row first (delete_evidence), then the object. A ready row never points to a missing object.
create policy hande_evidences_delete_own on storage.objects for delete to authenticated using(
 bucket_id='evidences' and split_part(name,'/',1)=(select auth.uid())::text
 and exists(select 1 from public.reports r where r.id::text=split_part(objects.name,'/',2) and r.user_id=(select auth.uid()))
 and not exists(select 1 from public.evidences e where e.bucket_id='evidences' and e.object_path=objects.name));
-- firm-certs/{user_id}/{file_id}.{ext}: firm accounts only, before application is allowed.
create policy hande_firm_certs_insert_own on storage.objects for insert to authenticated with check(
 bucket_id='firm-certs'
 and name~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|pdf)$'
 and split_part(name,'/',1)=(select auth.uid())::text
 and exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='firm'));
create policy hande_firm_certs_select_own on storage.objects for select to authenticated using(
 bucket_id='firm-certs' and split_part(name,'/',1)=(select auth.uid())::text);
-- A certificate referenced by the own firm application stays for operator review.
create policy hande_firm_certs_delete_own on storage.objects for delete to authenticated using(
 bucket_id='firm-certs' and split_part(name,'/',1)=(select auth.uid())::text
 and not exists(select 1 from public.firms f where f.owner_id=(select auth.uid()) and f.cert_path=objects.name));

-- 3. evidences: the Edge Function (service role) may read and set status/uploaded_at only.
revoke all on public.evidences from service_role;
grant select on public.evidences to service_role;
grant update(status,uploaded_at) on public.evidences to service_role;

create function hande_private.guard_evidence_status() returns trigger language plpgsql set search_path='' as $$
begin
 if old.status<>'pending' or new.status not in ('ready','failed') then raise exception using message='CONFLICT',errcode='P0001';end if;
 if new.id<>old.id or new.report_id<>old.report_id or new.kind<>old.kind or new.bucket_id<>old.bucket_id or new.object_path<>old.object_path
 or new.original_name<>old.original_name or new.mime_type<>old.mime_type or new.size_bytes<>old.size_bytes or new.created_at<>old.created_at
 then raise exception using message='CONFLICT',errcode='P0001';end if;
 new.uploaded_at:=case when new.status='ready' then clock_timestamp() else null end;
 return new;
end;$$;
create trigger evidences_status_guard before update on public.evidences for each row execute function hande_private.guard_evidence_status();

create function hande_private.evidence_json(eid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('evidence_id',e.id,'report_id',e.report_id,'kind',e.kind,'bucket_id',e.bucket_id,'object_path',e.object_path,
 'original_name',e.original_name,'mime_type',e.mime_type,'size_bytes',e.size_bytes,'status',e.status,'created_at',e.created_at,'uploaded_at',e.uploaded_at)
 from public.evidences e where e.id=$1
$$;

-- 4. Registration: own report → pending row → server-generated object path.
create function public.create_evidence_upload(report_id uuid,kind text,original_name text,mime_type text,size_bytes bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare eid uuid:=gen_random_uuid();ext text;lower_name text;
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 if $1 is null or not exists(select 1 from public.reports r where r.id=$1 and r.user_id=auth.uid()) then
  raise exception using message='NOT_FOUND',errcode='P0001';end if;
 ext:=case $4 when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'application/pdf' then 'pdf' end;
 lower_name:=lower(btrim(coalesce($3,'')));
 if $2 is null or $2!~'^[a-z][a-z0-9_]{0,49}$' or ext is null
 or char_length(lower_name) not between 1 and 255 or $3~'[[:cntrl:]/\\]'
 or not(case ext when 'jpg' then lower_name~'\.(jpg|jpeg)$' else lower_name like '%.'||ext end)
 or $5 is null or $5 not between 1 and 10000000 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 insert into public.evidences(id,report_id,kind,bucket_id,object_path,original_name,mime_type,size_bytes)
 values(eid,$1,$2,'evidences',auth.uid()::text||'/'||$1::text||'/'||eid::text||'.'||ext,btrim($3),$4,$5);
 return hande_private.evidence_json(eid);
end;$$;

-- 5. Delete own row and return the path; the client then removes the Storage object (retryable, orphan-safe).
create function public.delete_evidence(evidence_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.evidences%rowtype;
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 select x.* into e from public.evidences x join public.reports r on r.id=x.report_id where x.id=$1 and r.user_id=auth.uid() for update of x;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 delete from public.evidences x where x.id=e.id;
 return jsonb_build_object('evidence_id',e.id,'bucket_id',e.bucket_id,'object_path',e.object_path,'deleted_at',clock_timestamp());
end;$$;

revoke all on all functions in schema hande_private from public,anon,authenticated;
revoke all on function public.create_evidence_upload(uuid,text,text,text,bigint),public.delete_evidence(uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_evidence_upload(uuid,text,text,text,bigint),public.delete_evidence(uuid) to authenticated;
commit;
