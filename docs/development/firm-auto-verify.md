# 로펌 가입 입력 변경·국세청 진위확인·개발 시연 자동 승인

기준: [permissions-and-rpc.md](../database/permissions-and-rpc.md) 7장, [integration-contract.md](../database/integration-contract.md) 12장.

## 팀 합의

- 로펌 가입 입력: 로펌명, 사업자번호, 대표자명, 개업일자, 등록증. 변호사 이름·등록번호는 가입에서 삭제(선택 입력으로만 남김).
- 담당 변호사는 제안서 `leadLawyer`로 유지.
- 사업자 확인(`biz_status`·`biz_valid`)과 로펌 승인(`approval_status`)은 구분. 자동 승인은 개발 프로젝트 시연용 예외이고 운영은 수동 승인.

## 구성

| 구성 | 위치 | 내용 |
| --- | --- | --- |
| migration | `supabase/migrations/20261125030000_firm_auto_verify.sql` | firms 컬럼 추가, `create_firm_application` 교체, `hande_private.app_settings`, `try_auto_approve_firm` |
| Edge Function | `supabase/functions/nts-verify` + `_shared/nts.mjs` | 상태조회 + 진위확인 → 자동 승인 시도 |
| 데이터 모듈 | `src/data/client.mjs` | `createFirmApplication`(repName/openDate), `verifyBusiness` 응답 확장 |
| 설정 SQL | `supabase/operations/dev-firm-auto-approve.sql` | hande_dev 전용 설정 변경·되돌리기 (수동 실행) |
| 테스트 | `tests/firm-auto-approve.test.mjs`, `supabase/tests/hosted_firm_auto_approve.sql` | 로컬 PGlite / 개발 DB 롤백 검증 |

## firms 추가 컬럼

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| rep_name | text? (1~100자) | 대표자명. 새 신청은 필수, 기존 행은 null |
| open_date | date? (1900-01-01 이후) | 개업일자. 새 신청은 필수, 기존 행은 null |
| biz_valid | text, 기본 unchecked | unchecked / valid / invalid / unknown (진위확인 결과) |
| biz_validated_at | timestamptz? | 진위확인 성공 시각 |

## 로펌 신청

```js
const r = await api.createFirmApplication({
  firmName, bizNo,             // 숫자 10자리
  certPath,                    // firm-certs/{user_id}/{uuid}.{ext} 버킷 내부 경로
  repName: '홍길동',            // 1~100자
  openDate: '2020-01-02',      // YYYY-MM-DD, 미래 날짜 불가(KST)
  // lawyers: [{ name, regNo }] // 선택, 기본 [] (0~20명, regNo 중복 불가)
});
// r.data = { id, firmName, repName, openDate, approvalStatus:'pending', bizStatus:'unchecked', bizValid:'unchecked', rejectReason:null }
```

기존 검증(역할, 경로, 등록증 객체 소유자·MIME·크기, 사업자번호 중복 CONFLICT)은 그대로다. 기존 4인자 함수는 제거했다(오버로드가 있으면 PostgREST 이름 인자 호출이 모호해짐).

## nts-verify

```js
const r = await api.verifyBusiness();
// r.data = { firmId, bizStatus, bizCheckedAt, bizValid, bizValidatedAt, approvalStatus }
```

1. JWT·역할·본인 로펌 확인(기존과 동일). 조회 값은 DB의 `biz_no`·`rep_name`·`open_date`·`firm_name`만 쓴다.
2. 두 요청을 병렬로 보낸다. 키는 `NTS_SERVICE_KEY`(기존 비밀값 재사용).
   - 상태조회 `POST …/v1/status` `{b_no:[biz_no]}` → `biz_status`
   - 진위확인 `POST …/v1/validate` `{businesses:[{b_no, start_dt:'YYYYMMDD', p_nm:rep_name, b_nm:firm_name}]}` → `valid` 01=valid, 02=invalid, 그 밖=unknown
3. 실패한 쪽은 기존 값 유지. 둘 다 실패하면 `NETWORK_ERROR`(502), 아무것도 쓰지 않음. rep_name/open_date가 없는 기존 행은 진위확인을 건너뛴다.
4. service role로 성공한 항목만 UPDATE(`id`·`owner_id`·`biz_no` 일치 조건). 매칭 없으면 `CONFLICT`.
5. `rpc('try_auto_approve_firm', {firm_id})` 호출 → DB의 현재 `approval_status`를 응답에 담는다.

주의: 진위확인은 `b_nm`(상호)도 대조한다. 가입 때 입력한 로펌명이 사업자등록증 상호와 다르면 `invalid`가 나올 수 있다. `validate` 모드로 시연할 때는 등록증 상호 그대로 입력한다.

## 자동 승인 설정 (`hande_private.app_settings`)

| firm_auto_approve | 동작 |
| --- | --- |
| off (기본) | 자동 승인 없음. 운영 기준 |
| validate | `biz_valid='valid'` 그리고 `biz_status='active'`이면 pending → approved |
| status | `biz_status='active'`이면 pending → approved |

- rejected·approved는 바뀌지 않는다. 승인 시 `reviewed_at` 기록, 기존 `firm_reviewed` 알림 생성.
- 설정 테이블은 anon/authenticated/service_role 모두 권한 없음. 값은 DB 관리자만 대시보드 SQL로 바꾼다.
- `hande_private.try_auto_approve_firm`(로직)과 `public.try_auto_approve_firm`(PostgREST 진입용 래퍼) 모두 service_role만 실행 가능.

## 검증

- `npm test` — 신청 입력 검증, 진위확인 요청 형식·매핑·부분 실패, off/validate/status 조건, rejected 불변, 사용자·service role의 설정·승인 변경 차단, 데이터 모듈.
- 개발 DB 롤백 검증: `npx supabase db query --remote=jnpbuulrmgdkzbiywjtd --file supabase/tests/hosted_firm_auto_approve.sql --yes`

## 배포 (hande_dev 전용)

```sh
npx supabase db push --remote=jnpbuulrmgdkzbiywjtd
npx supabase functions deploy nts-verify --remote=jnpbuulrmgdkzbiywjtd
```

설정 변경은 `supabase/operations/dev-firm-auto-approve.sql`을 대시보드에서 직접 실행한다. 운영 프로젝트에는 적용하지 않는다.
