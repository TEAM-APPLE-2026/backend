-- ============================================================================
-- DEVELOPMENT hande_dev (jnpbuulrmgdkzbiywjtd) ONLY. 운영 프로젝트에서는 절대 실행하지 않는다.
-- 운영 기준은 수동 승인(firm_auto_approve='off')이다. 이 파일은 자동 배포되지 않는다.
-- 사용법: Supabase 대시보드에서 프로젝트가 hande_dev인지 확인한 뒤 SQL Editor에서
--         아래 [A]/[B]/[C] 중 "하나만" 주석을 풀어 실행한다(기본은 모두 주석 → 확인 쿼리만 실행됨).
-- 전제: migration 20261125030000_firm_auto_verify.sql 적용 완료.
-- 이 값이 바뀐 뒤 nts-verify가 호출되는 pending 로펌부터 적용된다(이미 approved/rejected인 행은 바뀌지 않음).
-- ============================================================================

-- [A] 시연: 국세청 상태조회 결과가 계속사업자(biz_status='active')이면 자동 승인
-- update hande_private.app_settings set value='status' where key='firm_auto_approve';

-- [B] 시연: 진위확인 일치(biz_valid='valid') + 계속사업자(biz_status='active')일 때만 자동 승인
-- update hande_private.app_settings set value='validate' where key='firm_auto_approve';

-- [C] 되돌리기: 수동 승인(기본값)
-- update hande_private.app_settings set value='off' where key='firm_auto_approve';

-- 확인
select key,value from hande_private.app_settings where key='firm_auto_approve';
