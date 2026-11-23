begin;
create table public.groups (
 id uuid primary key default gen_random_uuid(), name text not null check(char_length(btrim(name)) between 1 and 100),
 company text not null check(char_length(btrim(company)) between 1 and 200), harm_type text not null default 'privacy_leak' check(harm_type='privacy_leak'),
 description text not null check(char_length(btrim(description)) between 1 and 2000), conditions text not null check(char_length(conditions)<=1000),
 period_start date,period_end date,required_evidence text[] not null default '{}',goal integer check(goal>0),deadline timestamptz,
 proposal_deadline timestamptz,method text check(method in ('med','consumer','collective','suit')),
 status text not null default 'recruiting' check(status in ('recruiting','connecting','in_progress','closed')),
 sub_status text not null default 'recruiting' check(sub_status in ('recruiting','rep_election','method_vote','proposal_collection','firm_vote','connected','closed')),
 created_by uuid not null references public.profiles(id), result_summary text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(period_start is null or period_end is null or period_start<=period_end),
 check((status='recruiting' and sub_status in ('recruiting','rep_election')) or
       (status='connecting' and sub_status in ('method_vote','proposal_collection','firm_vote')) or
       (status='in_progress' and sub_status='connected') or(status='closed' and sub_status='closed'))
);
create index groups_filter on public.groups(company,harm_type,status);
create index groups_page on public.groups(created_at desc,id desc);
create table public.group_members (
 group_id uuid not null references public.groups(id),user_id uuid not null references public.profiles(id),report_id uuid not null,
 is_rep boolean not null default false,joined_at timestamptz not null default now(),left_at timestamptz,
 primary key(group_id,user_id), foreign key(report_id,user_id) references public.reports(id,user_id),
 check(not is_rep or left_at is null)
);
create unique index group_one_rep on public.group_members(group_id) where is_rep and left_at is null;
create index member_user_active on public.group_members(user_id,left_at);
create index member_report on public.group_members(report_id);
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
revoke all on public.groups,public.group_members from public,anon,authenticated;
grant select on public.group_members to authenticated;
create policy member_own_read on public.group_members for select to authenticated using(user_id=(select auth.uid()));

create function hande_private.require_user() returns uuid language plpgsql security definer set search_path='' as $$
declare caller uuid:=auth.uid();
begin
 if caller is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 if not exists(select 1 from public.profiles p where p.id=caller) then raise exception using message='PROFILE_INCOMPLETE',errcode='P0001';end if;
 if not exists(select 1 from public.profiles p where p.id=caller and p.role='user') then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 return caller;
end;$$;
create function hande_private.active_member(gid uuid,caller uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.group_members m where m.group_id=$1 and m.user_id=$2 and m.left_at is null)
$$;
create function hande_private.require_member(gid uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare caller uuid:=hande_private.require_user();
begin
 if not hande_private.active_member(gid,caller) then raise exception using message='FORBIDDEN',errcode='P0001';end if;return caller;
end;$$;
create function hande_private.require_rep(gid uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare caller uuid:=hande_private.require_member(gid);
begin
 if not exists(select 1 from public.group_members m where m.group_id=gid and m.user_id=caller and m.is_rep and m.left_at is null) then
 raise exception using message='FORBIDDEN',errcode='P0001';end if;return caller;
end;$$;
create function hande_private.group_json(gid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',g.id,'name',g.name,'company',g.company,'harm_type',g.harm_type,'status',g.status,'sub_status',g.sub_status,
 'member_count',(select count(*) from public.group_members m where m.group_id=g.id and m.left_at is null),
 'description',g.description,'conditions',g.conditions,'period_start',g.period_start,'period_end',g.period_end,'required_evidence',g.required_evidence,
 'goal',g.goal,'deadline',g.deadline,'proposal_deadline',g.proposal_deadline,'method',g.method,'selected_firm_name',null)
 from public.groups g where g.id=$1
$$;
create function hande_private.report_matches(rid uuid,company_name text)returns boolean language sql stable security definer set search_path=''as $$
 select exists(select 1 from public.report_fields c join public.report_fields t on t.report_id=c.report_id and t.key='type'
 where c.report_id=$1 and c.key='company'and lower(btrim((case when c.source='user'then c.user_value else c.ai_value end)#>>'{}'))=lower(btrim($2))
 and(case when t.source='user'then t.user_value else t.ai_value end)='"privacy_leak"'::jsonb)
$$;
create function public.create_group(report_id uuid,name text,company text,description text,conditions text default '',harm_type text default 'privacy_leak',
 period_start date default null,period_end date default null,required_evidence text[] default '{}',goal integer default null,deadline timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=hande_private.require_user();r public.reports%rowtype;gid uuid;j timestamptz;
begin
 select * into r from public.reports x where x.id=$1 and x.user_id=caller for update;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 if r.finalized_at is null or r.status not in ('organized','submitted') then raise exception using message='NOT_ELIGIBLE',errcode='P0001';end if;
 if $2 is null or char_length(btrim($2)) not between 1 and 100 or $3 is null or char_length(btrim($3)) not between 1 and 200
 or $4 is null or char_length(btrim($4)) not between 1 and 2000 or $5 is null or char_length($5)>1000 or $6 is distinct from 'privacy_leak'
 or ($7 is not null and $8 is not null and $7>$8) or ($10 is not null and $10<=0) or($11 is not null and $11<=clock_timestamp())
 or $9 is null or cardinality($9)>20 or exists(select 1 from unnest($9) v where v is null or char_length(btrim(v)) not between 1 and 100) then
 raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if not hande_private.report_matches(r.id,$3)then raise exception using message='NOT_ELIGIBLE',errcode='P0001';end if;
 insert into public.groups(name,company,description,conditions,harm_type,period_start,period_end,required_evidence,goal,deadline,created_by)
 values(btrim($2),btrim($3),btrim($4),$5,$6,$7,$8,$9,$10,$11,caller) returning id into gid;
 insert into public.group_members(group_id,user_id,report_id) values(gid,caller,r.id) returning joined_at into j;
 update public.reports set status='submitted',updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('group_id',gid,'membership',jsonb_build_object('group_id',gid,'is_rep',false,'joined_at',j,'left_at',null));
end;$$;
create function public.join_group(group_id uuid,report_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=hande_private.require_user();g public.groups%rowtype;m public.group_members%rowtype;r public.reports%rowtype;
begin
 select * into g from public.groups x where x.id=$1 for update;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 select * into m from public.group_members x where x.group_id=$1 and x.user_id=caller;
 if found then
 if m.left_at is null and m.report_id=$2 then return jsonb_build_object('group_id',m.group_id,'is_rep',m.is_rep,'joined_at',m.joined_at,'left_at',m.left_at);end if;
 raise exception using message='CONFLICT',errcode='P0001';end if;
 if g.status<>'recruiting' or g.sub_status<>'recruiting' or(g.deadline is not null and g.deadline<=clock_timestamp()) then
 raise exception using message='NOT_ELIGIBLE',errcode='P0001';end if;
 select * into r from public.reports x where x.id=$2 and x.user_id=caller for update;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 if r.finalized_at is null or r.status not in ('organized','submitted') then raise exception using message='NOT_ELIGIBLE',errcode='P0001';end if;
 if not hande_private.report_matches(r.id,g.company)then raise exception using message='NOT_ELIGIBLE',errcode='P0001';end if;
 insert into public.group_members(group_id,user_id,report_id) values(g.id,caller,r.id) returning * into m;
 update public.reports set status='submitted',updated_at=clock_timestamp() where id=r.id;
 return jsonb_build_object('group_id',g.id,'is_rep',false,'joined_at',m.joined_at,'left_at',null);
end;$$;
create function public.leave_group(group_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=hande_private.require_user();g public.groups%rowtype;m public.group_members%rowtype;
begin
 select * into g from public.groups x where x.id=$1 for update;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 select * into m from public.group_members x where x.group_id=$1 and x.user_id=caller;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 if m.left_at is not null then return jsonb_build_object('group_id',$1,'is_rep',false,'joined_at',m.joined_at,'left_at',m.left_at);end if;
 if g.status<>'recruiting' or g.sub_status<>'recruiting' or m.is_rep or g.created_by=caller then
 raise exception using message='CONFLICT',errcode='P0001';end if;
 update public.group_members x set left_at=clock_timestamp() where x.group_id=$1 and x.user_id=caller returning * into m;
 return jsonb_build_object('group_id',$1,'is_rep',false,'joined_at',m.joined_at,'left_at',m.left_at);
end;$$;
create function public.get_my_membership(group_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare caller uuid:=hande_private.require_user();result jsonb;
begin
 select jsonb_build_object('group_id',m.group_id,'is_rep',m.is_rep,'joined_at',m.joined_at,'left_at',m.left_at) into result
 from public.group_members m where m.group_id=$1 and m.user_id=caller;return result;
end;$$;
create function public.get_group(group_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin result:=hande_private.group_json($1);if result is null then raise exception using message='NOT_FOUND',errcode='P0001';end if;return result;end;$$;
-- Cursor contains only public group ID/time, never report or member identity.
create function public.list_groups(company text default null,harm_type text default null,status text default null,cursor text default null,"limit" integer default 20)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ts timestamptz;cid uuid;c jsonb;items jsonb;lastrow record;next_cursor text;lim integer:=$5;
begin
 if lim is null or lim not between 1 and 100 or($2 is not null and $2<>'privacy_leak') or($3 is not null and $3 not in ('recruiting','connecting','in_progress','closed')) then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if $4 is not null then begin c:=convert_from(decode($4,'base64'),'UTF8')::jsonb;ts:=(c->>'at')::timestamptz;cid:=(c->>'id')::uuid;
 if ts is null or cid is null then raise exception 'invalid';end if;
 exception when others then raise exception using message='INVALID_INPUT',errcode='P0001';end;end if;
 select coalesce(jsonb_agg(hande_private.group_json(x.id) order by x.created_at desc,x.id desc),'[]') into items from
 (select g.id,g.created_at from public.groups g where($1 is null or g.company=$1)and($2 is null or g.harm_type=$2)and($3 is null or g.status=$3)
 and(ts is null or(g.created_at,g.id)<(ts,cid)) order by g.created_at desc,g.id desc limit lim)x;
 if jsonb_array_length(items)=lim then
 select g.id,g.created_at into lastrow from public.groups g where g.id=(items->(lim-1)->>'id')::uuid;
 if exists(select 1 from public.groups g where($1 is null or g.company=$1)and($2 is null or g.harm_type=$2)and($3 is null or g.status=$3)
 and(g.created_at,g.id)<(lastrow.created_at,lastrow.id)) then
 next_cursor:=encode(convert_to(jsonb_build_object('at',lastrow.created_at,'id',lastrow.id)::text,'UTF8'),'base64');end if;end if;
 return jsonb_build_object('items',items,'next_cursor',next_cursor);
end;$$;
revoke all on all functions in schema hande_private from public,anon,authenticated;
revoke all on function public.create_group(uuid,text,text,text,text,text,date,date,text[],integer,timestamptz),public.join_group(uuid,uuid),public.leave_group(uuid),public.get_my_membership(uuid),public.get_group(uuid),public.list_groups(text,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.create_group(uuid,text,text,text,text,text,date,date,text[],integer,timestamptz),public.join_group(uuid,uuid),public.leave_group(uuid),public.get_my_membership(uuid) to authenticated;
grant execute on function public.get_group(uuid),public.list_groups(text,text,text,text,integer) to anon,authenticated;
commit;
