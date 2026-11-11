# 회원 프로필 첫 구현

## 이번 PR의 범위

`supabase/migrations/20261111010000_create_member_profiles.sql`은 Supabase Auth와 연결된 `profiles`, `profiles_private`, RLS, 가입 완료 RPC와 본인 조회 RPC를 생성한다. 기존 설계 PR #2와 독립적인 main 기반 구현 PR이다. 전체 기능을 완료한 PR은 아니다.

- `profiles`: id(Auth 계정 UUID), role(user/firm), nickname, created_at, updated_at.
- `profiles_private`: user_id, real_name, phone, updated_at. 일반 사용자 가입 완료 시 필수. 로펌은 연락처 두 값 모두 생략하거나 모두 입력 가능.
- 비밀번호/이메일은 Supabase Auth가 관리한다. 별도 복제하지 않는다.
- 대표자·운영자·로펌 승인 역할을 가입 요청으로 부여할 수 없다. firm 역할 선택은 로펌 승인과 다르다.
- 닉네임은 1~40자(중복 허용), 실명은 1~100자. 전화번호는 공백·괄호·하이픈을 제거한 뒤 선택적 +와 숫자 8~15자리로 형식만 검사한다. SMS 본인인증을 의미하지 않는다. 이 길이/정규화 규칙은 첫 구현 기준으로 검토 가능하다.

## RPC와 프론트 연결

### complete_signup(role, nickname, real_name=null, phone=null)

인증된 본인 계정에만 프로필을 원자적으로 생성한다. Auth 가입 시 이메일 확인이 필요하면 세션 확보 후 호출한다. auth.users 가입 트리거를 추가하지 않으므로 프로필 오류가 Auth 가입 자체를 막지 않는다.

```js
const { data, error } = await supabase.rpc('complete_signup', {
  role: 'user',
  nickname: '테스트 회원',
  real_name: '테스트 이름',
  phone: '010-0000-0000',
});
// data: { id: '<uuid>', role: 'user', nickname: '테스트 회원' }
```

- 같은 정규화 입력의 재시도는 기존 결과를 반환한다.
- 기존 계정 유형/닉네임/연락처를 바꿔 재호출하면 CONFLICT. 프로필 수정 API로 사용하지 않는다.
- caller ID는 auth.uid()만 사용한다. 임의 user_id 입력을 받지 않는다.
- 한 계정의 동시 완료 요청은 auth.users의 본인 행 잠금으로 직렬화한다.

### get_my_profile()

```json
{"profile":{"id":"<uuid>","role":"user","nickname":"테스트 회원"},"real_name":"테스트 이름","phone":"01000000000"}
```

위는 DB의 snake_case 원시 성공 데이터다. 프론트 데이터 모듈에서 realName 등으로 바꾸고 `{data: ...}`로 감싼다. Supabase SDK가 이미 이 계약을 반환하는 것은 아니다.

| RPC 메시지 | 프론트 코드/처리 |
| --- | --- |
| AUTH_REQUIRED | 로그인 후 재시도 |
| INVALID_INPUT | 입력 확인 |
| CONFLICT | 기존 프로필 조회 후 안내 |
| PROFILE_INCOMPLETE | Auth 로그인 성공 상태에서 프로필 입력 단계 표시 |

애플리케이션 오류는 P0001 SQLSTATE + 위 message로 발생한다. 어댑터는 알려진 message만 허용 목록으로 변환하고 알 수 없는 DB 오류는 INTERNAL_ERROR로 정규화한다. 전체 SQL 오류/연락처를 로그나 사용자 메시지에 복사하지 않는다. 익명 역할은 함수 실행 권한 자체가 없으므로 권한 오류를 반환할 수 있다.

### 닉네임 수정

authenticated 역할은 본인 profiles 행의 nickname 컬럼만 UPDATE할 수 있다. updated_at은 트리거로 갱신된다. role/id/created_at/updated_at 직접 수정, 다른 사람 수정, 직접 INSERT/DELETE는 불가하다. 실명·연락처 변경은 후속 동의 이력 처리 RPC가 준비될 때까지 막는다.

## 권한

| 호출자 | profiles | profiles_private | 가입 완료/내 정보 RPC |
| --- | --- | --- | --- |
| anon | 접근 불가 | 접근 불가 | 실행 불가 |
| authenticated 본인 | 조회, 닉네임만 수정 | 조회만 | 본인만 |
| 다른 회원·그룹 참여자·로펌 | 타인 행 조회/변경 불가 | 타인 행 조회/변경 불가 | 타인 ID 지정 불가 |
| DB 소유자·신뢰된 관리자 | 관리 경로 | 관리 경로 | 브라우저에 관리 키 제공 금지 |

가입 완료 SECURITY DEFINER 함수는 빈 search_path, 명시적 스키마, 본인 신원 검사, PUBLIC/anon 실행권 회수 및 authenticated만 허용한다. 조회 함수는 SECURITY INVOKER로 RLS를 따른다. 다른 테이블 전체의 기본 권한은 변경하지 않는다. Auth/프로필 삭제는 RESTRICT로 보수적으로 제한한다. 탈퇴는 후속 설계 대상이다.

## 아직 구현하지 않은 것

- firms/firm_lawyers와 로펌 승인/국세청 조회, 운영자 명부
- 약관 버전 검증·동의 이력(user_terms_acceptances); 따라서 서비스 가입 전체 완료를 보장하는 함수가 아니라 **프로필 초기화 단계**다. 기존 설계의 terms 인자는 이 PR에 없으며 후속 migration에서 계약을 맞춰야 한다.
- get_my_profile의 firm 정보: 이번 반환에는 없음. 로펌 테이블 구현 때 추가한다.
- 연락처 수정 후 재동의·선정 로펌 제공, 사례·그룹·투표·Storage·Cron
- 실제 Supabase에 적용, 자동 배포 설정, 프론트 어댑터 구현

## 적용·검증

1. 반드시 팀의 Supabase 프로젝트 ref와 개발 환경을 확인한다. 이 PR은 DB에 자동 적용하지 않았다.
2. 개발 DB에 migration을 **한 번** 적용한다. 실패하면 전체 트랜잭션이 롤백된다. 기존 동명 테이블이 있으면 덮어쓰지 않고 실패하므로 먼저 기존 구조를 검토한다.
3. 테스트 DB 소유자로 `supabase/tests/member_profiles.sql`을 실행한다. 임시 사용자/검증 함수는 한 트랜잭션 안에서 생성하고 마지막에 ROLLBACK한다. 실제 운영 프로젝트에서 실행하지 않는다.
4. 테스트는 authenticated/anon으로 전환해 RLS와 컬럼 ACL을 검증한다. JWT subject를 테스트에서 설정하는 것은 신뢰된 SQL 테스트 환경에 한정된다. 클라이언트가 운영 JWT를 위조할 수 있다는 의미가 아니다.
5. 실제 Supabase 개발 프로젝트에서는 이메일 인증과 Auth 세션을 포함한 가입 → complete_signup → get_my_profile를 추가로 검증한다.

테스트 내용: 익명 접근 거부, 세션 없는 요청 거부, 입력 검증, 연락처 정규화, 정확한 재시도, 역할 변경 차단, 직접 쓰기 차단, 다른 회원 정보 비공개, 닉네임 수정, 불완전 프로필 감지, 실패 시 부분 저장 없음. 동시 세션 경합 테스트와 Supabase Auth/PostgREST 종단 검증은 별도 수행 필요.

이 작업 환경에서는 PostgreSQL 18.6 실행 파일을 확인했으나, 격리된 테스트 DB 초기화가 OS 공유 메모리 권한 제한으로 실패했다. 따라서 실행 테스트 파일은 작성했지만 실행 통과를 주장하지 않는다. 정적 검토 결과와 이 제한을 PR에 기록한다.

## 참고

- https://supabase.com/docs/guides/database/functions
- https://supabase.com/docs/guides/database/postgres/row-level-security

## 소민님 피드백 반영: 배포·mock 연결

- 공동 프로젝트: Hande 조직 TEAM-APPLE-2026, backend 레포 연결(ref=nchmitaoxqodsjmhmphi). 별도 개인 프로젝트를 만들지 않는다.
- **이 SQL PR은 Supabase 초기 설정 PR #4 반영과 실행 검증 후 병합한다. main에 합치면 공동 DB에 자동 적용될 수 있다.** 이 작업에서는 병합/실제 DB 적용하지 않는다.
- AI 모듈은 hande_ai에 두지만 migration·Edge Functions·Storage 정책·Cron·seed.sql은 backend/supabase에 둔다.
- PR #4의 config.toml은 PostgreSQL major_version=17이다. 테스트 환경은 실제 공동 DB 버전과 대조해야 한다. 기존 18.6 테스트 시도 실패를 원격 검증으로 취급하지 않는다.
- complete_signup 입력에는 아직 terms가 없다. mock이 목표 계약의 terms를 지원해도 현재 RPC에는 전달하지 않는다. 필수 약관 검증 완료를 의미하지 않는다.
- get_my_profile은 아직 firm 필드를 반환하지 않는다. 프론트/mock 통합 어댑터가 firm:null로 정규화할 수 있지만 승인 기능은 별도 구현이다.
- PROFILE_INCOMPLETE는 Auth 인증 실패와 다르다. 로그인 세션을 유지하고 프로필 입력 단계를 표시한다.
- AI secondary_detail, notice_date 통지 시점, 국세청 biz_status 갱신은 후속 report_fields/firms 구현에 적용한다. 이 회원 전용 migration에는 무관한 테이블이나 동작을 추가하지 않는다.
- 대시보드 변경은 DB에 직접 반영될 수 있지만 Git에 자동 기록되지 않는다. 변경 SQL의 이중 실행을 피하도록 migration 이력과 대조한다.
