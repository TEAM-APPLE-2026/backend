# 개발 시연 데이터 (hande_dev)

`scripts/dev-seed-demo.mjs`가 hande_dev(`jnpbuulrmgdkzbiywjtd`)에 시연용 [예시] 데이터를 한 번에 만든다. 운영 프로젝트(`nchmitaoxqodsjmhmphi`)에는 실행하지 않는다. 스크립트가 URL을 확인해 다른 프로젝트면 멈춘다.

## 원칙

- `src/data/client.mjs` 공개 함수만 호출한다. 그룹 참여·투표·제안 같은 권한·상태 판단은 DB 함수가 한다. 파일 업로드만 프론트와 같은 방식으로 `supabase.storage`를 직접 쓴다.
- publishable(anon) 키와 `signUp`만 사용한다(hande_dev는 이메일 인증 꺼짐). `sb_secret_`·service_role 키는 거부한다.
- 피해 글은 hande-ai v0.4.0 `analyze`로 정리하고, 그룹 초안은 `draftGroup`으로 만든다(devDependency). AI가 못 찾았거나 확인 필요로 둔 항목만 확인 화면처럼 `source='user'`로 확정한다.
- 이름·문장은 모두 [예시] 가상 데이터, 이메일은 `demo-*@example.invalid`다. 사업자번호는 국세청 검증번호 규칙에 맞지 않는 번호라 실제 사업자와 겹치지 않는다.
- 계정 비밀번호와 생성한 ID는 `.local/dev-demo-seed.json`(gitignore)에만 저장한다. 이 파일이 있어야 다시 실행하거나 시연 계정으로 로그인할 수 있다.

## 실행

```sh
cp .env.example .env      # SUPABASE_URL=https://jnpbuulrmgdkzbiywjtd.supabase.co, SUPABASE_ANON_KEY=<publishable 키>
npm ci
node scripts/dev-seed-demo.mjs
```

1. **첫 실행**은 계정 → 사례 저장·확정 → 증빙 → 그룹 1·2·3 → 로펌 C·D 신청 → 그룹 1·3 대표자 선출과 대응 방법 투표 → 그룹 3 제안 접수 기간까지 진행한다. 로펌이 아직 승인되지 않았으면 승인 SQL을 출력하고 종료 코드 2로 멈춘다.
2. hande_dev 대시보드 SQL Editor에서 `supabase/operations/dev-demo-approve-firms.sql`을 실행한다(`approval_status=approved`, `biz_status=active`).
3. **다시 실행**하면 끝난 단계는 건너뛰고, 그룹 1의 제안 접수(2분) → 로펌 C·D 제안 → 마감 대기 → 로펌 선택 투표 개시까지 진행한다.

이미 있는 계정·사례·그룹·투표는 다시 만들지 않는다. 투표 마감·집계는 서버 Cron(`hande-close-due-votes`, 매분)이 한다. 스크립트는 투표를 1~2분 뒤 마감으로 열고 집계가 끝날 때까지 기다린다.

| 환경 변수(선택) | 기본값 | 설명 |
| --- | --- | --- |
| `DEMO_FIRM_VOTE_CLOSES_AT` | `2026-12-01T18:00:00+09:00` | 그룹 1 로펌 선택 투표 마감. 2026-11-30 18:00 KST 이후만 허용 |
| `DEMO_G3_PROPOSAL_DEADLINE` | `2026-12-01T18:00:00+09:00` | 그룹 3 제안 접수 마감 |
| `DEMO_PROPOSAL_WINDOW_SEC` | `120` | 그룹 1 제안 접수 기간(초) |

## 만드는 데이터

| 구분 | 계정 | 내용 |
| --- | --- | --- |
| 피해자 A | demo-victim-a | 계정·프로필만. 시연 때 직접 피해 등록 |
| 그룹 1 `[예시] ○○쇼핑몰 …` | demo-victim-b ~ k (10명) | 2026년 10월 유출, 항목·2차 피해 다양. B 개설. B·D·F·H 증빙 ready. 대표자 B → 공동소송(suit) → 로펌 C·D 제안 → 로펌 선택 투표 열림(아무도 투표 안 함) |
| 그룹 2 `[예시] △△통신 …` | demo-victim-l ~ n (3명) | 2026년 9월 유출. L 개설. 모집 중 |
| 그룹 3 `[예시] □□카드 …` | demo-victim-o ~ x (10명) | 2026년 11월 유출, 카드 유출 포함. O·Q 증빙 ready. 대표자 O → 공동소송 → 제안 접수 2026-12-01 18:00 KST까지(로펌 투표 없음) |
| 로펌 C, D | demo-firm-c, demo-firm-d | `[예시] 로펌 C/D (가상)`, 대표자·개업일 [예시], 등록증 [예시] PDF, 사업자번호 9990000011 / 9990000022. 그룹 1에 제안 |

- 대표자 선거는 활성 참여자 10명 이상이어야 열린다(DB 규칙). 그래서 그룹 1·3은 각각 10명이다.
- 그룹 회사명 칸은 `○○쇼핑몰`·`△△통신`·`□□카드`로 저장하고 그룹 이름 앞에만 `[예시]`를 붙인다. hande-ai는 회사명에서 `[예시]`를 떼고 뽑지만 DB `join_group`은 회사명을 그대로 비교하기 때문이다(아래 "알려진 차이").
- 로펌 B는 만들지 않는다. 시연 중 직접 가입한다. hande_dev의 `firm_auto_approve`는 `status`라서, 국세청 상태조회가 계속사업자면 자동 승인된다.

## 시연 계정 사용법

- 비밀번호: `.local/dev-demo-seed.json`의 `accounts.<id>.password`. 저장소·메신저에 올리지 않는다.
- 피해자 A(`demo-victim-a`): 시연 문장을 입력해 AI 정리 → 확정 → 그룹 1이 same(100점)으로 추천되고 바로 참여할 수 있다.
- 피해자 C(`demo-victim-c`): 그룹 1 멤버, 로펌 투표 전. 로펌 C·D 제안 비교와 투표 시연에 쓴다.
- 대표자 B(`demo-victim-b`): 그룹 1 대표자. 공지 작성 등.
- 대표자 O(`demo-victim-o`): 그룹 3 대표자. 로펌 B가 그룹 3에 제안서를 내면 제안 목록을 확인할 수 있다.
- 로펌 C·D(`demo-firm-c/d`): 승인된 로펌. 그룹 1 제안서와 자기 득표 조회.

## 정리

| 대상 | 파일 | 방법 |
| --- | --- | --- |
| 시연 데이터만 | `supabase/operations/dev-demo-cleanup.sql` | 대시보드 SQL Editor. `[미리보기]` 확인 후 전체 실행, `[확인]` 결과 0 |
| Storage 파일 | 위 파일의 `[파일 목록]` | SQL로는 못 지운다(`storage.protect_delete`). 대시보드 Storage에서 삭제 |
| 로컬 상태 | `.local/dev-demo-seed.json` | 정리 후 삭제해야 다시 만들 때 새 계정으로 시작한다 |

시연 데이터 정리 SQL은 demo 계정과 그 계정이 만든 그룹만 지운다. 시연 중 직접 가입한 로펌 B 계정·로펌 행은 남긴다. 단 시연 그룹에 낸 로펌 B의 제안은 그룹과 함께 지워진다. `tests/demo-cleanup.test.mjs`가 PGlite에서 전체 흐름 데이터를 만든 뒤 이 SQL을 실행해 검증한다.

## 알려진 차이: AI 매칭과 DB 참여 규칙

- hande-ai `match`(`src/match.js`)는 회사명 비교 때 공백·`[예시]`·`(주)`를 무시한다. DB `hande_private.report_matches`(`supabase/migrations/20261117020000_create_groups.sql`)는 `lower(btrim())`만 적용한다. 그래서 AI가 같은 사건(same)으로 추천해도 회사명 표기가 다르면 `join_group`이 `NOT_ELIGIBLE`이다.
- hande-ai `extract`(`src/extract.js` 회사명 정규식)는 `통신사`·`카드사`·`쇼핑몰` 같은 접미어로 회사명을 찾는다. `△△통신`·`□□카드`는 찾지 못해 이 사례들은 회사명이 사용자 확정으로 저장된다.

## 실행 결과 (2026-11-26, hande_dev)

사전 작업: 손으로 만든 기존 테스트 계정·로펌 5개·그룹 1개를 대시보드 SQL로 정리했다(일회성, 저장소에 넣지 않음). 운영 프로젝트에는 실행하지 않았다.

- 계정 26개: `demo-victim-a`~`x`(user 24), `demo-firm-c`·`d`(firm 2). 피해자 A는 사례 없음.
- 사례 23건 확정. 회사명 `source`: ○○쇼핑몰 10건 `ai`, △△통신 3건·□□카드 10건 `user`(AI가 회사명을 찾지 못함).
- 증빙 8개 ready(B 2, D, F, H, O 2, Q).
- 로펌 C·D: 승인 SQL 실행 후 `approved`/`active`. 그룹 1에 제안 2건.

| 그룹 | 상태 | 멤버 | 투표 |
| --- | --- | --- | --- |
| `[예시] ○○쇼핑몰 개인정보 유출 피해 모임 (2026.10)` | connecting / firm_vote | 10 | 대표자 B 7:2(확정), 방법 suit 7표(확정), 로펌 선택 **열림** 0표, 마감 2026-12-01 18:00 KST |
| `[예시] △△통신 개인정보 유출 피해 모임 (2026.09)` | recruiting | 3 | 없음 |
| `[예시] □□카드 개인정보 유출 피해 모임 (2026.11)` | connecting / proposal_collection | 10 | 대표자 O 6:2(확정), 방법 suit 7표(확정). 제안 접수 ~2026-12-01 18:00 KST, 제안 0건, 로펌 투표 없음 |

앱 함수로 확인: 피해자 C는 그룹 1 멤버이고 로펌 투표 `myOptionId=null`. 시연 문장은 hande-ai로 그룹 1과 same 100점이며 회사명 `○○쇼핑몰`이 그룹과 같아 참여 조건을 만족한다.

실행 중 고친 점: 첫 실행에서 `createGroup` 응답의 `groupId`를 잘못 읽어 그룹 ID 저장에 실패했다. 수정 후 같은 회사 그룹 중 개설자가 참여한 그룹을 찾아 재사용하므로, 다시 실행해도 중복 그룹이 생기지 않았다.
