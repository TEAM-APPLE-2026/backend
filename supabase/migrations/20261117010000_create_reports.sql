-- Reports are private. This migration does not deploy Storage, groups or AI execution.
begin;

create function hande_private.valid_report_value(field_key text, value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare a date; b date; precision_value text;
begin
    if value is null then return true; end if;
    if field_key in ('company', 'secondary_detail') then
        return jsonb_typeof(value) = 'string'
            and char_length(btrim(value #>> '{}')) between 1 and
                case when field_key = 'company' then 200 else 1000 end;
    elsif field_key = 'type' then return value = '"privacy_leak"'::jsonb;
    elsif field_key in ('secondary', 'card') then
        return value in ('"yes"'::jsonb, '"no"'::jsonb, '"unknown"'::jsonb);
    elsif field_key = 'leaked' then
        if jsonb_typeof(value) <> 'array' then return false; end if;
        return jsonb_array_length(value) <= 30 and not exists (
            select 1 from jsonb_array_elements(value) as v(item)
            where jsonb_typeof(item) <> 'string'
               or char_length(btrim(item #>> '{}')) not between 1 and 100);
    elsif field_key = 'notice_date' then
        if jsonb_typeof(value) <> 'object' or not value ?& array['from','to','precision']
           or (value - array['from','to','precision']) <> '{}'::jsonb then return false; end if;
        precision_value := value->>'precision';
        if precision_value = 'unknown' then
            return value->'from' = 'null'::jsonb and value->'to' = 'null'::jsonb;
        end if;
        if precision_value is null or precision_value not in ('day','month','year')
           or jsonb_typeof(value->'from') <> 'string' or jsonb_typeof(value->'to') <> 'string'
           or (value->>'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           or (value->>'to') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
        a := (value->>'from')::date; b := (value->>'to')::date;
        if a > b then return false; end if;
        return case precision_value
            when 'day' then a = b
            when 'month' then a = date_trunc('month', a)::date
                and b = (a + interval '1 month - 1 day')::date
            when 'year' then a = date_trunc('year', a)::date
                and b = (a + interval '1 year - 1 day')::date
            else false end;
    end if;
    return false;
exception when invalid_datetime_format or datetime_field_overflow then return false;
end;
$$;
revoke all on function hande_private.valid_report_value(text,jsonb) from public,anon,authenticated;

create table public.reports (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles(id) on delete restrict,
    raw_text text not null check (char_length(btrim(raw_text)) between 1 and 2000
                                and char_length(raw_text) <= 2000),
    status text not null default 'draft' check (status in ('draft','organized','submitted')),
    finalized_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(id,user_id),
    check (finalized_at is null or status in ('organized','submitted'))
);
create index reports_owner_created on public.reports(user_id,created_at desc,id desc);
create table public.report_fields (
    report_id uuid not null references public.reports(id) on delete cascade,
    key text not null check (key in ('company','type','notice_date','leaked','secondary','secondary_detail','card')),
    ai_value jsonb,
    quote text check (char_length(quote) between 1 and 2000),
    user_value jsonb,
    source text not null check (source in ('ai','user')),
    needs_check boolean not null default true,
    updated_at timestamptz not null default now(),
    primary key(report_id,key),
    check (ai_value is null or ai_value <> 'null'::jsonb),
    check (user_value is null or user_value <> 'null'::jsonb),
    check (source <> 'user' or user_value is not null),
    check (source <> 'ai' or user_value is null),
    check (needs_check or coalesce(case when source='user' then user_value else ai_value end is not null,false)),
    check (hande_private.valid_report_value(key,ai_value)),
    check (hande_private.valid_report_value(key,user_value))
);
comment on column public.reports.finalized_at is 'Explicit owner confirmation; organized alone is not confirmation.';
comment on table public.report_fields is 'Client-supplied AI suggestions, not verified facts. Private owner-only evidence.';
alter table public.reports enable row level security;
alter table public.report_fields enable row level security;
revoke all on public.reports,public.report_fields from public,anon,authenticated;
grant select on public.reports,public.report_fields to authenticated;
create policy reports_owner_read on public.reports for select to authenticated
    using (user_id=(select auth.uid()));
create policy report_fields_owner_read on public.report_fields for select to authenticated
    using (exists(select 1 from public.reports r where r.id=report_id and r.user_id=(select auth.uid())));

create function public.save_report(raw_text text, fields jsonb, report_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    caller uuid := auth.uid(); target uuid := $3;
    input_raw alias for $1; input_fields alias for $2;
    current_report public.reports%rowtype; old_field public.report_fields%rowtype;
    f jsonb; k text; ai jsonb; uv jsonb; q text; src text; need boolean;
    ready boolean; result_time timestamptz; result_status text;
begin
    if caller is null then raise exception using message='AUTH_REQUIRED',errcode='P0001'; end if;
    if not exists(select 1 from public.profiles where id=caller) then
        raise exception using message='PROFILE_INCOMPLETE',errcode='P0001'; end if;
    if not exists(select 1 from public.profiles where id=caller and role='user') then
        raise exception using message='FORBIDDEN',errcode='P0001'; end if;
    if input_raw is null or char_length(btrim(input_raw)) not between 1 and 2000
       or char_length(input_raw)>2000 or input_fields is null
       or jsonb_typeof(input_fields)<>'array' then
        raise exception using message='INVALID_INPUT',errcode='P0001'; end if;
    if jsonb_array_length(input_fields)>7 then
        raise exception using message='INVALID_INPUT',errcode='P0001'; end if;
    if target is not null then
        select * into current_report from public.reports r where r.id=target and r.user_id=caller for update;
        if not found then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
        if current_report.status='submitted' or current_report.finalized_at is not null then
            raise exception using message='CONFLICT',errcode='P0001'; end if;
        -- Changed text invalidates the entire prior extraction. Re-run AI after this save.
        if current_report.raw_text is distinct from input_raw and jsonb_array_length(input_fields)<>0 then
            raise exception using message='CONFLICT',errcode='P0001'; end if;
        -- Same-text saves may not silently discard the original AI evidence.
        if current_report.raw_text=input_raw and exists(
            select 1 from public.report_fields old where old.report_id=target and not exists(
                select 1 from jsonb_array_elements(input_fields) x where x->>'key'=old.key)) then
            raise exception using message='CONFLICT',errcode='P0001'; end if;
    end if;
    if exists(select 1 from jsonb_array_elements(input_fields) x group by x->>'key' having count(*)>1) then
        raise exception using message='INVALID_INPUT',errcode='P0001'; end if;
    for f in select value from jsonb_array_elements(input_fields) loop
        if jsonb_typeof(f)<>'object' or not f ?& array['key','aiValue','quote','userValue','source','needsCheck']
           or f-array['key','aiValue','quote','userValue','source','needsCheck']<>'{}'::jsonb
           or jsonb_typeof(f->'key')<>'string'
           or jsonb_typeof(f->'source')<>'string'
           or jsonb_typeof(f->'needsCheck')<>'boolean'
           or jsonb_typeof(f->'quote') not in ('string','null') then
            raise exception using message='INVALID_INPUT',errcode='P0001'; end if;
        k:=f->>'key'; src:=f->>'source'; need:=(f->>'needsCheck')::boolean;
        ai:=nullif(f->'aiValue','null'::jsonb); uv:=nullif(f->'userValue','null'::jsonb); q:=f->>'quote';
        if k not in ('company','type','notice_date','leaked','secondary','secondary_detail','card')
           or src not in ('ai','user') or (src='user' and uv is null) or (src='ai' and uv is not null)
           or not hande_private.valid_report_value(k,ai) or not hande_private.valid_report_value(k,uv)
           or (not need and (case when src='user' then uv else ai end) is null)
           or (q is not null and (char_length(q) not between 1 and 2000 or strpos(input_raw,q)=0)) then
            raise exception using message='INVALID_INPUT',errcode='P0001'; end if;
        if target is not null and current_report.raw_text=input_raw then
            select * into old_field from public.report_fields rf where rf.report_id=target and rf.key=k;
            if found and (old_field.ai_value is distinct from ai or old_field.quote is distinct from q) then
                raise exception using message='CONFLICT',errcode='P0001'; end if;
        end if;
    end loop;
    if target is null then
        insert into public.reports(user_id,raw_text) values(caller,input_raw) returning id into target;
    end if;
    delete from public.report_fields rf where rf.report_id=target;
    insert into public.report_fields(report_id,key,ai_value,quote,user_value,source,needs_check)
        select target,x->>'key',nullif(x->'aiValue','null'::jsonb),x->>'quote',
               nullif(x->'userValue','null'::jsonb),x->>'source',(x->>'needsCheck')::boolean
        from jsonb_array_elements(input_fields) x;
    select count(*) filter(where rf.key<>'secondary_detail')=6 and bool_and(not rf.needs_check) filter(where rf.key<>'secondary_detail')
        into ready from public.report_fields rf where rf.report_id=target;
    result_status:=case when coalesce(ready,false) then 'organized' else 'draft' end;
    update public.reports r set raw_text=input_raw,status=result_status,updated_at=clock_timestamp()
        where r.id=target returning r.updated_at into result_time;
    return jsonb_build_object('report_id',target,'status',result_status,'updated_at',result_time);
end;
$$;

create function public.get_report(report_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare r public.reports%rowtype; result_fields jsonb;
begin
    if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001'; end if;
    select * into r from public.reports where id=$1 and user_id=auth.uid();
    if not found then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('key',f.key,'aiValue',f.ai_value,'quote',f.quote,
        'userValue',f.user_value,'source',f.source,'needsCheck',f.needs_check) order by f.key),'[]'::jsonb)
        into result_fields from public.report_fields f where f.report_id=r.id;
    return jsonb_build_object('id',r.id,'raw_text',r.raw_text,'status',r.status,
        'fields',result_fields,'updated_at',r.updated_at,'finalized_at',r.finalized_at);
end;
$$;

create function public.finalize_report(report_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.reports%rowtype; ready boolean;
begin
    if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001'; end if;
    select * into r from public.reports where id=$1 and user_id=auth.uid() for update;
    if not found then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
    if r.status='submitted' then raise exception using message='CONFLICT',errcode='P0001'; end if;
    if r.finalized_at is null then
        select count(*) filter(where f.key<>'secondary_detail')=6 and bool_and(not f.needs_check) filter(where f.key<>'secondary_detail')
            into ready from public.report_fields f where f.report_id=r.id;
        if not coalesce(ready,false) then raise exception using message='INVALID_INPUT',errcode='P0001'; end if;
        update public.reports set status='organized',finalized_at=clock_timestamp(),updated_at=clock_timestamp()
            where id=r.id returning * into r;
    end if;
    return jsonb_build_object('report_id',r.id,'status',r.status,'updated_at',r.updated_at,'finalized_at',r.finalized_at);
end;
$$;
revoke all on function public.save_report(text,jsonb,uuid),public.get_report(uuid),public.finalize_report(uuid)
    from public,anon,authenticated;
grant execute on function public.save_report(text,jsonb,uuid),public.get_report(uuid),public.finalize_report(uuid)
    to authenticated;
commit;
