-- ============================================================================
-- DEVELOPMENT hande_dev (jnpbuulrmgdkzbiywjtd) ONLY. 운영 프로젝트에서는 절대 실행하지 않는다.
-- 시연 데이터(scripts/dev-seed-demo.mjs)의 [예시] 로펌 C, D를 승인한다.
-- 사업자번호는 가상 번호라 국세청 확인을 거치지 않고 biz_status를 active로 직접 지정한다(시연 전용).
-- 대시보드 SQL Editor에서 프로젝트가 hande_dev인지 확인한 뒤 실행한다. 다시 실행해도 결과는 같다.
-- ============================================================================
update public.firms f
   set approval_status = 'approved', biz_status = 'active', biz_checked_at = now(),
       reviewed_at = now(), updated_at = now()
  from auth.users u
 where u.id = f.owner_id
   and u.email in ('demo-firm-c@example.invalid', 'demo-firm-d@example.invalid')
   and f.approval_status = 'pending';

-- 확인: 두 행 모두 approved / active 여야 한다.
select u.email, f.firm_name, f.approval_status, f.biz_status
  from public.firms f join auth.users u on u.id = f.owner_id
 where u.email in ('demo-firm-c@example.invalid', 'demo-firm-d@example.invalid');
