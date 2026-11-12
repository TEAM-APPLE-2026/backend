# HANDE backend 협업 규칙

이 문서는 초기 협업안입니다. 팀에서 합의한 변경 사항을 반영해 사용합니다.

## 작업 순서

1. Issue에 작업 목적, 담당자, 완료 조건을 적습니다.
2. 최신 main에서 기능별 브랜치를 만듭니다.
3. 관련 변경만 작은 단위로 커밋합니다.
4. Pull Request에 변경 내용과 확인 방법을 적습니다.
5. 다른 팀원 1명 이상이 검토한 뒤 main에 병합합니다.

main에는 통합된 상태를 유지하고 직접 작업은 기능 브랜치에서 진행합니다.
이 문서는 규칙 안내이며 GitHub의 강제 승인·브랜치 보호 설정을 적용하지는 않습니다.

## 브랜치 이름 예시

- feat/report-create: 피해 등록
- feat/group-search: 사건 탐색
- fix/match-filter: 매칭 조건 수정
- docs/api-spec: API 명세
- chore/project-setup: 초기 구성

## 커밋 예시

- feat: 피해 사례 등록 API 추가
- fix: 같은 그룹 중복 참여 방지
- docs: 피해 사례 API 응답 형식 정리

## PR 작성 기준

- 한 PR은 하나의 작업 목적을 중심으로 작성합니다.
- 변경 이유, 영향, 확인 결과, 남은 작업을 설명합니다.
- 화면 변경은 캡처를 첨부하고, API 변경은 요청·응답 예시를 적습니다.
- DB·API 공통 형식 변경은 관련 담당자와 먼저 합의합니다.
- 아직 완료되지 않은 작업은 Draft PR로 공유합니다.

## Supabase 배포와 저장소 역할

- 이 저장소는 backend 전용이다. 분리 전 frontend/ai/backend 중첩 폴더는 만들지 않는다.
- SQL migration·Edge Functions·Storage 버킷/정책·Cron·seed.sql은 supabase/에 모은다. AI 정리·매칭·요약 모듈은 별도 hande_ai에서 관리한다.
- migrations를 main에 병합하면 공동 실제 DB에 자동 적용될 수 있다. SQL PR은 적용 영향과 개발 DB 검증 결과를 기록하고 초기 설정 PR #4 이후 병합한다.
- 이미 적용한 migration은 고치지 않고 새 migration으로 수정한다. 아직 미적용인 SQL은 적용 이력을 확인한 뒤 수정한다.
- 대시보드 변경은 실제 DB를 바꾸지만 Git으로 자동 역동기화되지 않는다. DB/저장소 이력을 대조하고 담당자와 기록한다.
- supabase/functions/와 seed.sql은 BE1, 그 외 supabase/는 BE2가 기본 담당한다. Storage/Cron SQL은 BE1 작성 시 BE2와 교차 검토한다. CODEOWNERS 상세는 초기 설정 PR #4를 따른다.
- 공개 프론트 키와 서버 비밀키를 구분한다. service role/NTS 키는 브라우저에 넣지 않는다.
- PR 열기/리뷰는 머지나 공동 DB 실행을 승인한 것이 아니다.

## 공통 확인

실제 개인정보나 API 키가 포함되지 않았는지 확인합니다.
.env.example에는 값 대신 환경변수 이름과 예시만 기록합니다.
가상 수치·고정 응답·미구현 기능은 실제 기능과 구분합니다.
