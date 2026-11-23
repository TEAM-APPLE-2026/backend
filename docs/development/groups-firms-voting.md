# 그룹 → 로펌 → 투표·선정·알림 구현

## 범위와 선행 PR

PR #6(회원·피해 사례 저장) 위의 후속 구현이다. `20261117020000`~`20261117050000` migration을 순서대로 적용한다. 새 브랜치/PR 생성만으로 운영 DB에 적용하지 않는다. 프론트 화면과 실제 Supabase Auth/PostgREST 연결은 별도 개발 프로젝트 검증이 필요하다.

| 기능 | 구현 |
| --- | --- |
| 그룹 | 생성, 공개 목록/상세, 본인 참여, 모집 중 탈퇴, 참여자 익명 목록 |
| 로펌 | 소유 증빙 확인 후 pending 신청, 본인 승인 상태 조회, 승인·사업자 상태 분리 |
| 제안서 | 승인+사업자 active 로펌의 제출/수정/철회, 참여자 비교 목록, 익명 집계 |
| 대표자 | 활성 참여자 10명 이상, 개설자 개시, 지원자 등록, 투표로 선정 |
| 투표 | 대표자/방법/로펌, 1인 1표·변경, 실시간 집계, 서버 시각 마감, 동점/0표, 재투표 |
| 선정 | 단독 최다 득표 선정, 최종 집계 저장, 현재 선정 로펌 기록 |
| 동의·진행 | 그룹·선정 제안별 연락처 동의/철회, 연락처 변경 시 재동의, 공지·상태 이력·본인 알림 |
| 서버 작업 | close_vote, close_due_votes, 비소송 실제 연결 기록, 사건 종결 |

## 확정한 정책과 구현 제한

- 사용자 선택으로 대표자 선거는 **10명** 기준을 유지한다. 최초/재선거 개시는 그룹 개설자, 후보는 활성 참여자의 지원으로 정한다. 개설자는 자동 대표자가 아니다.
- 대표자 선거의 opensAt은 미래여야 한다. 선거 생성~opensAt 전까지 후보 신청, 이후 후보 변경 금지다. 처음부터 익명 전체 회원이 후보가 되는 방식이 아니다.
- 투표 종류별 이전 회차가 tied/no_votes/cancelled일 때 새 round/id로 재투표한다. 대표자 재투표는 개설자, 방법·로펌 재투표는 대표자가 연다. no_votes는 임의 선정 없이 같은 주체가 재개할 수 있다. 최다 득표 방식이며 별도 투표율·과반 정족수는 임의로 추가하지 않았다.
- 투표 기간은 최대 30일, 시작 예약은 현재부터 30일 이내다. 이 값은 서버 입력 상한이며 법적 기준이 아니다.
- 가입·탈퇴는 recruiting/recruiting 단계에서만 허용한다. 개설자·대표자의 탈퇴와 탈퇴 후 재가입은 CONFLICT다. 투표 이후의 탈퇴·대표자 교체는 미정이므로 차단한다. 이 제한으로 선거 개시 시점에 저장한 유권자 스냅샷과 투표 시작 시점의 참여자가 달라지지 않는다.
- 확정한 본인 사례만 참여할 수 있다. 최종 회사명(공백 제거·대소문자 무시)과 privacy_leak 유형이 그룹과 일치해야 한다. 공백/회사 별칭을 자동 추론하지 않는다. goal은 목표 인원이며 참여 상한이 아니다. 같은 사례의 서로 다른 그룹 연결은 기존 설계처럼 단독 유일 제약을 만들지 않았다.
- 공개 설명·조건은 사용자가 직접 정리한 문구다. 피해 원문을 자동으로 공개 설명에 복사하지 않는다. 공개 설명에 개인정보가 없는지 화면에서 안내·확인해야 하며 DB가 자유 문장의 개인정보를 자동 판별한다고 주장하지 않는다.
- 법률 대응 추천 규칙(recommend_method)은 아직 합의되지 않아 구현하지 않았다. 대응 투표의 선택지 med/consumer/collective/suit는 법적 이용 자격을 보장하지 않는다.
- 비소송 방법 투표가 끝나도 실제 연결 완료로 처리하지 않는다. 신뢰된 운영자가 실제 처리를 확인한 뒤 서버 전용 record_group_connection을 호출한다. 사건 종결도 서버 전용 close_group이다.

## 프론트 호출 순서

모두 `createBackendClient(supabase)`가 반환하는 함수다. 입력/출력은 camelCase이며 기존 fields/payload 내부 key는 변경하지 않는다.

```js
// 1. 본인 확정 사례 → 그룹 생성 또는 기존 그룹 참여
const created = await api.createGroup({reportId, name, company, description,
  conditions: '', requiredEvidence: [], goal: 10});
const joined = await api.joinGroup({groupId, reportId});
const groups = await api.listGroups({company, harmType: 'privacy_leak', limit: 20});
const mine = await api.getMyMembership({groupId});
const members = await api.getGroupMembers({groupId, limit: 20});

// 2. 개설자: 10명 이상일 때 후보 모집 시간을 확보해 예약
const election = await api.openPoll({groupId, kind: 'representative', opensAt, closesAt});
// 각 지원자: opensAt 이전
await api.applyRepresentative({pollId});
// 각 참여자: opensAt 이후, closesAt 이전
await api.castRepresentativeVote({pollId, optionId});
const vote = await api.getVoteSummary({pollId});
// 서버가 마감/집계하므로 프론트는 close_vote를 호출하지 않는다.

// 3. 대표자: 방법 투표. suit 선정 후 제안 마감 설정
await api.openPoll({groupId, kind: 'method', opensAt, closesAt});
await api.castMethodVote({pollId, choice: 'suit'});
await api.setProposalDeadline({groupId, deadline});

// 4. 로펌: BE1 Storage 업로드 완료 후 신청
await api.createFirmApplication({firmName, bizNo, certPath,
  lawyers: [{name: lawyerName, regNo}]});
const firm = await api.getMyFirm();
// 실제 운영자 승인 + BE1 국세청 확인 이후
await api.submitProposal({groupId, proposal: {
  retainerFee, successFeePct, period, strategy, lawyerCount, leadLawyer,
}});
// 참여자에게 제출 제안만, 로펌에게는 본인 제안만 반환
const proposals = await api.listProposals({groupId, limit: 20});

// 5. 제안 마감 이후 대표자: 로펌 투표 / 참여자 투표
await api.openPoll({groupId, kind: 'firm', opensAt, closesAt});
await api.castFirmVote({pollId, proposalId});
// 로펌은 경쟁 로펌/개별 투표 내역 없이 자기 득표만 조회
const ownVotes = await api.getMyProposalVoteSummary({pollId});

// 6. 선정 후: 실제 승인된 문구를 표시하고 동의한 참여자만 호출
await api.grantContactConsent({groupId, selectedProposalId, consentVersion});
// 선정 로펌: 현재 동의한 활성 참여자만
const contacts = await api.getSelectedContacts({groupId, limit: 20});
await api.revokeContactConsent({groupId});
// 이름/연락처를 변경하면 기존 제공 동의가 철회됨
await api.updatePrivateProfile({realName, phone});

// 7. 진행 현황
await api.createNotice({groupId, title, body}); // 현재 대표자만
const notices = await api.listNotices({groupId, limit: 20});
const events = await api.listGroupEvents({groupId, limit: 20});
const notifications = await api.listNotifications({limit: 20});
await api.markNotificationRead({notificationId});
```

위 코드는 서로 다른 역할의 호출 흐름을 나열한 예시다. 하나의 계정으로 전부 실행하는 예제가 아니다. 프론트 연결 모듈을 구현한 것이며 화면에 이미 연결했다고 주장하지 않는다.

## 입력·목록·응답

- 그룹명 1~100자, 기업명 1~200자, 공개 설명 1~2,000자, 조건 최대 1,000자. requiredEvidence는 최대 20개, 각 1~100자다. 양쪽 날짜가 있으면 시작<=종료, 모집 마감은 생성 시 미래다.
- 제안은 정수 KRW 착수금, 0~100(소수 둘째 자리까지) 성공보수율, 기간 1~200자, 전략 1~3,000자, 변호사 수 1~1,000 정수, 담당자명 1~100자다. 입력 자체가 자격·비용 검증 완료를 뜻하지 않는다.
- 제안은 그룹·로펌당 한 행이며 철회 후 동일 행을 updateProposal로 재제출한다. 투표 선택지가 확정되거나 접수 마감이 지나면 수정·철회 불가다. 접수 마감 설정은 제안이 들어오기 전까지만 가능하다.
- 목록은 `{items,nextCursor}`, 기본 limit=20, 최대 100. 다음 요청에 nextCursor를 그대로 보낸다. 일반 목록은 createdAt DESC,id DESC. 참여자 목록은 joinedAt DESC,무작위 memberId DESC이며 실제 계정 ID를 cursor에 인코딩하지 않는다. 동의 연락처 목록은 grantedAt DESC,consentId DESC다.
- getGroupMembers는 nickname,damageLevel:null,period만 반환한다. damageLevel은 현재 사례 스키마에 수집 항목이 없어 null이며 피해액을 임의 추정하지 않는다. period는 통지 시점이다.
- getVoteSummary/getMyProposalVoteSummary는 `isFinalized`를 추가 반환한다. 마감 시각 이후 투표는 즉시 차단되지만 Cron 집계까지 지연될 수 있다. state=closed,isFinalized=false면 '집계 중'을 표시하고 winnerOptionId로 선정 완료를 추정하지 않는다. 확정 뒤 득표는 poll_results 스냅샷을 읽는다.
- 오류 AUTH_REQUIRED/PROFILE_INCOMPLETE/FORBIDDEN/FIRM_NOT_APPROVED/NOT_ELIGIBLE/POLL_NOT_OPEN/POLL_CLOSED/PROPOSAL_CLOSED/CONFLICT/INVALID_INPUT/NOT_FOUND를 공통 오류 형식으로 반환한다.

## Storage·승인·동의 버전·예약 작업 연결

1. BE1의 비공개 firm-certs 버킷 및 소유자 업로드 정책이 선행되어야 로펌 신청할 수 있다. 경로는 `{userId}/{uuid}.jpg|jpeg|png|pdf`다. 신청 RPC는 storage.objects의 실체·owner_id(또는 owner)·MIME 메타데이터·최대 10,000,000 bytes를 확인한다. 실제 파일 바이트 형식 검사와 안전한 업로드 경로는 BE1 담당이다. 단순 MIME 문자열을 악성 파일 검증으로 취급하지 않는다.
2. 운영자는 DB 관리자 경로에서 firms.approval_status/reviewed_at/reject_reason을 검토한다. 승인 상태를 클라이언트가 지정하는 API는 없다. NTS service_role에는 firms의 biz_status/biz_checked_at UPDATE만 부여했다. 승인 필드 변경 권한은 없다. 네트워크 실패 시 이전 사업자 결과 유지 규칙은 BE1 Edge Function이 구현한다.
3. evidences는 비공개 메타데이터 테이블이며, 클라이언트 직접 INSERT/ready 지정은 차단했다. BE1 신뢰 경로가 실제 업로드를 검사하고 메타데이터를 기록한다. ready인 사례 보유자만 익명 집계에 센다. Storage 버킷·정책·업로드 UI는 이 PR에서 만들지 않았다.
4. 실제 연락처 제공 동의문과 버전은 팀에서 승인한 뒤 DB 관리자가 `hande_private.contact_consent_versions`에 enabled=true로 등록한다. 기본 제공 버전은 없으며, 알 수 없는 버전은 차단한다. synthetic-v1은 테스트 fixture에만 있다. 운영 문구를 임의로 만들거나 사용자가 임의 버전을 등록하도록 하지 않는다.
5. close_due_votes(100)은 만료 투표를 찾아 건별 마감하고 실패 건은 다음 주기에 재시도한다. 함수는 구현·검증했지만 Cron 등록은 자동 배포하지 않는다. BE1이 `supabase/operations/schedule-vote-close.sql`을 개발 프로젝트에서 검토·등록한다. 동일 작업명으로 재실행해 중복 작업을 만들지 않는다. pg_cron이 없는 테스트 DB에서는 스케줄러 등록을 검증하지 않았다.

## 보안·트랜잭션

- 모든 신규 public 테이블에 RLS와 명시적 ACL을 설정했다. 공개 그룹은 허용 필드만 SECURITY DEFINER RPC로 조회하며, 민감 원문/증거/사업자번호/회원 연락처를 반환하지 않는다.
- 사용자 쓰기는 RPC 전용이다. group_members/ballots/poll_electors/notifications/consents의 직접 조회는 본인 행만 허용한다. 타인 투표자 명단은 제공하지 않는다.
- 그룹 변경과 투표는 groups→polls 순서로 잠근다. 투표와 마감은 동일 poll 행 잠금 후 clock_timestamp로 시각을 다시 확인한다. 동시에 같은 종류의 진행 투표는 부분 유일 인덱스로 차단한다.
- 연락처 제공 동의는 그룹+현재 선정 제안에 종속된다. 활성 참여+현재 선정된 승인/사업자 active 로펌만 유효한 동의자의 최신 연락처를 조회한다. 철회 후 신규 조회는 막지만 이미 받은 정보의 회수는 보장하지 않는다. 연락처 제공 동의는 증거 원본 제공 동의나 법적 소송 참여 확정과 다르다.
- 실명·연락처 변경은 프로필 행을 잠근 뒤 유효 동의를 철회한다. 동의 등록도 같은 프로필 행을 잠가 변경과의 경합을 방지한다.
- 선거/선정/공지 알림은 시스템만 생성한다. 재마감의 poll 결과·그룹 반영·알림은 중복되지 않는다. 알림 payload에는 원문/실명/전화번호를 담지 않는다.

## 검증과 남은 확인

`npm ci && npm test`로 기존 SQL 회귀 검증 및 새 그룹·로펌·투표·동의 테스트를 실행한다. 가상 계정과 가상 Storage.objects만 사용한다. PostgreSQL 17.5(PGlite)에 migration을 실제 적용해 권한과 전이 흐름을 실행했다.

PGlite는 단일 연결이므로 다중 연결 경합/데드락을 실제 서버처럼 검증한 것은 아니다. 운영 Supabase 이메일 인증, PostgREST HTTP, 실제 Storage 객체 업로드, Cron 호출, 프론트 화면 연결도 아직 검증하지 않았다. 개발 Supabase에서 실제 역할 계정·파일·스케줄러·동시 요청을 확인한 뒤 병합해야 한다. 운영 데이터나 비밀키를 테스트 fixture에 넣지 않는다.

main 병합은 실제 DB 자동 배포일 수 있다. PR #6을 먼저 검토·병합한 뒤 후속 migration을 적용한다. 문제 발견 시 이미 적용된 migration을 수정하거나 테이블을 삭제하지 않고 새 보완 migration을 작성한다.

검증 결과: 최종 로컬 테스트 16/16 통과(기존 회귀 + 그룹/로펌/전체 투표/동점/0표/승인 철회/동의 철회/권한). GitHub Actions도 동일한 격리 DB 테스트를 실행하도록 구성했다. 이 CI는 운영 Supabase 연결이나 배포를 수행하지 않는다.

## 2026-11-23 개발 Supabase 검증

- 대상은 `hande_dev` (`jnpbuulrmgdkzbiywjtd`), PostgreSQL 17이다. 운영 프로젝트와 이름·ID를 구분해 확인했다.
- PR #6은 두 개발 계정의 실제 Auth 로그인, 서비스 프로필, 사례 저장/조회/확정 및 타인 접근 차단 hosted smoke를 사용자의 맥에서 통과한 뒤 병합했다. 운영 DB에도 `20261117010000` 이력이 반영된 것을 읽기 전용으로 확인했다.
- PR #7 base는 main으로 변경하고 main을 작업 브랜치에 병합했다. PR #7 자체는 병합하지 않았다.
- 개발 DB에는 `20261117020000`~`20261117050000` migration을 적용했다. 실행 환경에서 pooler 직접 연결이 거절되어 `db push`는 실행하지 못했고, CLI `db query --remote=<개발 ID>`의 HTTPS 경로로 원본 SQL과 migration 이력을 같은 트랜잭션에 반영했다. 기존 적용 SQL을 수정하거나 DB를 초기화하지 않았다.
- `supabase/tests/hosted_groups_workflow.sql`은 실제 개발 DB에서 실행했다. 10명 대표자 선거, 중복 표 upsert, 비참여자 거절, 사용자 마감 거절, 서버 마감, 동점/0표/재투표, 소송 방법 선택, 로펌 신청·승인 경계·제안·선정, 익명 집계, 동의 전/후·철회·연락처 수정·미선정 로펌 접근, 공지·알림 읽음 및 익명 테이블 접근 거절을 검사했다.
- 위 SQL은 가상 Auth 행, 가상 Storage **메타데이터**, 가상 동의 버전을 트랜잭션 안에서만 만들고 마지막에 ROLLBACK한다. 실제 파일 업로드나 실제 회원 가입 HTTP 테스트를 대체하지 않는다. 운영 DB에서 실행하지 않는다. CLI 응답의 PASS marker와 테스트 fixture 0건을 확인한다.

개발 프로젝트에서 재실행하는 명령(CLI 3.x):

```bash
supabase db query --remote=jnpbuulrmgdkzbiywjtd \
  --file supabase/tests/hosted_groups_workflow.sql --yes
```

이 검증은 DB 역할과 JWT claim을 설정한 SQL 검사다. PR #7 전체 흐름의 실제 Auth/PostgREST HTTP, 다중 연결 경합, Storage 바이트 업로드, NTS, Cron 예약 호출, 프론트 화면 통합은 완료로 표시하지 않는다. Cron 등록과 운영 동의문 활성화는 별도 담당자 작업으로 남긴다.
