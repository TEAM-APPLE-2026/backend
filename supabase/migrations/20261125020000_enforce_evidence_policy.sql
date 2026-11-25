-- Agreed review policies. Do not edit the already applied Storage migration.
-- The 10-row cap includes pending/ready/failed; deleting a failed row frees a slot.
-- Historical kinds are retained; new registrations accept only the four agreed values.
begin;
create or replace function public.create_evidence_upload(report_id uuid,kind text,original_name text,mime_type text,size_bytes bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare eid uuid:=gen_random_uuid();ext text;lower_name text;
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 perform 1 from public.reports r where r.id=$1 and r.user_id=auth.uid() for update;
 if not found then
  raise exception using message='NOT_FOUND',errcode='P0001';end if;
 ext:=case $4 when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'application/pdf' then 'pdf' end;
 lower_name:=lower(btrim(coalesce($3,'')));
 if $2 is null or $2 not in ('notice','smishing','payment','other') or ext is null
 or char_length(lower_name) not between 1 and 255 or $3~'[[:cntrl:]/\\]'
 or not(case ext when 'jpg' then lower_name~'\.(jpg|jpeg)$' else lower_name like '%.'||ext end)
 or $5 is null or $5 not between 1 and 10000000 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 -- Locking the parent report serializes registrations, deletion and group submission.
 if (select count(*) from public.evidences x where x.report_id=$1)>=10 then
  raise exception using message='CONFLICT',errcode='P0001';end if;
 insert into public.evidences(id,report_id,kind,bucket_id,object_path,original_name,mime_type,size_bytes)
 values(eid,$1,$2,'evidences',auth.uid()::text||'/'||$1::text||'/'||eid::text||'.'||ext,btrim($3),$4,$5);
 return hande_private.evidence_json(eid);
end;$$;

-- 5. Delete own row and return the path; the client then removes the Storage object (retryable, orphan-safe).
create or replace function public.delete_evidence(evidence_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.evidences%rowtype; parent_id uuid; report_status text;
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 select x.report_id into parent_id from public.evidences x join public.reports r on r.id=x.report_id where x.id=$1 and r.user_id=auth.uid();
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 select r.status into report_status from public.reports r where r.id=parent_id and r.user_id=auth.uid() for update;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 select x.* into e from public.evidences x where x.id=$1 and x.report_id=parent_id for update;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 if report_status='submitted' and e.status='ready' then
  raise exception using message='CONFLICT',errcode='P0001';end if;
 delete from public.evidences x where x.id=e.id;
 return jsonb_build_object('evidence_id',e.id,'bucket_id',e.bucket_id,'object_path',e.object_path,'deleted_at',clock_timestamp());
end;$$;

commit;
