-- ============================================================================
-- DEVELOPMENT hande_dev (jnpbuulrmgdkzbiywjtd) ONLY. 운영 프로젝트에서는 절대 실행하지 않는다.
-- 시연 데이터만 지운다: demo-*@example.invalid 계정, 그 계정이 만든 그룹(다른 계정의 참여·제안·투표 포함),
-- 그 계정의 사례·증빙 메타데이터·로펌·알림. 다른 계정(시연 중 직접 가입한 로펌 B 등)은 지우지 않는다.
-- 단, 시연 그룹에 낸 다른 계정의 제안·참여·투표는 그룹과 함께 지워진다.
--
-- 사용법 (대시보드 SQL Editor, 프로젝트가 hande_dev인지 먼저 확인)
--   1) [미리보기]만 선택해 실행 → 지울 행 수 확인
--   2) 파일 전체 실행 → 하나의 트랜잭션으로 삭제 후 commit, 마지막 결과가 모두 0이어야 한다
--   3) Storage 파일은 SQL로 지울 수 없다(storage.protect_delete). [파일 목록] 결과를 보고
--      대시보드 Storage에서 evidences / firm-certs 버킷의 해당 사용자 폴더를 지운다.
--   4) 로컬 .local/dev-demo-seed.json 도 지운다(다시 만들 때 새 계정·비밀번호 생성).
-- ============================================================================

-- [미리보기] -----------------------------------------------------------------
with u as (select id from auth.users where email like 'demo-%@example.invalid'),
     g as (select id from public.groups where created_by in (select id from u))
select (select count(*) from u) users,
       (select count(*) from g) groups,
       (select count(*) from public.reports where user_id in (select id from u)) reports,
       (select count(*) from public.firms where owner_id in (select id from u)) firms,
       (select count(*) from public.polls where group_id in (select id from g)) polls,
       (select count(*) from public.proposals where group_id in (select id from g)) proposals;

-- [삭제] ---------------------------------------------------------------------
begin;
create temp table _u on commit drop as select id from auth.users where email like 'demo-%@example.invalid';
create temp table _g on commit drop as select id from public.groups where created_by in (select id from _u);
create temp table _f on commit drop as select id from public.firms where owner_id in (select id from _u);
create temp table _pr on commit drop as select id from public.proposals
  where group_id in (select id from _g) or firm_id in (select id from _f);
create temp table _pl on commit drop as select id from public.polls
  where group_id in (select id from _g) or opened_by in (select id from _u);
create temp table _o on commit drop as select id from public.poll_options
  where poll_id in (select id from _pl) or proposal_id in (select id from _pr) or candidate_user_id in (select id from _u);

delete from public.group_contact_consents where group_id in (select id from _g) or user_id in (select id from _u) or proposal_id in (select id from _pr);
delete from public.group_selections where group_id in (select id from _g) or proposal_id in (select id from _pr) or firm_poll_id in (select id from _pl);
delete from public.ballots where poll_id in (select id from _pl) or option_id in (select id from _o) or user_id in (select id from _u);
delete from public.poll_results where poll_id in (select id from _pl) or option_id in (select id from _o);
update public.polls set winner_option_id = null where id in (select id from _pl) or winner_option_id in (select id from _o);
delete from public.poll_options where id in (select id from _o);
delete from public.poll_electors where poll_id in (select id from _pl) or user_id in (select id from _u);
delete from public.representative_candidates where poll_id in (select id from _pl) or user_id in (select id from _u);
delete from public.polls where id in (select id from _pl);
delete from public.notifications where group_id in (select id from _g) or user_id in (select id from _u);
delete from public.group_events where group_id in (select id from _g);
delete from public.notices where group_id in (select id from _g) or author_id in (select id from _u);
delete from public.proposals where id in (select id from _pr);
delete from public.group_members where group_id in (select id from _g) or user_id in (select id from _u);
delete from public.groups where id in (select id from _g);
delete from public.evidences where report_id in (select id from public.reports where user_id in (select id from _u));
delete from public.reports where user_id in (select id from _u);
delete from public.firm_lawyers where firm_id in (select id from _f);
delete from public.firms where id in (select id from _f);
delete from public.profiles_private where user_id in (select id from _u);
delete from public.profiles where id in (select id from _u);
delete from auth.users where id in (select id from _u);
commit;

-- [파일 목록] Storage에서 직접 지울 파일 -------------------------------------
select bucket_id, name from storage.objects
 where bucket_id in ('evidences', 'firm-certs')
   and split_part(name, '/', 1) not in (select id::text from auth.users)
 order by bucket_id, name;

-- [확인] 모두 0이어야 한다 ----------------------------------------------------
select (select count(*) from auth.users where email like 'demo-%@example.invalid') users,
       (select count(*) from public.groups where name like '[예시] %' and company in ('○○쇼핑몰', '△△통신', '□□카드')) groups;
