# HANDE 데이터베이스 설계

기준: `HANDE_기능명세서_v2.docx`(2026-11-10)와 이후 사용자가 확정한 7.2 의견. Supabase Auth + PostgreSQL + Storage를 사용한다. 이 PR은 **구현 전 설계안**이며 실행 SQL, RLS 정책, RPC 구현이나 실제 DB 변경은 포함하지 않는다.

1. [테이블·컬럼·관계](schema.md): 어떤 정보를 왜 저장하는지, ERD, 제약과 인덱스
2. [권한·기능 처리 계약](permissions-and-rpc.md): 사용자별 접근 범위, 투표·동의·업로드 처리
3. [구현 순서·검증 항목](implementation-plan.md): BE1/BE2/FE 연결 지점, 검토가 필요한 세부 규칙

## 확정 기준

| 항목 | 반영 내용 |
| --- | --- |
| 스택 | Supabase 기반. Java/Spring 가정은 사용하지 않는다. |
| 투표 | 대표자가 기간 설정, 서버 시각 기준 자동 마감 |
| 득표 | 로펌별 득표는 마감 전에도 공개. 개별 투표자의 선택은 본인만 조회 |
| AI | 브라우저 분석, 초기 시간 초과 20초. DB가 아닌 AI/FE 모듈 책임 |
| 증빙 | JPG/JPEG, PNG, PDF, 파일당 10MB. 한글/Word는 사용자가 PDF로 변환 |
| 로펌 승인 | 가입 후 pending. 운영자가 DB에서 승인/반려. 새로고침/재조회로 반영 |
| 실명·연락처 | 가입 때 수집. 본인이 수정 가능. 선정 로펌 제공은 별도 동의 후 |
| 그룹 병합 | 이번 범위에서 제외 |
| 피해 유형 | 개인정보 유출부터 지원 |
| 대표자 | v2 유지: 10명 달성 후 자원자 중 투표로 선정. 개설자 자동 대표자 아님 |

기존 명세서의 '가입 때 연락처 미수집', '로펌 득표 마감 후 공개'보다 위 합의가 우선한다. 최대 파일 개수, 동점 처리 세부 절차 등은 확정 사항과 구분해 문서에 표시했다.

## 기존 테이블 후보와의 대응

| 이전 후보 | 이번 설계 | 이유 |
| --- | --- | --- |
| users | auth.users + profiles | 인증 계정과 서비스 프로필 분리. 비밀번호/해시를 별도 테이블에 복제하지 않음 |
| victim_profiles | profiles + profiles_private | 닉네임과 실명·연락처 분리 |
| law_firms | firms + firm_lawyers | 로펌 하나에 여러 담당 변호사 |
| damage_reports | reports + report_fields + evidences | 원문, AI/수정 결과, 파일 분리 |
| case_groups | groups + group_members | 그룹과 참여 관계 분리 |
| votes/ballots | polls + poll_options + poll_electors + ballots | 대표자·대응 방법·로펌 투표 및 재투표 회차 표현 |
| case_participations | group_contact_consents | v2 범위는 로펌 연결 동의. 법적 소송 위임/참여 확정과 동일시하지 않음 |
| case_updates | notices + group_events | 사용자 공지와 시스템 상태 이력 분리 |
| notifications | notifications | 수신자별 읽음 처리 |

## 설계 원칙

- 관계와 접근 조건을 먼저 검토하고, 다음 구현 PR에서 마이그레이션/RLS/RPC를 함께 적용한다.
- FK/UNIQUE/CHECK는 DB에서 보장한다. 시간·권한·단계·다른 행과의 관계는 트랜잭션 RPC에서도 검사한다.
- 공개 조회는 허용 컬럼만 반환한다. RLS는 행 단위이므로 '닉네임만 공개'를 RLS 하나로 해결한다고 가정하지 않는다.
- 공개 그룹명·조건·AI 생성 문장에는 피해 원문이나 개인 식별정보를 그대로 복사하지 않는다. 공개 전 정제/확인한다.
- 그룹 인원, 득표, 증거 보유율은 원본 관계에서 계산한다. 브라우저가 집계·승인·선정 결과를 직접 쓰지 않는다.
- 모든 시간은 timestamptz로 저장하고 화면에서 Asia/Seoul로 표시한다.

## 참고한 공식 문서

- [Supabase 사용자 데이터 관리](https://supabase.com/docs/guides/auth/managing-user-data)
- [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [컬럼 권한](https://supabase.com/docs/guides/database/postgres/column-level-security)
- [DB 함수](https://supabase.com/docs/guides/database/functions)
- [Cron](https://supabase.com/docs/guides/cron)
- [파일 제한](https://supabase.com/docs/guides/storage/uploads/file-limits)
