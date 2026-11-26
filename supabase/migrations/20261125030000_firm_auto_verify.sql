-- Firm signup: representative name + opening date (NTS 진위확인 입력), lawyers optional.
-- 사업자 확인(biz_status/biz_valid)과 로펌 승인(approval_status)은 별개다.
-- 운영 기준은 수동 승인. firm_auto_approve 설정은 개발 프로젝트 시연용 예외이며 기본값 off.
begin;

-- Existing rows have no rep_name/open_date, so columns stay nullable; new applications require them.
alter table public.firms
 add column rep_name text check(rep_name is null or char_length(btrim(rep_name)) between 1 and 100),
 add column open_date date check(open_date is null or open_date>=date '1900-01-01'),
 add column biz_valid text not null default 'unchecked' check(biz_valid in ('unchecked','valid','invalid','unknown')),
 add column biz_validated_at timestamptz;

-- nts-verify (service role) may write only verification columns. Approval still has no column grant.
grant update(biz_valid,biz_validated_at) on public.firms to service_role;

-- Server-only settings. No grants to anon/authenticated/service_role: only the DB owner (dashboard SQL) changes values.
create table hande_private.app_settings(
 key text primary key,
 value text not null,
 check(key<>'firm_auto_approve' or value in ('off','validate','status'))
);
alter table hande_private.app_settings enable row level security;
revoke all on hande_private.app_settings from public,anon,authenticated,service_role;
insert into hande_private.app_settings(key,value) values('firm_auto_approve','off');

create or replace function hande_private.firm_json(fid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',f.id,'firm_name',f.firm_name,'rep_name',f.rep_name,'open_date',f.open_date,
 'approval_status',f.approval_status,'biz_status',f.biz_status,'biz_valid',f.biz_valid,'reject_reason',f.reject_reason)
 from public.firms f where f.id=$1
$$;

-- Old 4-argument signature is replaced (a second overload would make PostgREST named-argument calls ambiguous).
drop function public.create_firm_application(text,text,text,jsonb);
create function public.create_firm_application(firm_name text,biz_no text,cert_path text,rep_name text,open_date text,lawyers jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare fid uuid;item jsonb;object_data jsonb;object_size bigint;opened date;people jsonb:=coalesce($6,'[]'::jsonb);
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='firm') then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 if $1 is null or char_length(btrim($1)) not between 1 and 100 or $2 is null or $2!~'^[0-9]{10}$'
 or $3 is null or $3!~('^'||auth.uid()::text||'/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|pdf)$')
 or $4 is null or char_length(btrim($4)) not between 1 and 100
 or $5 is null or $5!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 or jsonb_typeof(people) is distinct from 'array' then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 begin opened:=$5::date;exception when others then raise exception using message='INVALID_INPUT',errcode='P0001';end;
 -- to_char round-trip rejects inputs PostgreSQL would normalise; opening date cannot be in the future (KST).
 if to_char(opened,'YYYY-MM-DD')<>$5 or opened<date '1900-01-01' or opened>(now() at time zone 'Asia/Seoul')::date then
 raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if jsonb_array_length(people) not between 0 and 20 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 for item in select value from jsonb_array_elements(people) loop
 if jsonb_typeof(item)<>'object' or not item ?& array['name','regNo'] or(item-array['name','regNo'])<>'{}'::jsonb
 or jsonb_typeof(item->'name')<>'string' or jsonb_typeof(item->'regNo')<>'string'
 or char_length(btrim(item->>'name')) not between 1 and 100 or char_length(btrim(item->>'regNo')) not between 1 and 100 then
 raise exception using message='INVALID_INPUT',errcode='P0001';end if;end loop;
 if exists(select 1 from jsonb_array_elements(people) x group by btrim(x->>'regNo') having count(*)>1) then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if to_regclass('storage.objects') is null then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 execute 'select to_jsonb(o) from storage.objects o where o.bucket_id=$1 and o.name=$2' into object_data using 'firm-certs',$3;
 if object_data is null or coalesce(object_data->>'owner_id',object_data->>'owner') is distinct from auth.uid()::text
 or coalesce(object_data->'metadata'->>'mimetype','') not in ('image/jpeg','image/png','application/pdf')
 or coalesce(object_data->'metadata'->>'size','')!~'^[0-9]{1,9}$' then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 object_size:=(object_data->'metadata'->>'size')::bigint;
 if object_size not between 1 and 10000000 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 insert into public.firms(owner_id,firm_name,biz_no,cert_path,rep_name,open_date) values(auth.uid(),btrim($1),$2,$3,btrim($4),opened) returning id into fid;
 insert into public.firm_lawyers(firm_id,name,reg_no) select fid,btrim(x->>'name'),btrim(x->>'regNo') from jsonb_array_elements(people)x;
 return hande_private.firm_json(fid);
exception when unique_violation then raise exception using message='CONFLICT',errcode='P0001';
end;$$;

-- Development demo exception only. off(default): never approves. status: biz_status=active. validate: biz_valid=valid and biz_status=active.
-- Only pending → approved; rejected/approved rows are never touched. Caller identity is checked by nts-verify before calling.
create function hande_private.try_auto_approve_firm(firm_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare mode text;f public.firms%rowtype;
begin
 if $1 is null then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 select s.value into mode from hande_private.app_settings s where s.key='firm_auto_approve';
 mode:=coalesce(mode,'off');
 if mode in ('status','validate') then
 update public.firms x set approval_status='approved',reviewed_at=clock_timestamp(),updated_at=clock_timestamp()
 where x.id=$1 and x.approval_status='pending' and x.biz_status='active' and(mode='status' or x.biz_valid='valid');
 end if;
 select * into f from public.firms x where x.id=$1;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 return jsonb_build_object('firm_id',f.id,'approval_status',f.approval_status,'biz_status',f.biz_status,'biz_valid',f.biz_valid);
end;$$;

-- hande_private is not exposed through PostgREST; this wrapper is the RPC entry point for the Edge Function (service role only).
create function public.try_auto_approve_firm(firm_id uuid) returns jsonb language sql security definer set search_path='' as $$
 select hande_private.try_auto_approve_firm($1)
$$;

revoke all on all functions in schema hande_private from public,anon,authenticated;
grant execute on function hande_private.try_auto_approve_firm(uuid) to service_role;
revoke all on function public.try_auto_approve_firm(uuid) from public,anon,authenticated;
grant execute on function public.try_auto_approve_firm(uuid) to service_role;
revoke all on function public.create_firm_application(text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_firm_application(text,text,text,text,text,jsonb) to authenticated;
commit;
