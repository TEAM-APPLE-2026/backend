begin;
create table public.polls (
 id uuid primary key default gen_random_uuid(),group_id uuid not null references public.groups(id),kind text not null check(kind in ('representative','method','firm')),
 round_no integer not null check(round_no>0),previous_poll_id uuid references public.polls(id),
 state text not null default 'scheduled' check(state in ('scheduled','open','closed','tied','no_votes','cancelled')),
 opens_at timestamptz not null,closes_at timestamptz not null,opened_by uuid not null references public.profiles(id),
 winner_option_id uuid,closed_at timestamptz,created_at timestamptz not null default now(),check(opens_at<closes_at),unique(group_id,kind,round_no),unique(id,group_id)
);
create unique index poll_one_open_kind on public.polls(group_id,kind)where state in ('scheduled','open');
create index poll_due on public.polls(closes_at)where state in ('scheduled','open');
create table public.representative_candidates (
 poll_id uuid not null,group_id uuid not null,user_id uuid not null,applied_at timestamptz not null default now(),primary key(poll_id,user_id),
 foreign key(poll_id,group_id) references public.polls(id,group_id),foreign key(group_id,user_id) references public.group_members(group_id,user_id)
);
create table public.poll_options (
 id uuid primary key default gen_random_uuid(),poll_id uuid not null references public.polls(id),method_code text check(method_code in ('med','consumer','collective','suit')),
 proposal_id uuid references public.proposals(id),candidate_user_id uuid references public.profiles(id),label text not null,
 check(num_nonnulls(method_code,proposal_id,candidate_user_id)=1),unique(id,poll_id),unique(poll_id,method_code),unique(poll_id,proposal_id),unique(poll_id,candidate_user_id),
 foreign key(poll_id,candidate_user_id)references public.representative_candidates(poll_id,user_id)
);
alter table public.polls add foreign key(winner_option_id,id)references public.poll_options(id,poll_id);
create table public.poll_electors (
 poll_id uuid not null,group_id uuid not null,user_id uuid not null,eligible_at timestamptz not null default now(),primary key(poll_id,user_id),
 foreign key(poll_id,group_id)references public.polls(id,group_id),foreign key(group_id,user_id)references public.group_members(group_id,user_id)
);
create table public.ballots (
 poll_id uuid not null,user_id uuid not null,option_id uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(poll_id,user_id),foreign key(poll_id,user_id)references public.poll_electors(poll_id,user_id),foreign key(option_id,poll_id)references public.poll_options(id,poll_id)
);
create index ballot_option on public.ballots(poll_id,option_id);
create table public.poll_results (
 poll_id uuid not null,option_id uuid not null,vote_count integer not null check(vote_count>=0),finalized_at timestamptz not null default now(),
 primary key(poll_id,option_id),foreign key(option_id,poll_id)references public.poll_options(id,poll_id)
);
create table public.group_selections (
 group_id uuid primary key references public.groups(id),proposal_id uuid not null unique,firm_poll_id uuid not null unique,selected_at timestamptz not null default now(),
 foreign key(proposal_id,group_id)references public.proposals(id,group_id),foreign key(firm_poll_id,group_id)references public.polls(id,group_id)
);
create table public.notifications (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id),group_id uuid references public.groups(id),
 type text not null,dedupe_key text not null,payload jsonb not null default '{}',created_at timestamptz not null default now(),read_at timestamptz,
 unique(user_id,dedupe_key)
);
create index notifications_owner_time on public.notifications(user_id,created_at desc,id desc);
create table public.group_events (
 id uuid primary key default gen_random_uuid(),group_id uuid not null references public.groups(id),type text not null,payload jsonb not null default '{}',created_at timestamptz not null default now()
);
do $$declare t text;begin foreach t in array array['polls','representative_candidates','poll_options','poll_electors','ballots','poll_results','group_selections','notifications','group_events']loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;end;$$;
grant select on public.ballots,public.poll_electors,public.notifications to authenticated;
create policy ballot_own on public.ballots for select to authenticated using(user_id=(select auth.uid()));
create policy elector_own on public.poll_electors for select to authenticated using(user_id=(select auth.uid()));
create policy notification_own on public.notifications for select to authenticated using(user_id=(select auth.uid()));
create function hande_private.notify_group(gid uuid,event_type text,dedupe text,data jsonb)returns void language sql security definer set search_path='' as $$
 insert into public.notifications(user_id,group_id,type,dedupe_key,payload)
 select m.user_id,$1,$2,$3,$4 from public.group_members m where m.group_id=$1 and m.left_at is null on conflict(user_id,dedupe_key)do nothing
$$;
create function public.open_poll(group_id uuid,kind text,opens_at timestamptz,closes_at timestamptz)returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=hande_private.require_member($1);g public.groups%rowtype;prev public.polls%rowtype;pid uuid;round integer;cnt integer;
begin
 select * into g from public.groups x where x.id=$1 for update;
 if $2 is null or $2 not in ('representative','method','firm')or $3 is null or $4 is null or $3>=$4 or $4<=clock_timestamp()or $4-$3>interval '30 days' or $3>clock_timestamp()+interval '30 days' then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if exists(select 1 from public.polls p where p.group_id=$1 and p.state in ('scheduled','open'))then raise exception using message='CONFLICT',errcode='P0001';end if;
 select * into prev from public.polls p where p.group_id=$1 and p.kind=$2 order by p.round_no desc limit 1;
 if found and prev.state not in ('tied','no_votes','cancelled')then raise exception using message='CONFLICT',errcode='P0001';end if;
 round:=coalesce(prev.round_no,0)+1;
 if $2='representative' then
 if g.created_by<>caller then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 if g.status<>'recruiting' or exists(select 1 from public.group_members m where m.group_id=$1 and m.is_rep and m.left_at is null)
 or(select count(*)from public.group_members m where m.group_id=$1 and m.left_at is null)<10 then raise exception using message='NOT_ELIGIBLE',errcode='P0001';end if;
 if $3<=clock_timestamp()then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 elsif $2='method' then
 perform hande_private.require_rep($1);
 if g.sub_status<>'method_vote' or g.method is not null then raise exception using message='CONFLICT',errcode='P0001';end if;
 else
 perform hande_private.require_rep($1);
 if g.method is distinct from 'suit' or g.sub_status not in ('proposal_collection','firm_vote') or g.proposal_deadline is null or g.proposal_deadline>clock_timestamp()then raise exception using message='PROPOSAL_CLOSED',errcode='P0001';end if;
 select count(*)into cnt from public.proposals p join public.firms f on f.id=p.firm_id where p.group_id=$1 and p.status='submitted' and f.approval_status='approved' and f.biz_status='active';
 if cnt=0 then raise exception using message='NOT_ELIGIBLE',errcode='P0001';end if;
 end if;
 insert into public.polls(group_id,kind,round_no,previous_poll_id,opens_at,closes_at,opened_by)values($1,$2,round,prev.id,$3,$4,caller)returning id into pid;
 insert into public.poll_electors(poll_id,group_id,user_id)select pid,$1,m.user_id from public.group_members m where m.group_id=$1 and m.left_at is null;
 if $2='method' then insert into public.poll_options(poll_id,method_code,label)select pid,v,v from unnest(array['med','consumer','collective','suit'])v;
 elsif $2='firm' then insert into public.poll_options(poll_id,proposal_id,label)select pid,p.id,p.firm_name_snapshot from public.proposals p join public.firms f on f.id=p.firm_id
 where p.group_id=$1 and p.status='submitted' and f.approval_status='approved' and f.biz_status='active';end if;
 update public.groups x set sub_status=case $2 when 'representative'then 'rep_election'when 'method'then 'method_vote'else 'firm_vote'end,
 updated_at=clock_timestamp()where x.id=$1;
 perform hande_private.notify_group($1,'poll_started','poll_started:'||pid,jsonb_build_object('poll_id',pid,'kind',$2,'opens_at',$3,'closes_at',$4));
 return jsonb_build_object('poll_id',pid,'state','scheduled','opens_at',$3,'closes_at',$4);
end;$$;
create function public.apply_representative(poll_id uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.polls%rowtype;gid uuid;caller uuid;at timestamptz;
begin
 select x.group_id into gid from public.polls x where x.id=$1;
 caller:=hande_private.require_member(gid);
 perform 1 from public.groups g where g.id=gid for update;
 select * into p from public.polls x where x.id=$1 for update;
 if p.kind<>'representative' or p.state<>'scheduled' or clock_timestamp()>=p.opens_at then raise exception using message='POLL_NOT_OPEN',errcode='P0001';end if;
 insert into public.representative_candidates(poll_id,group_id,user_id)values(p.id,gid,caller)on conflict on constraint representative_candidates_pkey do nothing;
 select c.applied_at into at from public.representative_candidates c where c.poll_id=p.id and c.user_id=caller;
 insert into public.poll_options(poll_id,candidate_user_id,label)select p.id,caller,x.nickname from public.profiles x where x.id=caller on conflict on constraint poll_options_poll_id_candidate_user_id_key do nothing;
 return jsonb_build_object('poll_id',p.id,'applied_at',at);
end;$$;
create function hande_private.cast_vote(pid uuid,expected_kind text,oid uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.polls%rowtype;gid uuid;caller uuid;at timestamptz;now_at timestamptz;
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 select x.group_id into gid from public.polls x where x.id=pid;
 if gid is null then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 perform 1 from public.groups g where g.id=gid for update;
 caller:=hande_private.require_member(gid);
 select * into p from public.polls x where x.id=pid for update;
 now_at:=clock_timestamp();
 if p.kind<>expected_kind then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if p.state not in ('scheduled','open')or now_at>=p.closes_at then raise exception using message='POLL_CLOSED',errcode='P0001';end if;
 if now_at<p.opens_at then raise exception using message='POLL_NOT_OPEN',errcode='P0001';end if;
 if not exists(select 1 from public.poll_electors e where e.poll_id=pid and e.user_id=caller)then raise exception using message='NOT_ELIGIBLE',errcode='P0001';end if;
 if not exists(select 1 from public.poll_options o where o.id=oid and o.poll_id=pid)then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 insert into public.ballots(poll_id,user_id,option_id)values(pid,caller,oid)on conflict(poll_id,user_id)do update set option_id=excluded.option_id,updated_at=clock_timestamp()returning updated_at into at;
 update public.polls x set state='open'where x.id=pid;
 return jsonb_build_object('poll_id',pid,'option_id',oid,'updated_at',at);
end;$$;
create function public.cast_representative_vote(poll_id uuid,option_id uuid)returns jsonb language plpgsql security definer set search_path='' as $$
begin return hande_private.cast_vote($1,'representative',$2);end;$$;
create function public.cast_method_vote(poll_id uuid,choice text)returns jsonb language plpgsql security definer set search_path='' as $$
declare oid uuid;begin select o.id into oid from public.poll_options o where o.poll_id=$1 and o.method_code=$2;return hande_private.cast_vote($1,'method',oid);end;$$;
create function public.cast_firm_vote(poll_id uuid,proposal_id uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare oid uuid;begin select o.id into oid from public.poll_options o where o.poll_id=$1 and o.proposal_id=$2;return hande_private.cast_vote($1,'firm',oid);end;$$;
create function public.get_vote_summary(poll_id uuid)returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.polls%rowtype;caller uuid;options jsonb;mine uuid;total integer;display_state text;
begin
 select * into p from public.polls x where x.id=$1;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 caller:=hande_private.require_member(p.group_id);
 select coalesce(jsonb_agg(jsonb_build_object('option_id',v.id,'label',v.label,'vote_count',v.cnt)order by v.id),'[]'),coalesce(sum(v.cnt),0)
 into options,total from(select o.id,o.label,count(b.user_id)cnt from public.poll_options o left join public.ballots b on b.option_id=o.id and b.poll_id=o.poll_id where o.poll_id=$1 group by o.id,o.label)v;
 select b.option_id into mine from public.ballots b where b.poll_id=$1 and b.user_id=caller;
 display_state:=case when p.state in ('scheduled','open')and statement_timestamp()>=p.closes_at then 'closed'when p.state='scheduled'and statement_timestamp()>=p.opens_at then 'open'else p.state end;
 return jsonb_build_object('poll_id',p.id,'kind',p.kind,'state',display_state,'opens_at',p.opens_at,'closes_at',p.closes_at,'server_time',statement_timestamp(),
 'total_votes',total,'options',options,'my_option_id',mine,'winner_option_id',p.winner_option_id);
end;$$;
create function public.close_vote(poll_id uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.polls%rowtype;gid uuid;total integer;top_count integer;ties integer;winner uuid;out_state text;counts jsonb;option_row public.poll_options%rowtype;valid_firm boolean;
begin
 select x.group_id into gid from public.polls x where x.id=$1;
 if gid is null then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 perform 1 from public.groups g where g.id=gid for update;
 select * into p from public.polls x where x.id=$1 for update;
 if p.state in ('scheduled','open')then
 if clock_timestamp()<p.closes_at then raise exception using message='POLL_NOT_OPEN',errcode='P0001';end if;
 insert into public.poll_results(poll_id,option_id,vote_count)select p.id,o.id,count(b.user_id)from public.poll_options o left join public.ballots b on b.poll_id=o.poll_id and b.option_id=o.id where o.poll_id=p.id group by o.id;
 select coalesce(sum(r.vote_count),0),coalesce(max(r.vote_count),0)into total,top_count from public.poll_results r where r.poll_id=p.id;
 select count(*)into ties from public.poll_results r where r.poll_id=p.id and r.vote_count=top_count;
 out_state:=case when total=0 then 'no_votes'when ties>1 then 'tied'else 'closed'end;
 if out_state='closed'then
 select r.option_id into winner from public.poll_results r where r.poll_id=p.id and r.vote_count=top_count;
 select * into option_row from public.poll_options o where o.id=winner;
 if p.kind='representative'then
 if not hande_private.active_member(gid,option_row.candidate_user_id)then out_state:='cancelled';winner:=null;
 else update public.group_members m set is_rep=(m.user_id=option_row.candidate_user_id)where m.group_id=gid and m.left_at is null;
 update public.groups g set status='connecting',sub_status='method_vote',updated_at=clock_timestamp()where g.id=gid;end if;
 elsif p.kind='method'then
 update public.groups g set method=option_row.method_code,status='connecting',
 sub_status=case when option_row.method_code='suit'then 'proposal_collection'else 'method_vote'end,updated_at=clock_timestamp()where g.id=gid;
 else
 select exists(select 1 from public.proposals pr join public.firms f on f.id=pr.firm_id where pr.id=option_row.proposal_id and pr.status='submitted'and f.approval_status='approved'and f.biz_status='active')into valid_firm;
 if not valid_firm then out_state:='cancelled';winner:=null;
 else insert into public.group_selections(group_id,proposal_id,firm_poll_id)values(gid,option_row.proposal_id,p.id);
 update public.groups g set status='in_progress',sub_status='connected',updated_at=clock_timestamp()where g.id=gid;
 insert into public.notifications(user_id,group_id,type,dedupe_key,payload)select f.owner_id,gid,'firm_selected','firm_selected:'||p.id,jsonb_build_object('poll_id',p.id)
 from public.proposals pr join public.firms f on f.id=pr.firm_id where pr.id=option_row.proposal_id on conflict(user_id,dedupe_key)do nothing;end if;
 end if;end if;
 update public.polls x set state=out_state,winner_option_id=winner,closed_at=clock_timestamp()where x.id=p.id returning * into p;
 insert into public.group_events(group_id,type,payload)values(gid,'poll_closed',jsonb_build_object('poll_id',p.id,'kind',p.kind,'state',p.state));
 perform hande_private.notify_group(gid,'poll_closed','poll_closed:'||p.id,jsonb_build_object('poll_id',p.id,'kind',p.kind,'state',p.state));
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('option_id',r.option_id,'vote_count',r.vote_count)order by r.option_id),'[]')into counts from public.poll_results r where r.poll_id=p.id;
 return jsonb_build_object('poll_id',p.id,'state',p.state,'winner_option_id',p.winner_option_id,'counts',counts);
end;$$;
create function public.close_due_votes(max_count integer default 100)returns jsonb language plpgsql security definer set search_path='' as $$
declare pid uuid;done integer:=0;failed integer:=0;
begin
 if $1 is null or $1 not between 1 and 500 then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 for pid in select p.id from public.polls p where p.state in ('scheduled','open')and p.closes_at<=clock_timestamp()order by p.closes_at,p.id limit $1 loop
 begin perform public.close_vote(pid);done:=done+1;
 exception when others then failed:=failed+1;raise warning 'vote close failed for poll %',pid;end;end loop;
 return jsonb_build_object('processed',done,'failed',failed);
end;$$;
create function public.set_proposal_deadline(group_id uuid,deadline timestamptz)returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid;g public.groups%rowtype;
begin
 perform 1 from public.groups x where x.id=$1 for update;caller:=hande_private.require_rep($1);
 select * into g from public.groups x where x.id=$1;
 if $2 is null or $2<=clock_timestamp()or $2>clock_timestamp()+interval '90 days' then raise exception using message='INVALID_INPUT',errcode='P0001';end if;
 if g.method is distinct from 'suit'or g.sub_status<>'proposal_collection'or exists(select 1 from public.proposals p where p.group_id=$1)then raise exception using message='CONFLICT',errcode='P0001';end if;
 update public.groups x set proposal_deadline=$2,updated_at=clock_timestamp()where x.id=$1;
 return jsonb_build_object('group_id',$1,'proposal_deadline',$2);
end;$$;
create function public.get_my_proposal_vote_summary(poll_id uuid)returns jsonb language plpgsql stable security definer set search_path='' as $$
declare fid uuid;pid uuid;p public.polls%rowtype;votes integer;
begin
 if auth.uid() is null then raise exception using message='AUTH_REQUIRED',errcode='P0001';end if;
 select f.id into fid from public.firms f where f.owner_id=auth.uid();
 select * into p from public.polls x where x.id=$1 and x.kind='firm';
 select o.proposal_id into pid from public.poll_options o join public.proposals pr on pr.id=o.proposal_id where o.poll_id=$1 and pr.firm_id=fid;
 if pid is null then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 select count(*)into votes from public.ballots b join public.poll_options o on o.id=b.option_id where b.poll_id=$1 and o.proposal_id=pid;
 return jsonb_build_object('poll_id',$1,'state',case when p.state in ('scheduled','open')and statement_timestamp()>=p.closes_at then 'closed'else p.state end,
 'closes_at',p.closes_at,'my_proposal_id',pid,'my_vote_count',votes);
end;$$;
revoke all on all functions in schema hande_private from public,anon,authenticated;
revoke all on function public.open_poll(uuid,text,timestamptz,timestamptz),public.apply_representative(uuid),public.cast_representative_vote(uuid,uuid),public.cast_method_vote(uuid,text),public.cast_firm_vote(uuid,uuid),public.get_vote_summary(uuid),public.set_proposal_deadline(uuid,timestamptz),public.get_my_proposal_vote_summary(uuid),public.close_vote(uuid),public.close_due_votes(integer)from public,anon,authenticated;
grant execute on function public.open_poll(uuid,text,timestamptz,timestamptz),public.apply_representative(uuid),public.cast_representative_vote(uuid,uuid),public.cast_method_vote(uuid,text),public.cast_firm_vote(uuid,uuid),public.get_vote_summary(uuid),public.set_proposal_deadline(uuid,timestamptz),public.get_my_proposal_vote_summary(uuid)to authenticated;
grant execute on function public.close_vote(uuid),public.close_due_votes(integer)to service_role;
commit;
