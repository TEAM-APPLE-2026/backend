# 회원·프로필 연동과 피해 사례 저장

## 이번 구현 범위

- `src/data/client.mjs`: 주입한 Supabase JS 클라이언트의 Auth와 RPC를 호출한다. 공개 키를 사용하는 브라우저/프론트 데이터 모듈에서 재사용할 수 있다. HTTP 서버나 service-role 키가 필요하지 않다.
- 기존 `complete_signup`/`get_my_profile`에 camelCase 어댑터를 연결한다.
- `reports`/`report_fields`, 작성자 전용 RLS, `save_report`/`get_report`/`finalize_report`를 추가한다.
- 브라우저 AI를 실행하는 코드는 포함하지 않는다. BE1 결과를 전달받아 저장한다.
- 약관 저장·로펌 신청/승인·파일 업로드·그룹 연결은 미구현이다. `firm:null`은 로펌 승인을 완료했다는 의미가 아니다. 실제 프론트 저장소의 화면 연결은 프론트 담당자의 다음 작업이다.

## 프론트 연결

```js
import { createClient } from '@supabase/supabase-js';
import { createBackendClient } from './src/data/client.mjs';

// 아래는 공개 연결값만 사용한다. Next.js에서는 기존 환경변수와 세션 구성을 따른다.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);
const api = createBackendClient(supabase);

// signUp에 session이 없으면 이메일 확인이 끝나 세션을 얻은 뒤 프로필을 생성한다.
const signup = await api.signUp({ email, password });
// signup.data.requiresEmailConfirmation이면 이메일 확인 화면을 표시한다.
// 인증 콜백/세션 복원 후 아래를 호출한다.
const profile = await api.completeSignup({
  role: 'user', nickname, realName, phone,
});
const me = await api.getMyProfile();

const saved = await api.saveReport({ rawText, fields: extractedFields });
if (saved.data) {
  const reportId = saved.data.reportId;
  const report = await api.getReport({ reportId });
  // 사용자 확인·수정을 fields에 반영한 뒤 다시 saveReport를 호출한다.
  // 6개 기본 필드의 needsCheck=false가 모두 충족되면 명시적으로 확정한다.
  const confirmed = await api.finalizeReport({ reportId });
}
```

위 변수는 실제 화면 입력값이며, 실행 가능한 완결 화면 예제는 아니다. Supabase SDK는 기존 프론트의 브라우저/SSR 세션 구성에 맞춰 초기화하고, 공개 키 이외의 키를 넣지 않는다. 로그인 실패는 LOGIN_FAILED, 세션 없음은 AUTH_REQUIRED, 프로필 누락은 PROFILE_INCOMPLETE로 표시한다. 원시 SQL·Auth 오류는 UI에 노출하지 않는다.

현재 `completeSignup`에 `terms`를 보내면 INVALID_INPUT이다. 미구현 약관 수락을 저장한 것으로 오인하지 않도록 명시적으로 차단한다. 본인 프로필의 실명·전화번호 수정 RPC는 이번 범위에 포함되지 않는다.

## RPC의 실제 계약

| JS 함수 | DB RPC와 인자 | 성공 data |
| --- | --- | --- |
| completeSignup | complete_signup(role,nickname,real_name,phone) | id,role,nickname |
| getMyProfile | get_my_profile() | profile,realName,phone,firm:null |
| saveReport | save_report(raw_text,fields,report_id=null) | reportId,status,updatedAt |
| getReport | get_report(report_id) | id,rawText,status,fields,updatedAt,finalizedAt |
| finalizeReport | finalize_report(report_id) | reportId,status,updatedAt,finalizedAt |

DB 최상위 반환 키는 snake_case, JS 반환 키는 camelCase다. `fields` 내부의 AI 계약(`aiValue`, `userValue`, `needsCheck`)은 재귀 변환하지 않는다. 성공 `{data:T}` / 실패 `{error:{code,message}}`로 구분한다.

## 저장과 확인 규칙

- 원문: 공백만 있는 문자열 금지, 최대 2,000자. 초안은 fields=[]로 저장할 수 있다.
- 기본 필드: company/type/notice_date/leaked/secondary/card. secondary_detail은 선택이다. 기본 6개가 있고 모두 확인되면 `organized`, 그 전은 `draft`다.
- `organized`는 모든 필드가 확인된 저장 상태이며, 명시적 확정 여부는 `finalized_at`으로 구분한다. finalizeReport는 row lock 안에서 재검사하고 같은 확정 요청은 기존 시각을 반환한다. AI가 needsCheck=false라고 반환한 것만으로 사용자가 명시적으로 확인한 것은 아니므로, 화면에서 사용자 확인 후 finalizeReport를 호출한다. 클라이언트 확인 자체는 제3자 검증이 아니다.
- 확정 뒤 수정 및 future submitted 상태 수정은 CONFLICT. 재작성은 새 사례로 시작한다. 그룹 연결 단계가 구현되면 finalized_at을 검사하고 submitted 전이는 해당 서버 RPC만 수행해야 한다.
- 저장은 필드 전체 스냅샷이다. 같은 원문의 기존 필드를 누락하거나 aiValue/quote를 덮어쓰면 CONFLICT. userValue/source/needsCheck로 사용자 수정·확인을 기록한다. 동시 편집은 row lock으로 직렬화하며 마지막 성공 저장의 사용자 수정값이 남는다. 이 PR은 optimistic version 검사를 제공하지 않는다.
- 원문 수정 시 fields=[]로 먼저 저장한다. 기존 추출값을 모두 지운 뒤 새 원문으로 재분석·수정한다. 동일 원문을 다른 AI로 재분석하는 별도 교체 API는 제공하지 않는다.
- quote는 해당 원문의 부분 문자열만 허용한다. 브라우저에서 전달한 AI 데이터는 신뢰된 사실이나 승인 근거가 아니다. AI 원본/quote는 최초 저장값을 보존하며 서버에서 AI가 생성했음을 증명하는 서명은 없다.

## 키별 값 검증

| key | 허용 값 |
| --- | --- |
| company | 공백을 제외해 1~200자 문자열 |
| type | privacy_leak |
| notice_date | from/to/precision만 있는 객체. day=동일 날짜, month=해당 월의 첫날~말일, year=첫날~말일, unknown=from/to 모두 null |
| leaked | 문자열 배열, 최대 30개, 각 값 공백 제외 1~100자 |
| secondary/card | yes/no/unknown |
| secondary_detail | 공백 제외 1~1,000자 문자열 또는 null |

누락 값은 JSON null을 받아 SQL NULL로 저장한다. source=user이면 userValue 필수, source=ai이면 userValue=null. 최종값이 null인 필드는 needsCheck=true여야 한다. 선택 상세의 미확인 null은 기본 6개 확인·확정을 막지 않는다. notice_date는 실제 유출일이 아니라 통지받은 시점이다. 실제로 알 수 없는 정보는 unknown을 사용하고 임의의 날짜를 만들지 않는다. warnings는 fields 키로 받지 않는다.

## 보안과 실행 검증

`npm ci && npm test` (Node.js 22 이상). PGlite PostgreSQL 17.5의 독립 DB에 최소 auth.users/auth.uid/역할·기본 권한만 모델링한 뒤 두 migration을 원문 그대로 적용한다.

- 기존 회원 SQL 회귀 검증 + 신규 reports SQL: 익명 접근, 본인/타인 조회, 역할 변경 차단, 잘못된 JSON/날짜/중복 키, AI 근거 변조, 원문 변경 초기화, 확정 재시도·확정 후 수정 차단.
- JS 어댑터에서 실제 PostgreSQL RPC를 호출해 가입 완료 → 프로필 조회 → 저장 → 사용자 수정 → 확정 → 타인 접근 차단을 검증한다.
- Auth SDK 응답 처리(이메일 확인 대기·로그인 실패·로그아웃)는 모의 응답으로 검증한다. 실제 이메일 발송·JWT 검증·PostgREST HTTP·RLS의 운영 배포 상태를 이 로컬 테스트만으로 검증했다고 주장하지 않는다.

Hosted 점검: `.env.example`을 참고해 개발 프로젝트와 기존 가상 테스트 계정 2개를 준비하고 로컬 미추적 환경파일에 입력한 뒤 `node --env-file=.env scripts/hosted-smoke.mjs`를 실행한다. `HANDE_ALLOW_TEST_WRITES=yes`가 필요하다. 스크립트는 두 계정의 실제 비밀번호 로그인·프로필 조회·사례 생성/조회/확정·타인 접근 차단을 검사한다. 새 회원을 생성하지 않으며, 가상 확정 사례 한 건은 개발 DB에 남는다. 확인 후 신뢰된 관리자가 해당 fixture를 정리한다. 기존 계정 비밀번호나 service-role 키를 커밋·PR·로그에 넣지 않는다. 이 점검은 운영 DB에서 실행하지 않는다.

## 배포 영향과 보완

기존 20261111010000 migration은 수정하지 않는다. 새 20261117010000 migration은 회원 테이블 이후 적용한다. main 병합 시 공동 Supabase DB에 자동 반영될 수 있다. 본 PR 생성은 병합/적용 승인이 아니다.

운영 데이터가 쌓인 뒤 문제를 발견하면 DROP/기존 파일 수정 대신 새 보완 migration을 작성한다. 프론트 노출을 우선 중단하고 RPC EXECUTE 회수 등 검토된 보완으로 대응한다. 아직 보고서 삭제 API가 없으므로 임의로 운영 데이터를 삭제하지 않는다.
