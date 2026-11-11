# 권한·기능 처리 계약

이 문서는 구현해야 할 RLS/컬럼 권한/RPC 계약이다. 정책이 이미 적용되어 있다는 뜻은 아니다. 모든 public 테이블은 RLS 활성화 및 기본 차단으로 생성하고, 아래 경로를 구현·테스트한 뒤 노출한다.

## 1. 신원과 역할

- 본인 ID는 auth.uid()에서 얻는다. 요청 body의 user_id/owner_id를 권한의 근거로 믿지 않는다.
- role=user/firm은 신뢰된 가입 완료 처리로 한 번 설정한다. 수정 가능한 사용자 metadata를 운영자/로펌 승인 근거로 사용하지 않는다.
- 참여자/대표자는 그룹별 관계다. active member = group_members.left_at IS NULL, 대표자는 거기에 is_rep=true.
- 선정 로펌 = group_selections → proposals → firms.owner_id가 현재 사용자와 일치하는 로펌.
- 운영자는 비공개 app_operators를 신뢰된 DB 경로에서 확인한다. 운영자가 실제 DB 관리 도구로 승인하는 시연에서는 클라이언트용 승인 API를 만들지 않아도 된다.

## 2. 테이블별 접근

| 대상 | 조회 | 생성/변경 | 공개하면 안 되는 것 |
| --- | --- | --- | --- |
| profiles | 본인 전체, 그룹 참여자에게 닉네임 전용 RPC | 본인 nickname만; role/id 불변 | 같은 행 전체를 그룹 참여자에게 SELECT 허용하지 않음 |
| profiles_private | 본인만 직접 조회. 선정 로펌은 제한 RPC | 본인 실명/연락처 수정 RPC | 전역 연락처 목록 |
| user_terms_acceptances | 본인 | 버전 검증된 가입 처리에서 기록, 과거 수락 행 변경 불가 | 다른 회원 수락 이력 |
| app_operators | 신뢰된 관리자/권한 도우미만 | DB 관리자만 | 공개 API 전체 |
| firms | 본인+운영자. 공개용 이름은 RPC로 별도 | 본인 기본 정보, 사업자 조회 결과는 BE1 신뢰 경로, 승인 필드는 운영자만 | 사업자번호/증빙/반려 사유를 일반 조회에 포함하지 않음 |
| firm_lawyers | 본인+운영자, 제안 공개에는 제출 스냅샷만 | 본인 로펌 변호사 정보, 승인 후 변경은 재검토 정책 확정까지 차단 | 등록번호 전역 공개 |
| reports/report_fields | 작성자 본인만 | 본인 draft/organized. 제출은 RPC | 원문·유출정보·AI 근거의 그룹 공개 |
| evidences | 작성자 본인만 | 업로드/삭제 RPC. ready는 Storage 실체 확인 뒤 | 파일 경로를 공개 목록에 포함하지 않음 |
| groups | 누구나 공개 요약 RPC | 일반 사용자 create_group, 운영 관련 변경은 대표자 RPC 또는 시스템 | created_by 등 불필요한 계정 식별자와 내부 정보 |
| group_members | 본인 참여행, 같은 그룹은 닉네임/피해 정도/시기 전용 RPC | join_group/leave_group만 | report_id/원문/실명/연락처 |
| group_selections | 공개 그룹 요약에 선정 로펌명, 내부 결과는 그룹 참여자/선정 로펌 | 마감 처리만 | 참여자 개인정보 |
| group_contact_consents | 본인, 선정 로펌은 제공 대상 RPC의 판정에만 사용 | 본인 grant/revoke RPC | 다른 그룹 동의로 확장 |
| polls/poll_options | 해당 그룹 참여자, 로펌은 자기 제안이 포함된 firm 투표 요약 | 투표 관리 RPC만 | 다른 그룹 내부 투표 |
| representative_candidates | 해당 그룹 참여자 | 본인 후보 신청, 투표 시작 전만 | 임의 타인 후보 등록 |
| poll_electors | 본인만 | 시스템 시작 처리만 | 투표 명부 전체 |
| ballots | 본인 행만 | cast_* RPC만. 직접 INSERT/UPDATE/DELETE 차단 | 다른 사람의 선택/투표자 ID |
| poll_results | 그룹 참여자, 로펌은 자기 제안의 득표 요약 | 마감 처리만 | 투표자 식별정보 |
| proposals | 작성 로펌과 해당 그룹 활성 참여자 | 승인된 로펌이 자기 제안만 제출/수정 RPC | 다른 그룹 제안서 |
| notices | 해당 그룹 참여자 | 현재 대표자가 작성/수정/삭제 RPC | 외부 공개 |
| group_events | 그룹 참여자, 선정 로펌에는 허용 이벤트만 | 시스템만 | payload에 개인정보 기록 |
| notifications | 본인만 | 시스템 생성, 본인은 read_at만 수정 | 수신자/내용 임의 변경 |
| public_stats | 누구나 | BE1 적재 작업만 | 관리 비밀값 |

RLS는 행 단위다. 역할, 승인 상태, selected 결과 같은 보호 컬럼은 컬럼 GRANT 제한 또는 RPC 전용 쓰기로 보호한다. 공용 조회는 허용 컬럼을 나열한 RPC로 구현한다. 민감 테이블을 읽는 SECURITY DEFINER 함수는 private 도우미 사용, 빈 search_path, 스키마 한정 이름, 호출자 명시적 권한 검사, PUBLIC 실행권한 회수, 필요한 DB 역할만 GRANT를 요구한다. RLS 재귀를 유발하는 같은 테이블 정책 상호 조회는 비공개 membership 도우미로 분리하고 테스트한다.

## 3. RPC 계약 초안

구체적인 JS 입력·출력과 DB 변환은 [연동 계약](integration-contract.md)을 따른다. 아래 표는 DB 처리 요약이다. 이름은 v2와 최대한 맞춘다. UUID는 프론트에서 하드코딩하지 않는다. 아래 함수는 아직 구현되지 않았다.

| 함수 | 입력 → 출력 | 처리 조건/원자성 |
| --- | --- | --- |
| complete_signup | role,nickname,real_name,phone,terms → profile | Auth 세션 필수, user 실명/연락처 필수, admin 불가. 이메일/비밀번호는 Auth API로 별도 처리 |
| create_firm_application | firm_name,biz_no,cert_path,lawyers → firm | firm 계정, 소유 증빙, pending 초기화. biz_status/approved 입력 불가 |
| save_report | report_id?,raw_text,fields → report_id | 본인, 길이/항목 타입 확인. AI source를 신뢰된 사실로 취급하지 않음 |
| create_group | report_id,공개 초안,goal?,deadline? → group_id | report 소유권, 개인정보 유출 scope, 공개 정제. 그룹/본인 참여행/제출 상태를 한 트랜잭션으로 생성 |
| join_group | group_id,report_id → membership | user, 사례 본인 소유, 모집 허용 상태/시각. 같은 사례로 활성 중복 요청은 기존 결과 반환; 다른 사례 또는 탈퇴 후 재합류는 정책 확정 전 CONFLICT |
| leave_group | group_id → membership | 탈퇴 허용 시점 검토 후 구현. 대표자 공석/투표 자격 처리도 함께 검사 |
| get_group_members | group_id → nickname,damage_level,period | 활성 참여자, 실제 식별자/원문 제외 |
| apply_representative | poll_id → candidate | 활성 참여자 본인, representative 종류, 후보 모집 기간 내 |
| open_poll | group_id,kind,opens_at,closes_at → poll_id | method/firm은 대표자만, 최초 representative 시작 주체는 검토 필요. 대표자 선거에만 >=10 활성 인원, 후보/선택지 검증, 유권자 스냅샷 |
| cast_representative_vote | poll_id,option_id → my_ballot | 자격/후보 검사, 회차당 1표 |
| cast_method_vote | poll_id,choice → my_ballot | choice는 해당 poll 선택지여야 함 |
| cast_firm_vote | poll_id,proposal_id → my_ballot | 해당 그룹, 제출된 제안, suit 단계 |
| close_vote | poll_id → state,winner,counts | 서버 전용, closes_at 도래 후만. 아래 잠금/집계 절차 적용 |
| get_vote_summary | poll_id → counts,total,my_choice,closed | 참여자에게 실시간 집계. 로펌은 자기 제안의 집계만. 다른 사람 표 행 없음 |
| recommend_method | group_id → method,reason,rule_version | 참여자, 사례·인원 기준 안내값. 법적 자격 보장 아님. 우선순위/기준은 BE1과 검토 |
| submit_proposal | group_id,제안 필드 → proposal_id | 승인된 로펌+active 사업자, suit, 접수 마감 전, 투표 시작 전. 그룹당 로펌당 1개 |
| update/withdraw_proposal | proposal_id,변경값 → proposal | 본인 제안, 투표 선택지 확정 전만 |
| get_group_stats | group_id → member_count,secondary_ratio,evidence_ratio | 승인된 로펌, suit 그룹만. 비공개 원문/개인 행 제외 |
| grant_contact_consent | group_id,selected_proposal_id,consent_version → consent | 본인 활성 참여, 현재 선정 제안 일치, 실명/연락처 확인. 다른 로펌 ID 입력 불허 |
| revoke_contact_consent | group_id → revoked_at | 본인 동의만 철회 |
| get_selected_contacts | group_id → nickname,real_name,phone | 현재 선정 로펌 본인, 활성 참여+유효한 해당 제안 동의자만 |
| create_notice | group_id,title,body → notice | 현재 대표자만, 내용 길이 검사 |

프론트는 `castFirmVote({pollId,proposalId})`를 호출하고 데이터 모듈이 DB의 `cast_firm_vote({poll_id,proposal_id})`로 변환한다. 성공 `{data:{pollId,optionId,updatedAt}}`, 실패 `{error:{code,message}}`는 데이터 모듈에서 정규화한다. 원시 Supabase 응답 형식과 구분한다. user_id는 서버가 결정하고 오류에 원문·연락처·비밀키를 넣지 않는다.

## 4. 투표 트랜잭션과 자동 마감

투표 RPC와 마감 RPC는 **같은 polls 행을 SELECT FOR UPDATE**로 잠근다. 잠금을 획득한 뒤 clock_timestamp()로 현재 시각을 확인한다. 트랜잭션 시작 시각을 고정하는 now()만 사용해 대기 후 마감된 표가 들어오지 않도록 한다.

1. 투표: 세션 → 그룹/유권자/활성 참여 검사 → polls 잠금 → opens_at<=현재<closes_at 및 open/scheduled 확인 → 선택지 검사 → ballots upsert. 브라우저에서 임의 집계 쓰기 금지.
2. 자동 작업: 주기적으로 opens_at/closes_at이 도래한 투표 탐색. Supabase Cron의 지연과 무관하게 투표 RPC 자체가 시각 제한을 집행한다. 실행 주기는 운영 설정(예: 1분)이며 정확히 0초 지연을 보장하지 않는다.
3. 마감: polls 잠금 → 이미 최종 상태면 저장 결과 그대로 반환 → 모든 선택지 0표 포함 집계 → poll_results 저장 → 단독 최다 선택지면 winner 확정 → 해당 그룹 대표자/method/group_selections 반영 → group_events와 중복 방지 알림 기록 → commit.
4. 동점은 tied, 0표는 no_votes로 저장하고 임의 우승자 선정 금지. 동점 재투표는 새 poll.id와 round_no로 기록한다. 누가 언제 재투표를 여는지/0표 후속 처리는 검토 항목.
5. 제안 수정과 firm 투표 시작도 groups 행 잠금을 같은 순서(groups→polls)로 획득해 선택지 확정과 경합하지 않게 한다. 모든 그룹 변경 RPC는 잠금 순서를 통일한다.

공개 득표는 그룹 참여자에게만 제공하고 로펌은 자기 득표만 제공하는 기본안을 유지한다. 공개 범위를 익명 방문자까지 넓히는 것은 확정사항이 아니다. 통계 공개로 특정 시점 전후의 선택을 추측할 가능성까지 없애는 익명 투표를 보장하는 것은 아니다.

## 5. 상태 전이

| status/sub_status | 전이 조건 |
| --- | --- |
| recruiting/recruiting | 그룹 생성·피해자 모집 |
| recruiting/rep_election | 활성 참여자 10명 이상, 후보 모집/투표 |
| connecting/method_vote | 대표자 선정 완료 후 대표자가 대응 투표 개시 |
| connecting/proposal_collection | method=suit 확정, 제안 마감 설정 |
| connecting/firm_vote | 제안 접수 마감, 유효 제안 확정 후 투표 개시 |
| in_progress/connected | 선정 로펌 또는 다른 대응 방법 연결 완료 |
| closed/closed | 운영자 처리로 종결, 요약 기록 |

non-suit 분쟁조정 결정 후 연결 완료를 누가 확인하는지, 종결 권한 세부는 검토 필요. 제안 마감은 투표 마감과 다르므로 `groups.proposal_deadline timestamptz?`를 추가해 관리한다. method/firm 투표 종료 시각은 polls가 원본이다. 대표자 없는 최초 투표는 역할 순환 문제이므로 구현 전 시작 주체를 반드시 확정한다.

## 6. 파일과 연락처

- 비공개 버킷을 피해 증빙/사업자 증빙으로 나눈다. 경로는 user_id/report_id/random-id.ext. 원본 이름은 DB 표시용이며 경로 식별자로 쓰지 않는다.
- 파일당 10,000,000 bytes, image/jpeg,image/png,application/pdf. 확장자·MIME·실제 형식을 검사하는 업로드 경로를 BE1이 구현한다. 입력한 MIME 문자열만 신뢰하지 않는다.
- Storage 객체 정책에서도 소유자/연결 사례/로펌 자격을 확인한다. evidences 메타데이터 RLS만으로 파일 실체가 보호된다고 가정하지 않는다.
- private bucket과 짧은 만료 signed URL 사용. 링크 발급 때마다 권한 재확인. 파일 삭제 실패 시 재시도하고 orphan 정리. 업로드 중 pending 행을 evidence 보유율에 세지 않는다.
- 실명·연락처 동의는 증거 원본 제공 동의가 아니다. 증거를 로펌에 공개하는 정책은 별도 확정까지 기본 차단한다.
- 프로필 연락처 수정 RPC는 변경값 검증 후 기존 유효 제공 동의를 철회하는 기본안을 제안한다. 새 값 제공은 재동의. 동의 문구 버전/철회 이력을 보존한다.
- 서비스 키/NTS 키는 브라우저나 저장소에 넣지 않는다. RLS 우회 키를 FE 연결에 사용하지 않는다.
