begin;
-- Only a trusted DB administrator enables versions after the team approves the actual consent text.
create table hande_private.contact_consent_versions(version text primary key check(char_length(version)between 1 and 100),enabled boolean not null default false);
revoke all on hande_private.contact_consent_versions from public,anon,authenticated,service_role;
create table public.group_contact_consents (
 id uuid primary key default gen_random_uuid(),group_id uuid not null,user_id uuid not null,proposal_id uuid not null,
 consent_version text not null references hande_private.contact_consent_versions(version),granted_at timestamptz not null default now(),revoked_at timestamptz,
 foreign key(group_id,user_id)references public.group_members(group_id,user_id),foreign key(proposal_id,group_id)references public.proposals(id,group_id),
 check(revoked_at is null or revoked_at>=granted_at)
);
create unique index consent_one_active on public.group_contact_consents(group_id,user_id)where revoked_at is null;
create index consent_selection on public.group_contact_consents(group_id,proposal_id)where revoked_at is null;
create table public.notices (
 id uuid primary key default gen_random_uuid(),group_id uuid not null references public.groups(id),author_id uuid not null references public.profiles(id),
 title text not null check(char_length(btrim(title))between 1 and 100),body text not null check(char_length(btrim(body))between 1 and 4000),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index notices_group_page on public.notices(group_id,created_at desc,id desc);
-- Surrogate cursor IDs avoid encoding account IDs in member pagination cursors.
alter table public.group_members add column member_id uuid not null default gen_random_uuid() unique;
alter table public.group_contact_consents enable row level security;alter table public.notices enable row level security;
revoke all on public.group_contact_consents,public.notices from public,anon,authenticated;
grant select on public.group_contact_consents to authenticated;
create policy consent_own on public.group_contact_consents for select to authenticated using(user_id=(select auth.uid()));
create function hande_private.cursor_parts(value text)returns jsonb language plpgsql stable set search_path=''as $$
declare c jsonb;
begin
 if $1 is null then return null;end if;
 if char_length($1)>500 then raise exception 'invalid';end if;
 c:=convert_from(decode($1,'base64'),'UTF8')::jsonb;
 if(c->>'at')::timestamptz is null or(c->>'id')::uuid is null then raise exception 'invalid';end if;return c;
exception when others then raise exception using message='INVALID_INPUT',errcode='P0001';end;$$;
create function hande_private.encode_cursor(at_time timestamptz,item_id uuid)returns text language sql stable set search_path=''as $$
 select encode(convert_to(jsonb_build_object('at',$1,'id',$2)::text,'UTF8'),'base64')
$$;
create function public.get_group_members(group_id uuid,cursor text default null,"limit" integer default 20)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare caller uuid:=hande_private.require_member($1);c jsonb:=hande_private.cursor_parts($2);ids uuid[];lastrow public.group_members%rowtype;items jsonb;next_cursor text;
begin
 if $3 is null or $3 not between 1 and 100 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 select array_agg(x.member_id order by x.joined_at desc,x.member_id desc)into ids from
 (select m.*from public.group_members m where m.group_id=$1 and m.left_at is null
 and(c is null or(m.joined_at,m.member_id)<((c->>'at')::timestamptz,(c->>'id')::uuid))order by m.joined_at desc,m.member_id desc limit $3+1)x;
 select coalesce(jsonb_agg(jsonb_build_object('nickname',p.nickname,'damage_level',null,
 'period',jsonb_build_object('from',(case when f.source='user'then f.user_value else f.ai_value end)->>'from','to',(case when f.source='user'then f.user_value else f.ai_value end)->>'to'))order by v.n),'[]')into items
 from unnest(ids[1:$3])with ordinality v(id,n)join public.group_members m on m.member_id=v.id join public.profiles p on p.id=m.user_id
 left join public.report_fields f on f.report_id=m.report_id and f.key='notice_date';
 if cardinality(ids)>$3 then select *into lastrow from public.group_members m where m.member_id=ids[$3];next_cursor:=hande_private.encode_cursor(lastrow.joined_at,lastrow.member_id);end if;
 return jsonb_build_object('items',items,'next_cursor',next_cursor);
end;$$;
create function public.grant_contact_consent(group_id uuid,selected_proposal_id uuid,consent_version text)returns jsonb language plpgsql security definer set search_path=''as $$
declare caller uuid;contact public.profiles_private%rowtype;c public.group_contact_consents%rowtype;
begin
 perform 1 from public.groups g where g.id=$1 for update;caller:=hande_private.require_member($1);
 if not exists(select 1 from public.group_selections s where s.group_id=$1 and s.proposal_id=$2)then raise exception using message='CONFLICT',errcode='P0001';end if;
 if not exists(select 1 from hande_private.contact_consent_versions v where v.version=$3 and v.enabled)then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 select *into contact from public.profiles_private p where p.user_id=caller for update;
 if not found then raise exception using message='PROFILE_INCOMPLETE',errcode='P0001';end if;
 select *into c from public.group_contact_consents x where x.group_id=$1 and x.user_id=caller and x.revoked_at is null;
 if found and c.proposal_id=$2 and c.consent_version=$3 then return jsonb_build_object('consent_id',c.id,'granted_at',c.granted_at,'revoked_at',null);end if;
 update public.group_contact_consents x set revoked_at=clock_timestamp()where x.group_id=$1 and x.user_id=caller and x.revoked_at is null;
 insert into public.group_contact_consents(group_id,user_id,proposal_id,consent_version)values($1,caller,$2,$3)returning *into c;
 return jsonb_build_object('consent_id',c.id,'granted_at',c.granted_at,'revoked_at',null);
end;$$;
create function public.revoke_contact_consent(group_id uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare caller uuid:=hande_private.require_user();at_time timestamptz;
begin
 perform 1 from public.groups g where g.id=$1 for update;
 update public.group_contact_consents c set revoked_at=clock_timestamp()where c.group_id=$1 and c.user_id=caller and c.revoked_at is null returning revoked_at into at_time;
 return jsonb_build_object('revoked_at',at_time);
end;$$;
create function public.update_private_profile(real_name text,phone text)returns jsonb language plpgsql security definer set search_path=''as $$
declare caller uuid:=hande_private.require_user();clean_name text:=btrim($1);clean_phone text:=regexp_replace(btrim($2),'[[:space:]()-]','','g');p public.profiles_private%rowtype;cnt integer;
begin
 if clean_name is null or char_length(clean_name)not between 1 and 100 or clean_phone is null or clean_phone!~'^\+?[0-9]{8,15}$'then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 select *into p from public.profiles_private x where x.user_id=caller for update;
 if not found then raise exception using message='PROFILE_INCOMPLETE',errcode='P0001';end if;
 if p.real_name=clean_name and p.phone=clean_phone then return jsonb_build_object('updated_at',p.updated_at,'requires_reconsent',false);end if;
 update public.profiles_private x set real_name=clean_name,phone=clean_phone where x.user_id=caller returning *into p;
 update public.group_contact_consents c set revoked_at=clock_timestamp()where c.user_id=caller and c.revoked_at is null;get diagnostics cnt=row_count;
 return jsonb_build_object('updated_at',p.updated_at,'requires_reconsent',cnt>0);
end;$$;
create function public.get_selected_contacts(group_id uuid,cursor text default null,"limit" integer default 20)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare fid uuid:=hande_private.approved_firm();pid uuid;c jsonb:=hande_private.cursor_parts($2);ids uuid[];lastrow public.group_contact_consents%rowtype;items jsonb;next_cursor text;
begin
 select s.proposal_id into pid from public.group_selections s join public.proposals p on p.id=s.proposal_id where s.group_id=$1 and p.firm_id=fid;
 if pid is null then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 if $3 is null or $3 not between 1 and 100 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 select array_agg(x.id order by x.granted_at desc,x.id desc)into ids from
 (select x.*from public.group_contact_consents x join public.group_members m on m.group_id=x.group_id and m.user_id=x.user_id
 where x.group_id=$1 and x.proposal_id=pid and x.revoked_at is null and m.left_at is null
 and(c is null or(x.granted_at,x.id)<((c->>'at')::timestamptz,(c->>'id')::uuid))order by x.granted_at desc,x.id desc limit $3+1)x;
 select coalesce(jsonb_agg(jsonb_build_object('nickname',p.nickname,'real_name',pr.real_name,'phone',pr.phone)order by v.n),'[]')into items
 from unnest(ids[1:$3])with ordinality v(id,n)join public.group_contact_consents x on x.id=v.id join public.profiles p on p.id=x.user_id join public.profiles_private pr on pr.user_id=x.user_id;
 if cardinality(ids)>$3 then select *into lastrow from public.group_contact_consents x where x.id=ids[$3];next_cursor:=hande_private.encode_cursor(lastrow.granted_at,lastrow.id);end if;
 return jsonb_build_object('items',items,'next_cursor',next_cursor);
end;$$;
create function public.create_notice(group_id uuid,title text,body text)returns jsonb language plpgsql security definer set search_path=''as $$
declare caller uuid;notice_id uuid;at_time timestamptz;
begin
 perform 1 from public.groups g where g.id=$1 for update;caller:=hande_private.require_rep($1);
 if $2 is null or char_length(btrim($2))not between 1 and 100 or $3 is null or char_length(btrim($3))not between 1 and 4000 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if exists(select 1 from public.groups g where g.id=$1 and g.status='closed')then raise exception using message='CONFLICT',errcode='P0001';end if;
 insert into public.notices(group_id,author_id,title,body)values($1,caller,btrim($2),btrim($3))returning id,created_at into notice_id,at_time;
 perform hande_private.notify_group($1,'notice_created','notice_created:'||notice_id,jsonb_build_object('notice_id',notice_id));
 return jsonb_build_object('notice_id',notice_id,'created_at',at_time);
end;$$;
create function public.list_notices(group_id uuid,cursor text default null,"limit" integer default 20)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare caller uuid:=hande_private.require_member($1);c jsonb:=hande_private.cursor_parts($2);ids uuid[];lastrow public.notices%rowtype;items jsonb;next_cursor text;
begin
 if $3 is null or $3 not between 1 and 100 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 select array_agg(x.id order by x.created_at desc,x.id desc)into ids from(select n.*from public.notices n where n.group_id=$1
 and(c is null or(n.created_at,n.id)<((c->>'at')::timestamptz,(c->>'id')::uuid))order by n.created_at desc,n.id desc limit $3+1)x;
 select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'title',n.title,'body',n.body,'created_at',n.created_at)order by v.n),'[]')into items
 from unnest(ids[1:$3])with ordinality v(id,n)join public.notices n on n.id=v.id;
 if cardinality(ids)>$3 then select *into lastrow from public.notices n where n.id=ids[$3];next_cursor:=hande_private.encode_cursor(lastrow.created_at,lastrow.id);end if;
 return jsonb_build_object('items',items,'next_cursor',next_cursor);
end;$$;
create function public.list_notifications(cursor text default null,"limit" integer default 20)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare c jsonb:=hande_private.cursor_parts($1);ids uuid[];lastrow public.notifications%rowtype;items jsonb;next_cursor text;
begin
 if auth.uid()is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 if $2 is null or $2 not between 1 and 100 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 select array_agg(x.id order by x.created_at desc,x.id desc)into ids from(select n.*from public.notifications n where n.user_id=auth.uid()
 and(c is null or(n.created_at,n.id)<((c->>'at')::timestamptz,(c->>'id')::uuid))order by n.created_at desc,n.id desc limit $2+1)x;
 select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'type',n.type,'group_id',n.group_id,'payload',n.payload,'created_at',n.created_at,'read_at',n.read_at)order by v.n),'[]')into items
 from unnest(ids[1:$2])with ordinality v(id,n)join public.notifications n on n.id=v.id;
 if cardinality(ids)>$2 then select *into lastrow from public.notifications n where n.id=ids[$2];next_cursor:=hande_private.encode_cursor(lastrow.created_at,lastrow.id);end if;
 return jsonb_build_object('items',items,'next_cursor',next_cursor);
end;$$;
create function public.mark_notification_read(notification_id uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare at_time timestamptz;
begin
 if auth.uid()is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 update public.notifications n set read_at=coalesce(n.read_at,clock_timestamp())where n.id=$1 and n.user_id=auth.uid()returning read_at into at_time;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;return jsonb_build_object('notification_id',$1,'read_at',at_time);
end;$$;
create function hande_private.proposal_notification()returns trigger language plpgsql security definer set search_path=''as $$
begin
 if tg_op='INSERT'or(old.status='withdrawn'and new.status='submitted')then
 perform hande_private.notify_group(new.group_id,'proposal_submitted','proposal_submitted:'||new.id,jsonb_build_object('proposal_id',new.id));end if;return new;
end;$$;
create trigger proposal_arrival after insert or update on public.proposals for each row execute function hande_private.proposal_notification();
create function hande_private.firm_review_notification()returns trigger language plpgsql security definer set search_path=''as $$
begin
 if old.approval_status is distinct from new.approval_status then
 insert into public.notifications(user_id,type,dedupe_key,payload)values(new.owner_id,'firm_reviewed','firm_reviewed:'||new.id||':'||clock_timestamp(),jsonb_build_object('approval_status',new.approval_status));end if;return new;
end;$$;
create trigger firm_reviewed after update on public.firms for each row execute function hande_private.firm_review_notification();
create or replace function hande_private.group_json(gid uuid)returns jsonb language sql stable security definer set search_path=''as $$
 select jsonb_build_object('id',g.id,'name',g.name,'company',g.company,'harm_type',g.harm_type,'status',g.status,'sub_status',g.sub_status,
 'member_count',(select count(*)from public.group_members m where m.group_id=g.id and m.left_at is null),'description',g.description,'conditions',g.conditions,
 'period_start',g.period_start,'period_end',g.period_end,'required_evidence',g.required_evidence,'goal',g.goal,'deadline',g.deadline,
 'proposal_deadline',g.proposal_deadline,'method',g.method,'selected_firm_name',p.firm_name_snapshot)from public.groups g
 left join public.group_selections s on s.group_id=g.id left join public.proposals p on p.id=s.proposal_id where g.id=$1
$$;
create function public.list_group_events(group_id uuid,cursor text default null,"limit" integer default 20)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare c jsonb:=hande_private.cursor_parts($2);ids uuid[];lastrow public.group_events%rowtype;items jsonb;next_cursor text;
begin
 if auth.uid()is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 if not hande_private.active_member($1,auth.uid())and not exists(select 1 from public.group_selections s join public.proposals p on p.id=s.proposal_id join public.firms f on f.id=p.firm_id
 where s.group_id=$1 and f.owner_id=auth.uid()and f.approval_status='approved'and f.biz_status='active')then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 if $3 is null or $3 not between 1 and 100 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 select array_agg(x.id order by x.created_at desc,x.id desc)into ids from(select e.*from public.group_events e where e.group_id=$1
 and(c is null or(e.created_at,e.id)<((c->>'at')::timestamptz,(c->>'id')::uuid))order by e.created_at desc,e.id desc limit $3+1)x;
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'type',e.type,'payload',e.payload,'created_at',e.created_at)order by v.n),'[]')into items
 from unnest(ids[1:$3])with ordinality v(id,n)join public.group_events e on e.id=v.id;
 if cardinality(ids)>$3 then select *into lastrow from public.group_events e where e.id=ids[$3];next_cursor:=hande_private.encode_cursor(lastrow.created_at,lastrow.id);end if;
 return jsonb_build_object('items',items,'next_cursor',next_cursor);
end;$$;
-- Non-suit actual connection and final closure require trusted operator confirmation.
-- A method poll alone is never treated as proof of actual mediation/filing.
create function public.record_group_connection(group_id uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare g public.groups%rowtype;
begin
 select *into g from public.groups x where x.id=$1 for update;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 if g.status='in_progress'and g.method<>'suit'then return hande_private.group_json($1);end if;
 if g.status<>'connecting'or g.method is null or g.method='suit'then raise exception using message='CONFLICT',errcode='P0001';end if;
 update public.groups x set status='in_progress',sub_status='connected',updated_at=clock_timestamp()where x.id=$1;
 insert into public.group_events(group_id,type,payload)values($1,'connection_recorded','{}');
 perform hande_private.notify_group($1,'connection_recorded','connection_recorded:'||$1,'{}');return hande_private.group_json($1);
end;$$;
create function public.close_group(group_id uuid,summary text)returns jsonb language plpgsql security definer set search_path=''as $$
declare g public.groups%rowtype;
begin
 if $2 is null or char_length(btrim($2))not between 1 and 2000 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 select *into g from public.groups x where x.id=$1 for update;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 if g.status='closed'then return hande_private.group_json($1);end if;
 if g.status<>'in_progress'then raise exception using message='CONFLICT',errcode='P0001';end if;
 update public.groups x set status='closed',sub_status='closed',result_summary=btrim($2),updated_at=clock_timestamp()where x.id=$1;
 insert into public.group_events(group_id,type,payload)values($1,'group_closed','{}');
 perform hande_private.notify_group($1,'group_closed','group_closed:'||$1,'{}');return hande_private.group_json($1);
end;$$;
revoke all on function public.record_group_connection(uuid),public.close_group(uuid,text)from public,anon,authenticated;
grant execute on function public.record_group_connection(uuid),public.close_group(uuid,text)to service_role;
revoke all on function public.list_group_events(uuid,text,integer)from public,anon,authenticated;
grant execute on function public.list_group_events(uuid,text,integer)to authenticated;
revoke all on all functions in schema hande_private from public,anon,authenticated;
revoke all on function public.get_group_members(uuid,text,integer),public.grant_contact_consent(uuid,uuid,text),public.revoke_contact_consent(uuid),public.update_private_profile(text,text),public.get_selected_contacts(uuid,text,integer),public.create_notice(uuid,text,text),public.list_notices(uuid,text,integer),public.list_notifications(text,integer),public.mark_notification_read(uuid)from public,anon,authenticated;
grant execute on function public.get_group_members(uuid,text,integer),public.grant_contact_consent(uuid,uuid,text),public.revoke_contact_consent(uuid),public.update_private_profile(text,text),public.get_selected_contacts(uuid,text,integer),public.create_notice(uuid,text,text),public.list_notices(uuid,text,integer),public.list_notifications(text,integer),public.mark_notification_read(uuid)to authenticated;
commit;
