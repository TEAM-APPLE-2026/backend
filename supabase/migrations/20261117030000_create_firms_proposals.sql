begin;
create table public.firms (
 id uuid primary key default gen_random_uuid(),owner_id uuid not null unique references public.profiles(id),
 firm_name text not null check(char_length(btrim(firm_name)) between 1 and 100),biz_no text not null unique check(biz_no~'^[0-9]{10}$'),
 biz_status text not null default 'unchecked' check(biz_status in ('unchecked','active','suspended','closed','unknown')),biz_checked_at timestamptz,
 cert_path text not null,approval_status text not null default 'pending' check(approval_status in ('pending','approved','rejected')),
 reviewed_at timestamptz,reject_reason text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(approval_status<>'rejected' or (reject_reason is not null and char_length(btrim(reject_reason))>0))
);
create table public.firm_lawyers (
 id uuid primary key default gen_random_uuid(),firm_id uuid not null references public.firms(id),name text not null,reg_no text not null,
 created_at timestamptz not null default now(),unique(firm_id,reg_no)
);
create table public.evidences (
 id uuid primary key default gen_random_uuid(),report_id uuid not null references public.reports(id),kind text not null,
 bucket_id text not null check(bucket_id='evidences'),object_path text not null unique,original_name text not null,
 mime_type text not null check(mime_type in ('image/jpeg','image/png','application/pdf')),
 size_bytes bigint not null check(size_bytes>0 and size_bytes<=10000000),
 status text not null default 'pending' check(status in ('pending','ready','failed')),created_at timestamptz not null default now(),uploaded_at timestamptz
);
create index evidence_report_ready on public.evidences(report_id,status);
create table public.proposals (
 id uuid primary key default gen_random_uuid(),group_id uuid not null references public.groups(id),firm_id uuid not null references public.firms(id),
 retainer_fee numeric(14,0) not null check(retainer_fee>=0),success_fee_pct numeric(5,2) not null check(success_fee_pct between 0 and 100),
 period text not null,strategy text not null,lawyer_count integer not null check(lawyer_count>0),lead_lawyer text not null,
 firm_name_snapshot text not null,status text not null default 'submitted' check(status in ('submitted','withdrawn')),
 submitted_at timestamptz not null default now(),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(group_id,firm_id),unique(id,group_id)
);
create index proposals_firm_status on public.proposals(firm_id,status);
alter table public.firms enable row level security;alter table public.firm_lawyers enable row level security;
alter table public.evidences enable row level security;alter table public.proposals enable row level security;
revoke all on public.firms,public.firm_lawyers,public.evidences,public.proposals from public,anon,authenticated;
grant select on public.firms,public.firm_lawyers,public.evidences to authenticated;
-- NTS may update only verification columns, never approval. Trusted DB owner approves in dashboard.
revoke all on public.firms from service_role;grant select on public.firms to service_role;
grant update(biz_status,biz_checked_at) on public.firms to service_role;
create policy firms_own on public.firms for select to authenticated using(owner_id=(select auth.uid()));
create policy lawyers_own on public.firm_lawyers for select to authenticated using(exists(select 1 from public.firms f where f.id=firm_id and f.owner_id=(select auth.uid())));
create policy evidence_own on public.evidences for select to authenticated using(exists(select 1 from public.reports r where r.id=report_id and r.user_id=(select auth.uid())));
create function hande_private.firm_json(fid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',f.id,'firm_name',f.firm_name,'approval_status',f.approval_status,'biz_status',f.biz_status,'reject_reason',f.reject_reason)
 from public.firms f where f.id=$1
$$;
create function hande_private.approved_firm() returns uuid language plpgsql security definer set search_path='' as $$
declare f public.firms%rowtype;
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 select * into f from public.firms x where x.owner_id=auth.uid();
 if not found then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 if f.approval_status<>'approved' then raise exception using message='FIRM_NOT_APPROVED',errcode='P0001';end if;
 if f.biz_status<>'active' then raise exception using message='NOT_ELIGIBLE',errcode='P0001';end if;return f.id;
end;$$;
create function public.create_firm_application(firm_name text,biz_no text,cert_path text,lawyers jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare fid uuid;item jsonb;object_data jsonb;object_size bigint;
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='firm') then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 if $1 is null or char_length(btrim($1)) not between 1 and 100 or $2 is null or $2!~'^[0-9]{10}$'
 or $3 is null or $3!~('^'||auth.uid()::text||'/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|pdf)$')
 or jsonb_typeof($4) is distinct from 'array' then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if jsonb_array_length($4) not between 1 and 20 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 for item in select value from jsonb_array_elements($4) loop
 if jsonb_typeof(item)<>'object' or not item ?& array['name','regNo'] or(item-array['name','regNo'])<>'{}'::jsonb
 or jsonb_typeof(item->'name')<>'string' or jsonb_typeof(item->'regNo')<>'string'
 or char_length(btrim(item->>'name')) not between 1 and 100 or char_length(btrim(item->>'regNo')) not between 1 and 100 then
 raise exception using message='INVALID_INPUT',errcode='P0001';end if;end loop;
 if exists(select 1 from jsonb_array_elements($4) x group by btrim(x->>'regNo') having count(*)>1) then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if to_regclass('storage.objects') is null then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 execute 'select to_jsonb(o) from storage.objects o where o.bucket_id=$1 and o.name=$2' into object_data using 'firm-certs',$3;
 if object_data is null or coalesce(object_data->>'owner_id',object_data->>'owner') is distinct from auth.uid()::text
 or coalesce(object_data->'metadata'->>'mimetype','') not in ('image/jpeg','image/png','application/pdf')
 or coalesce(object_data->'metadata'->>'size','')!~'^[0-9]{1,9}$' then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 object_size:=(object_data->'metadata'->>'size')::bigint;
 if object_size not between 1 and 10000000 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 insert into public.firms(owner_id,firm_name,biz_no,cert_path) values(auth.uid(),btrim($1),$2,$3) returning id into fid;
 insert into public.firm_lawyers(firm_id,name,reg_no) select fid,btrim(x->>'name'),btrim(x->>'regNo') from jsonb_array_elements($4)x;
 return hande_private.firm_json(fid);
exception when unique_violation then raise exception using message='CONFLICT',errcode='P0001';
end;$$;
create function public.get_my_firm() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare fid uuid;
begin if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 select f.id into fid from public.firms f where f.owner_id=auth.uid();return hande_private.firm_json(fid);end;$$;
create function hande_private.proposal_json(pid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'group_id',p.group_id,'firm_id',p.firm_id,'firm_name',p.firm_name_snapshot,
 'retainer_fee',p.retainer_fee,'success_fee_pct',p.success_fee_pct,'period',p.period,'strategy',p.strategy,'lawyer_count',p.lawyer_count,
 'lead_lawyer',p.lead_lawyer,'status',p.status,'submitted_at',p.submitted_at,'updated_at',p.updated_at) from public.proposals p where p.id=$1
$$;
create function hande_private.validate_proposal(p jsonb) returns void language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' or not p ?& array['retainerFee','successFeePct','period','strategy','lawyerCount','leadLawyer']
 or(p-array['retainerFee','successFeePct','period','strategy','lawyerCount','leadLawyer'])<>'{}'::jsonb
 or jsonb_typeof(p->'retainerFee')<>'number' or jsonb_typeof(p->'successFeePct')<>'number' or jsonb_typeof(p->'lawyerCount')<>'number'
 or jsonb_typeof(p->'period')<>'string' or jsonb_typeof(p->'strategy')<>'string' or jsonb_typeof(p->'leadLawyer')<>'string' then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if(p->>'retainerFee')::numeric not between 0 and 99999999999999 or trunc((p->>'retainerFee')::numeric)<>(p->>'retainerFee')::numeric
 or(p->>'successFeePct')::numeric not between 0 and 100 or round((p->>'successFeePct')::numeric,2)<>(p->>'successFeePct')::numeric
 or(p->>'lawyerCount')::numeric not between 1 and 1000 or trunc((p->>'lawyerCount')::numeric)<>(p->>'lawyerCount')::numeric
 or char_length(btrim(p->>'period')) not between 1 and 200 or char_length(btrim(p->>'strategy')) not between 1 and 3000
 or char_length(btrim(p->>'leadLawyer')) not between 1 and 100 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
end;$$;
create function public.submit_proposal(group_id uuid,proposal jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare fid uuid:=hande_private.approved_firm();g public.groups%rowtype;pid uuid;
begin
 perform hande_private.validate_proposal($2);
 select * into g from public.groups x where x.id=$1 for update;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 if g.method is distinct from 'suit' or g.sub_status<>'proposal_collection' or g.proposal_deadline is null or g.proposal_deadline<=clock_timestamp() then
 raise exception using message='PROPOSAL_CLOSED',errcode='P0001';end if;
 insert into public.proposals(group_id,firm_id,retainer_fee,success_fee_pct,period,strategy,lawyer_count,lead_lawyer,firm_name_snapshot)
 select g.id,fid,($2->>'retainerFee')::numeric,($2->>'successFeePct')::numeric,$2->>'period',$2->>'strategy',($2->>'lawyerCount')::integer,$2->>'leadLawyer',f.firm_name from public.firms f where f.id=fid
 returning id into pid;return hande_private.proposal_json(pid);
exception when unique_violation then raise exception using message='CONFLICT',errcode='P0001';end;$$;
create function public.update_proposal(proposal_id uuid,proposal jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare fid uuid:=hande_private.approved_firm();gid uuid;g public.groups%rowtype;
begin
 perform hande_private.validate_proposal($2);
 select p.group_id into gid from public.proposals p where p.id=$1 and p.firm_id=fid;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 select * into g from public.groups x where x.id=gid for update;
 if g.sub_status<>'proposal_collection' or g.proposal_deadline<=clock_timestamp() then raise exception using message='PROPOSAL_CLOSED',errcode='P0001';end if;
 update public.proposals p set retainer_fee=($2->>'retainerFee')::numeric,success_fee_pct=($2->>'successFeePct')::numeric,
 period=$2->>'period',strategy=$2->>'strategy',lawyer_count=($2->>'lawyerCount')::integer,lead_lawyer=$2->>'leadLawyer',
 status='submitted',submitted_at=clock_timestamp(),updated_at=clock_timestamp() where p.id=$1;
 return hande_private.proposal_json($1);
end;$$;
create function public.withdraw_proposal(proposal_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare fid uuid:=hande_private.approved_firm();gid uuid;g public.groups%rowtype;
begin
 select p.group_id into gid from public.proposals p where p.id=$1 and p.firm_id=fid;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 select * into g from public.groups x where x.id=gid for update;
 if g.sub_status<>'proposal_collection' or g.proposal_deadline<=clock_timestamp() then raise exception using message='PROPOSAL_CLOSED',errcode='P0001';end if;
 update public.proposals p set status='withdrawn',updated_at=clock_timestamp() where p.id=$1;
 return hande_private.proposal_json($1);
end;$$;
-- Full bounded result: at most 100 per request, cursor uses proposal ID/time (not member identity).
create function public.list_proposals(group_id uuid,cursor text default null,"limit" integer default 20) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare fid uuid;ids uuid[];items jsonb;ts timestamptz;cid uuid;c jsonb;next_cursor text;lastrow public.proposals%rowtype;
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 if not hande_private.active_member($1,auth.uid()) then
 select f.id into fid from public.firms f where f.owner_id=auth.uid();
 if fid is null then raise exception using message='FORBIDDEN',errcode='P0001';end if;end if;
 if $3 is null or $3 not between 1 and 100 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if $2 is not null then begin c:=convert_from(decode($2,'base64'),'UTF8')::jsonb;ts:=(c->>'at')::timestamptz;cid:=(c->>'id')::uuid;
 if ts is null or cid is null then raise exception 'invalid';end if;
 exception when others then raise exception using message='INVALID_INPUT',errcode='P0001';end;end if;
 select array_agg(p.id order by p.created_at desc,p.id desc) into ids from
 (select x.* from public.proposals x where x.group_id=$1 and((fid is null and x.status='submitted')or x.firm_id=fid)
 and(ts is null or(x.created_at,x.id)<(ts,cid)) order by x.created_at desc,x.id desc limit $3+1)p;
 select coalesce(jsonb_agg(hande_private.proposal_json(v.id) order by v.n),'[]') into items from unnest(ids[1:$3])with ordinality v(id,n);
 if cardinality(ids)>$3 then select * into lastrow from public.proposals p where p.id=ids[$3];
 next_cursor:=encode(convert_to(jsonb_build_object('at',lastrow.created_at,'id',lastrow.id)::text,'UTF8'),'base64');end if;
 return jsonb_build_object('items',items,'next_cursor',next_cursor);
end;$$;
create function public.get_group_stats(group_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare fid uuid:=hande_private.approved_firm();members integer;yes_count integer;known integer;holders integer;
begin
 if not exists(select 1 from public.groups g where g.id=$1 and g.method='suit') then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 select count(*),count(*)filter(where (case when f.source='user' then f.user_value else f.ai_value end)='"yes"'::jsonb),
 count(*)filter(where (case when f.source='user' then f.user_value else f.ai_value end) in ('"yes"'::jsonb,'"no"'::jsonb)),
 count(*)filter(where exists(select 1 from public.evidences e where e.report_id=m.report_id and e.status='ready'))
 into members,yes_count,known,holders from public.group_members m left join public.report_fields f on f.report_id=m.report_id and f.key='secondary'
 where m.group_id=$1 and m.left_at is null;
 return jsonb_build_object('group_id',$1,'member_count',members,'secondary_yes_count',yes_count,'secondary_known_count',known,
 'secondary_unknown_count',members-known,'secondary_ratio',yes_count::numeric/nullif(known,0),
 'evidence_holder_count',holders,'evidence_ratio',holders::numeric/nullif(members,0),'as_of',statement_timestamp());
end;$$;
revoke all on all functions in schema hande_private from public,anon,authenticated;
revoke all on function public.create_firm_application(text,text,text,jsonb),public.get_my_firm(),public.submit_proposal(uuid,jsonb),public.update_proposal(uuid,jsonb),public.withdraw_proposal(uuid),public.list_proposals(uuid,text,integer),public.get_group_stats(uuid) from public,anon,authenticated;
grant execute on function public.create_firm_application(text,text,text,jsonb),public.get_my_firm(),public.submit_proposal(uuid,jsonb),public.update_proposal(uuid,jsonb),public.withdraw_proposal(uuid),public.list_proposals(uuid,text,integer),public.get_group_stats(uuid) to authenticated;
commit;
