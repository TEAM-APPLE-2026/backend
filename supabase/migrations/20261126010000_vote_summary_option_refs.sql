-- get_vote_summary options에 proposal_id, method_code, candidate_user_id를 추가한다.
-- 프론트가 castFirmVote(poll_id, proposal_id)·castMethodVote(poll_id, choice)에 넘길 값을 얻기 위함.
-- 집계 방식(마감 전 ballots 실시간, 마감 후 poll_results), require_member 권한, 개인 표 비공개는 그대로다.
-- 해당 없는 참조 값은 null(poll_options의 num_nonnulls=1 제약상 항목마다 하나만 채워진다).
begin;
create or replace function public.get_vote_summary(poll_id uuid)returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.polls%rowtype;caller uuid;options jsonb;mine uuid;total integer;display_state text;
begin
 select * into p from public.polls x where x.id=$1;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 caller:=hande_private.require_member(p.group_id);
 select coalesce(jsonb_agg(jsonb_build_object('option_id',v.id,'label',v.label,'vote_count',v.cnt,
 'proposal_id',v.proposal_id,'method_code',v.method_code,'candidate_user_id',v.candidate_user_id)order by v.id),'[]'),coalesce(sum(v.cnt),0)
 into options,total from(select o.id,o.label,o.proposal_id,o.method_code,o.candidate_user_id,case when p.closed_at is not null then coalesce((select r.vote_count from public.poll_results r where r.poll_id=p.id and r.option_id=o.id),0)else(select count(*)from public.ballots b where b.poll_id=p.id and b.option_id=o.id)end cnt from public.poll_options o where o.poll_id=$1)v;
 select b.option_id into mine from public.ballots b where b.poll_id=$1 and b.user_id=caller;
 display_state:=case when p.state in ('scheduled','open')and statement_timestamp()>=p.closes_at then 'closed'when p.state='scheduled'and statement_timestamp()>=p.opens_at then 'open'else p.state end;
 return jsonb_build_object('poll_id',p.id,'kind',p.kind,'state',display_state,'opens_at',p.opens_at,'closes_at',p.closes_at,'server_time',statement_timestamp(),
 'total_votes',total,'options',options,'my_option_id',mine,'winner_option_id',p.winner_option_id,'is_finalized',p.closed_at is not null);
end;$$;
-- create or replace는 기존 ACL을 유지하지만 권한을 명시적으로 재확인한다.
revoke all on function public.get_vote_summary(uuid)from public,anon,authenticated;
grant execute on function public.get_vote_summary(uuid)to authenticated;
commit;
