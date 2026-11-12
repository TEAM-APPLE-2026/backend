# BE1·BE2·프론트 연동 계약 초안 — 2026-11-11

기능명세서 v2와 확정된 7.2를 기존 설계에 반영한 협의용 수정본이다. 실행 SQL/API 구현이나 Supabase 적용 결과가 아니다. 테이블 상세는 [schema.md](schema.md), 권한은 [permissions-and-rpc.md](permissions-and-rpc.md)를 따른다. 아래 새 계약은 팀 확인 후 고정한다.

## 1. 이름과 공통 응답

- DB 테이블·컬럼·RPC 이름과 RPC 인자: snake_case. 프론트 함수·JS 객체 키: camelCase.
- FE 데이터 모듈이 camelCase ↔ snake_case를 명시적으로 변환한다. DB JSONB 내부 key는 아래 AI 계약을 사용하며 무차별 재귀 변환하지 않는다.
- UUID는 string, 날짜는 YYYY-MM-DD, 시각은 UTC ISO 8601 string, 비율은 0~1 number, 미정 값은 null, 목록은 빈 배열을 사용한다. 금액은 정수 KRW, 비율 비용은 0~100 number.
- 성공은 `{ data: T }`, 실패는 `{ error: { code, message } }`의 배타적 형태. 성공에 error:null을 섞지 않는다.
- 이 형식은 **프론트 데이터 모듈의 반환 계약**이다. Supabase Auth/RPC의 원시 응답을 그대로 이 모양이라고 가정하지 않는다. 어댑터가 DB·Auth·네트워크 오류를 허용된 코드로 변환하며 원시 SQL 오류는 노출하지 않는다.
- 목록 조회 성공에 항목이 없으면 `{ data: { items: [], nextCursor: null } }`. 빈 결과는 오류가 아니다. 권한 차단을 빈 목록으로 위장하지 않도록 서버가 권한을 먼저 검사한다.
- 공개 자원 단건 부재는 NOT_FOUND. 비공개 자원은 존재 여부를 숨기기 위해 미존재/미권한을 NOT_FOUND로 통일할 수 있다. 로그인 필요는 AUTH_REQUIRED.
- 목록 입력 기본 limit=20, 최대 100. cursor는 서버 생성 opaque string, 마지막 페이지 nextCursor=null. 기본 정렬 created_at DESC,id DESC; 해당 필드 없는 목록은 별도 정의한다.
- 예시의 `<uuid>`는 타입 자리표시자이며 실행 fixture가 아니다. 호출자 userId/ownerId/승인 상태는 요청으로 받지 않는다.

| code | 화면 처리 |
| --- | --- |
| AUTH_REQUIRED | 로그인 안내 |
| LOGIN_FAILED | 이메일·비밀번호 확인 안내, 계정 존재 여부 비공개 |
| FORBIDDEN | 권한 없음 |
| FIRM_NOT_APPROVED | 승인 대기/반려 안내 및 최신 상태 재조회 |
| NOT_FOUND | 대상 없음 |
| PROFILE_INCOMPLETE | 로그인은 유지하고 프로필 입력 화면 표시 |
| INVALID_INPUT | 필드 확인 안내 |
| NOT_ELIGIBLE | 참여/투표 자격 안내 |
| POLL_NOT_OPEN / POLL_CLOSED | 투표 예정/마감 화면 및 재조회 |
| PROPOSAL_CLOSED | 제안 접수 마감 안내 |
| CONFLICT | 상태 변경 안내 후 재조회 |
| AI_TIMEOUT / AI_FAILED | 분석 재시도·직접 수정 안내 |
| NETWORK_ERROR / INTERNAL_ERROR | 재시도 안내 |

HTTP Edge API를 만드는 경우 AUTH_REQUIRED=401, FORBIDDEN/FIRM_NOT_APPROVED=403, NOT_FOUND=404, INVALID_INPUT=400, 상태 충돌=409, INTERNAL_ERROR=500을 제안한다. DB RPC의 원시 HTTP 상태와 이 매핑이 자동으로 같아지는 것은 아니다.

## 2. 공통 데이터 모양

아래는 JS 모듈/임시 API의 타입 표기다. 모든 프로퍼티는 명시된 경우 외에는 필수다. 상세 DB 필수/NULL 여부는 schema.md가 원본이다.

```ts
type Id = string;
type Time = string;
type Page<T> = { items: T[]; nextCursor: string | null };
type Profile = { id: Id; role: 'user' | 'firm'; nickname: string };
type Firm = { id: Id; firmName: string;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  bizStatus: 'unchecked' | 'active' | 'suspended' | 'closed' | 'unknown';
  rejectReason: string | null };
type Group = { id: Id; name: string; company: string; harmType: 'privacy_leak';
  status: 'recruiting' | 'connecting' | 'in_progress' | 'closed';
  subStatus: 'recruiting' | 'rep_election' | 'method_vote' | 'proposal_collection' | 'firm_vote' | 'connected' | 'closed';
  memberCount: number; description: string; conditions: string;
  periodStart: string | null; periodEnd: string | null;
  requiredEvidence: string[]; goal: number | null; deadline: Time | null;
  proposalDeadline: Time | null; method: Method | null; selectedFirmName: string | null };
type Method = 'med' | 'consumer' | 'collective' | 'suit';
type Membership = { groupId: Id; isRep: boolean; joinedAt: Time; leftAt: Time | null };
type ProposalInput = { retainerFee: number; successFeePct: number; period: string;
  strategy: string; lawyerCount: number; leadLawyer: string };
type Proposal = ProposalInput & { id: Id; groupId: Id; firmId: Id; firmName: string;
  status: 'draft' | 'submitted' | 'withdrawn'; submittedAt: Time | null; updatedAt: Time };
type Ballot = { pollId: Id; optionId: Id; updatedAt: Time };
type PollState = 'scheduled' | 'open' | 'closed' | 'tied' | 'no_votes' | 'cancelled';
type VoteSummary = { pollId: Id; kind: 'representative' | 'method' | 'firm';
  state: PollState; opensAt: Time; closesAt: Time; serverTime: Time;
  totalVotes: number; options: { optionId: Id; label: string; voteCount: number }[];
  myOptionId: Id | null; winnerOptionId: Id | null };
```

Group은 공개용 허용 필드만 포함한다. 내 권한·참여 여부는 별도 본인 membership으로 얻는다. Proposal의 금액은 1인당 착수금이다. VoteSummary는 그룹 참여자용이며 개별 투표자 목록을 포함하지 않는다.

## 3. 함수 목록과 입력·출력

표의 출력 T는 공통 `{data:T}`에 들어간다. 입력은 JS camelCase이며 DB 호출 때 snake_case로 바꾼다. 모든 쓰기 함수는 서버가 인증·권한·입력·단계를 다시 검사한다. 물음표는 입력 생략 가능이다. 아래 추가 조회 함수도 **아직 미구현인 계약 제안**이다.

| JS 함수 → DB RPC/처리 | 입력 | 출력 T | 접근/조건 |
| --- | --- | --- | --- |
| signUp / signIn / signOut → Supabase Auth | 이메일·비밀번호 등 Auth 입력 | 인증 결과를 FE 세션 모듈에서 처리 | 비밀번호 DB RPC 전달/저장 금지; 아래 가입 완료는 세션 확보 후 |
| completeSignup → complete_signup | {role,nickname,realName,phone,terms:[{documentKey,version}]} | Profile | 일반 사용자 실명·연락처 필수; role은 user/firm만 |
| getMyProfile → get_my_profile | {} | {profile:Profile,realName:string|null,phone:string|null,firm:Firm|null} | 본인; DB 승인 후 재조회 |
| updatePrivateProfile → update_private_profile | {realName,phone} | {updatedAt:Time,requiresReconsent:boolean} | 본인; 기존 제공 동의 철회는 팀 확인할 기본안 |
| createFirmApplication → create_firm_application | {firmName,bizNo,certPath,lawyers:[{name,regNo}]} | Firm | firm 역할; pending 초기화; 파일 소유권 확인 |
| saveReport → save_report | {reportId?:Id,rawText:string,fields:ReportField[]} | {reportId:Id,status:'draft'|'organized',updatedAt:Time} | 본인; 원문 1~2000자; source별 값 타입 검사 |
| getReport → get_report | {reportId:Id} | {id:Id,rawText:string,status:string,fields:ReportField[],updatedAt:Time} | 작성자만 |
| listGroups → list_groups | {company?:string,harmType?:'privacy_leak',status?:Group['status'],cursor?:string,limit?:number} | Page<Group> | 공개 조회; 원문·연락처 제외 |
| getGroup → get_group | {groupId:Id} | Group | 공개 요약 |
| getMyMembership → get_my_membership | {groupId:Id} | Membership|null | 본인, 미참여는 null |
| createGroup → create_group | {reportId:Id,name,company,harmType:'privacy_leak',description,conditions,periodStart?:string,periodEnd?:string,requiredEvidence:string[],goal?:number,deadline?:Time} | {groupId:Id,membership:Membership} | 본인 사례; 그룹/참여행 동시 생성; 자동 대표자 아님 |
| joinGroup → join_group | {groupId:Id,reportId:Id} | Membership | 같은 사례로 활성 중복 요청은 기존 결과 반환; 다른 사례/탈퇴 후 재합류는 CONFLICT, 정책 확정 전 차단 |
| leaveGroup → leave_group | {groupId:Id} | Membership | 상세 탈퇴 정책 미정; 정책 확정 전 제공 보류 |
| getGroupMembers → get_group_members | {groupId:Id,cursor?:string,limit?:number} | Page<{nickname:string,damageLevel:string|null,period:{from:string|null,to:string|null}}> | 활성 참여자; 개인 ID·원문 제외; joined_at DESC,user_id DESC 정렬 |
| applyRepresentative → apply_representative | {pollId:Id} | {pollId:Id,appliedAt:Time} | 후보 모집 기간/시작 주체 미정; 확정 전 제공 보류 |
| openPoll → open_poll | {groupId:Id,kind:'representative'|'method'|'firm',opensAt:Time,closesAt:Time} | {pollId:Id,state:PollState,opensAt:Time,closesAt:Time} | method/firm 대표자; 최초 선거는 미정. 인원 10명 기준은 대표자 선거에만 적용 |
| castRepresentativeVote → cast_representative_vote | {pollId:Id,optionId:Id} | Ballot | 해당 회차 유권자·활성 참여자 |
| castMethodVote → cast_method_vote | {pollId:Id,choice:Method} | Ballot | 해당 회차의 method 선택지 |
| castFirmVote → cast_firm_vote | {pollId:Id,proposalId:Id} | Ballot | 해당 그룹의 firm 선택지 |
| getVoteSummary → get_vote_summary | {pollId:Id} | VoteSummary | 활성 참여자, 진행 중 집계 공개 |
| getMyProposalVoteSummary → get_my_proposal_vote_summary | {pollId:Id} | {pollId:Id,state:PollState,closesAt:Time,myProposalId:Id,myVoteCount:number} | 로펌 본인의 제안 득표만; 경쟁 로펌·개별 투표자 제외 |
| recommendMethod → recommend_method | {groupId:Id} | {method:Method,reason:string,ruleVersion:string} | 참여자; 추천 규칙 미정, 임시 API 안내값임을 표시 |
| submitProposal → submit_proposal | {groupId:Id,proposal:ProposalInput} | Proposal | approved+사업자 active, suit, 접수 기간; 그룹·로펌당 1개 |
| updateProposal → update_proposal | {proposalId:Id,proposal:ProposalInput} | Proposal | 소유 로펌; 선택지 확정 전 |
| withdrawProposal → withdraw_proposal | {proposalId:Id} | {proposalId:Id,status:'withdrawn',updatedAt:Time} | 소유 로펌; 선택지 확정 전 |
| listProposals → list_proposals | {groupId:Id,cursor?:string,limit?:number} | Page<Proposal> | 참여자에게 submitted만; 로펌에게 본인 것만 |
| getGroupStats → get_group_stats | {groupId:Id} | 아래 익명 집계 | 승인된 로펌, suit 그룹 |
| grantContactConsent → grant_contact_consent | {groupId:Id,selectedProposalId:Id,consentVersion:string} | {consentId:Id,grantedAt:Time,revokedAt:null} | 본인 활성 참여, 현재 선정 제안 확인 |
| revokeContactConsent → revoke_contact_consent | {groupId:Id} | {revokedAt:Time|null} | 본인; 유효 동의 없으면 null |
| getSelectedContacts → get_selected_contacts | {groupId:Id,cursor?:string,limit?:number} | Page<{nickname:string,realName:string,phone:string}> | 현재 선정 로펌만, 해당 제안 유효 동의자만; 동의 granted_at DESC,id DESC 정렬 |
| createNotice → create_notice | {groupId:Id,title:string,body:string} | {noticeId:Id,createdAt:Time} | 현재 대표자 |
| listNotices → list_notices | {groupId:Id,cursor?:string,limit?:number} | Page<{id:Id,title:string,body:string,createdAt:Time}> | 활성 참여자 |
| listNotifications → list_notifications | {cursor?:string,limit?:number} | Page<{id:Id,type:string,groupId:Id|null,payload:object,createdAt:Time,readAt:Time|null}> | 본인; payload에는 개인정보 금지 |
| markNotificationRead → mark_notification_read | {notificationId:Id} | {notificationId:Id,readAt:Time} | 본인; 읽음 시각만 변경 |
| close_vote (서버 전용) | {poll_id:Id} | {poll_id:Id,state:PollState,winner_option_id:Id|null,counts:[{option_id:Id,vote_count:number}]} | Cron/신뢰된 서버만, 사용자에게 EXECUTE 금지 |

### 요청·응답 예시

```json
{"pollId":"<uuid>","proposalId":"<uuid>"}
```

castFirmVote 입력을 DB에는 `{poll_id,proposal_id}`로 보내고, 성공 결과는 다음처럼 변환한다.

```json
{"data":{"pollId":"<uuid>","optionId":"<uuid>","updatedAt":"2026-11-13T09:00:00Z"}}
```

```json
{"error":{"code":"POLL_CLOSED","message":"투표가 마감되었습니다."}}
```

## 4. AI 결과 → report_fields (BE1과 맞출 제안)

소민님 피드백의 v0.2.0 형식(company/type/notice_date/leaked/secondary/card)을 기본으로 사용한다. 이번 수정에서 secondary_detail 문자열 키를 추가하는 안을 반영한다. BE1 AI 모듈에도 이 키 반영이 필요하며 현재 AI 코드가 이미 지원한다고 주장하지 않는다.

```ts
type FieldKey = 'company' | 'type' | 'notice_date' | 'leaked' | 'secondary' | 'secondary_detail' | 'card';
type FieldValue = string | string[] | { from: string | null; to: string | null;
  precision: 'day' | 'month' | 'year' | 'unknown' };
type ReportField = { key: FieldKey; aiValue: FieldValue | null; quote: string | null;
  userValue: FieldValue | null; source: 'ai' | 'user'; needsCheck: boolean };
```

| key | 값 구조 제안 | DB 저장 |
| --- | --- | --- |
| company | 기업명 string | ai_value / user_value |
| type | privacy_leak string | 동일 |
| notice_date | 유출 안내를 받은 시점 {from,to,precision}; 알려지지 않은 날짜 null | 동일; 월/연도 정밀도는 해당 범위 시작·끝 ISO 날짜 |
| leaked | string[] | 동일 |
| secondary / card | yes / no / unknown string | 동일 |
| secondary_detail | 2차 피해 상세 string, 없거나 추출 불가 시 null | 동일; 예: 스미싱 문자 3회 |

필드마다 위 타입을 서버에서 따로 검증한다. 추출 불가면 aiValue=null, needsCheck=true. 사용자가 수정하면 userValue와 source만 바꾸며 aiValue/quote를 보존한다. source=user이면 userValue 필수. quote는 원문 내 근거이며 외부 공개하지 않는다. 사용자 확인 완료와 source는 별개이므로 수정 없이 확인했을 때도 needsCheck=false 가능하다. notice_date는 유출 안내(통지)를 받은 시점으로 통일하고, 실제 유출 발생일은 이번 범위에서 별도 수집하지 않는다. Group.periodStart/periodEnd 및 getGroupMembers.period도 통지 시점 범위이며 UI에 발생일로 표시하지 않는다. secondary_detail과 quote는 작성자 전용이며 getGroupStats/summarize 입력에 포함하지 않는다. 상세가 있다고 secondary=yes로 자동 확정하지 않고 사용자가 확인한 항목값을 따른다.

AI warnings는 사용자 안내용으로 분리하고 report_fields 키로 저장하지 않는다. 주민번호·계좌·카드번호를 AI 반환값/quote/warnings에 그대로 노출하지 않도록 BE1 출력 경계에서 검사한다. raw_text는 별도 비공개 원문이며 AI 마스킹만으로 자동 정제됐다고 간주하지 않는다. AI가 해당 민감값을 추출하지 않아도 사용자가 입력한 원문 보관 권한은 그대로 제한한다.

AI 추천 점수·근거는 권한/참여 자격의 근거가 아니며 브라우저 AI 출력으로 승인·집계 필드를 변경할 수 없다. 추출·매칭 모듈의 타임아웃은 초기 20초, 재시도는 사용자가 선택한다.

## 5. 로펌용 익명 집계 결과

```json
{"data":{"groupId":"<uuid>","memberCount":5,"secondaryYesCount":2,"secondaryKnownCount":4,"secondaryUnknownCount":1,"secondaryRatio":0.5,"evidenceHolderCount":3,"evidenceRatio":0.6,"asOf":"2026-11-13T09:00:00Z"}}
```

- memberCount: left_at IS NULL인 활성 참여자 수. 이하 집계도 동일 모집단.
- secondaryKnownCount: 연결된 사례의 최종 secondary 값이 yes/no인 인원. unknown/누락은 unknownCount. secondaryRatio=yes/known, known=0이면 null.
- evidenceHolderCount: 연결 사례에 ready 증빙이 1개 이상인 인원(파일 수가 아님). evidenceRatio=holder/member, member=0이면 null.
- 빈 그룹은 counts=0, ratio=null인 성공 응답. 원문·AI 근거·회원 ID·연락처·파일 경로는 포함하지 않는다.
- 비율 정의/소규모 집계 노출 범위는 협의용 기본안. 이름을 제거해도 소수 그룹 재식별 가능성까지 없어지는 것은 아니다. 공개 방문자에게 제공하지 않는다.

## 6. 역할·승인·파일·마감 연결

| 항목 | 저장/판정 | 담당 연결 |
| --- | --- | --- |
| 계정 역할 | profiles.role=user/firm | BE2 가입 완료 RPC; 운영자 승격 불가 |
| 대표자 | group_members.is_rep, 활성 그룹별 최대 1명 | BE2 선거 결과만 변경 |
| 로펌 승인 | firms.approval_status=pending/approved/rejected | 운영자 DB 승인, 프론트 재조회 |
| 사업자 상태 | firms.biz_status와 biz_checked_at | BE1 nts-verify Edge Function이 본인 로펌 검증 후 직접 갱신; 별도 DB RPC 추가하지 않음 |
| 파일 | evidences.bucket_id/object_path/status 등 | 비공개 evidences·firm-certs 버킷 제안 반영; 등록증 경로는 아래와 같이 별도 구분 |
| 파일 접근 | 사례 작성자만 기본 허용, 로펌 원본은 별도 정책 확정 전 차단 | Storage 정책과 DB 권한 함께 검증 |
| 자동 마감 | polls.closes_at + 서버 close_vote | BE2 원자적 집계, BE1 Cron 설정; 대표자가 기간 지정 |
| 알림 | notifications; user_id+dedupe_key 유일 | 마감·선정 트랜잭션에서 중복 없이 생성 |

파일당 JPG/JPEG·PNG·PDF 10MB=10,000,000 bytes로 Storage/DB/FE를 맞춘다. 피해 증빙 경로는 evidences/{user_id}/{report_id}/{file_id}.{ext}. 로펌 등록증은 report_id가 없으므로 firm-certs/{user_id}/{file_id}.{ext}를 제안한다(신청 전 업로드 지원). 각 버킷 내부 경로에는 버킷 이름을 중복 넣지 않는다. 신청 RPC에서 등록증 객체 소유자와 실제 존재를 확인한다. 파일 완료 처리는 BE1 신뢰 경로가 실체·크기·형식을 확인한 뒤 ready로 바꾸며 클라이언트가 ready를 직접 지정하지 않는다. 업로드·서명 URL 발급 API의 상세 모양은 BE1 전달 후 추가한다.

BE1은 backend/supabase/migrations에 Cron 등록 SQL을 작성해 1분마다 만료 투표를 탐색하도록 한다. close_vote는 poll_id를 받으므로 인자 없는 close_vote()를 호출하지 않는다. 서버 전용 배치가 만료된 scheduled/open 투표 ID별로 close_vote(poll_id)를 호출하고, 한 투표 실패는 기록 후 재시도한다. 함수 구현 전에는 Cron 등록 migration을 배포하지 않는다. 실제 집계 전이어도 마감 이후 표는 RPC에서 거절한다. close_vote 재실행은 같은 결과를 반환하고 알림을 중복 생성하지 않는다. 동점은 tied로 보존하고 새 회차 재투표; 최초 대표자 투표 개시/후보 모집/0표/재투표 개시 세부는 미정이다.

## 7. 전달·구현 순서

1. 먼저 테이블·필드와 이 API 계약을 BE1·FE가 확인한다. 위 '제안'은 아직 팀 확정값이 아니다.
2. BE1 AI 결과(11/13), env/CI(11/14), 국세청·Storage(11/19), 시연 데이터(11/22)와 차이를 반영한다. 날짜는 전달받은 일정 그대로이며 요일은 재확인한다.
3. 공동 프로젝트는 Hande 조직의 TEAM-APPLE-2026(backend 레포 연결, ref=nchmitaoxqodsjmhmphi) 하나를 사용한다. 별도 프로젝트를 생성하지 않는다. SQL·Edge Functions·Storage 버킷/정책·Cron·seed.sql 등 Supabase 배포 대상은 backend/supabase에서 관리하고, 정리·매칭·요약 AI 모듈만 hande_ai에서 관리한다.
4. 후속 구현 PR: 테이블+RLS → 사례/그룹 RPC → 투표/제안/선정 → 연락처 동의/알림. 실행 SQL은 supabase/migrations에 버전 순서대로 추가한다.
5. 임시 API와 실제 API는 위 성공/실패/빈 결과 계약을 같이 사용한다. 키·실제 개인정보는 fixture와 저장소에 넣지 않는다.

## 8. 소민님 피드백 반영 및 PR 배포 순서

- B안: #1은 닫고 CONTRIBUTING·PR 양식만 별도 문서 PR로 보존. README/.gitignore/config/CODEOWNERS는 #4 초기 설정 PR이 관리한다.
- #4 초기 설정 검토·병합 → 검증 완료한 #3 회원 SQL 병합 순서. #2와 협업 문서 PR은 DB SQL이 없어 별도로 검토 가능하다. 이 문서 수정 자체는 어느 PR도 병합하지 않는다.
- 소민님이 Deploy to production 활성화를 확인했다. **main에 migration을 병합하면 공동 실제 DB에 자동 적용될 수 있으므로**, 단순 코드 보관으로 취급하지 않는다.
- 대시보드 SQL Editor/테이블 편집은 DB 자체에 즉시 영향을 줄 수 있다. 다만 변경이 Git migration으로 자동 역동기화되지 않으므로 파일에 별도 기록·검토해야 한다. '대시보드 변경은 DB에 반영되지 않는다'는 의미가 아니다.
- 프론트 환경변수 NEXT_PUBLIC_*는 Next.js 규칙이다. Vite라면 VITE_*와 import.meta.env를 사용하므로 실제 프론트 빌드 도구에 맞춰 담당자와 확인한다. 공개 키만 프론트에 전달하며 service role은 금지한다.

### PR #3의 현재 구현과 mock 계약 구분

3장의 표는 목표 계약이다. 이번 회원 기반 PR #3은 일부만 구현했으며 mock도 단계 구분이 필요하다.

| 항목 | PR #3 실제 DB RPC | 목표 계약 / 후속 작업 |
| --- | --- | --- |
| complete_signup | role,nickname,real_name?,phone? → Profile | terms 저장/필수 약관 버전 검증은 후속. 현재 terms 인자를 DB로 보내지 않음 |
| get_my_profile | profile,real_name,phone | firm 필드는 firms 구현 후 추가. 현재 어댑터는 firm:null로 맞출 수 있으나 승인 기능 완료를 뜻하지 않음 |
| 프로필 미완료 | PROFILE_INCOMPLETE | 로그인 세션이 있으면 프로필 입력으로 이동 |
| 개인정보 수정 | 직접 UPDATE 차단 | 연락처 재동의 RPC 구현 후 연결 |
| 로펌 신청·승인 | 아직 미구현 | mock 성공을 실제 서버 구현 완료로 표시하지 않음 |

BE1이 회원·프로필 mock을 만들 때 위 실제 범위를 먼저 맞추고, 약관·로펌 mock은 후속 단계임을 표시한다. AI 새 secondary_detail과 firm-certs 경로는 이 수정본의 제안이므로 BE1 반영 확인이 필요하다.
