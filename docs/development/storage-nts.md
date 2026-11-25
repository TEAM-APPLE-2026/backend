# 증빙 파일 Storage와 국세청 사업자 상태 조회

기준: [permissions-and-rpc.md](../database/permissions-and-rpc.md) 6~7장, [integration-contract.md](../database/integration-contract.md) 6장.

## 구성

| 구성 | 위치 | 역할 |
| --- | --- | --- |
| migration | `supabase/migrations/20261125010000_create_storage_evidence.sql` | 비공개 버킷, storage.objects 정책, `create_evidence_upload`, `delete_evidence`, service role 컬럼 권한 |
| Edge Function | `supabase/functions/evidence-confirm` | 실제 객체 크기·파일 서명 확인 → `ready`/`failed` |
| Edge Function | `supabase/functions/nts-verify` | 본인 로펌의 DB `biz_no`로 국세청 조회 → `biz_status`/`biz_checked_at` |
| 공통 로직 | `supabase/functions/_shared/*.mjs` | Deno·Node 공용, Node 테스트로 검증 |
| 데이터 모듈 | `src/data/client.mjs` | `createEvidenceUpload`, `confirmEvidence`, `deleteEvidence`, `verifyBusiness` |

## 버킷과 경로

- `evidences`, `firm-certs` 모두 비공개, 파일당 10,000,000 bytes, `image/jpeg`·`image/png`·`application/pdf`만 허용.
- 피해 증빙: `evidences/{user_id}/{report_id}/{file_id}.{jpg|png|pdf}` — 경로는 서버(`create_evidence_upload`)가 만든다. 원본 이름은 표시용으로만 저장한다.
- 로펌 등록증: `firm-certs/{user_id}/{file_id}.{jpg|jpeg|png|pdf}` — `file_id`는 클라이언트가 `crypto.randomUUID()`로 만든다.

| 정책 | evidences | firm-certs |
| --- | --- | --- |
| 업로드(INSERT) | 본인 경로 + 본인 사례 + 같은 경로의 **pending 행**이 있을 때만 | 본인 경로 + `profiles.role='firm'` |
| 조회(SELECT) | 본인 경로 + 본인 사례 | 본인 경로 |
| 삭제(DELETE) | 본인 경로 + 본인 사례 + DB 행이 **없을 때만** (행 먼저 삭제) | 본인 경로, 로펌 신청에 쓰인 등록증은 삭제 불가 |
| 덮어쓰기(UPDATE) | 정책 없음 — `upsert: true` 불가 | 정책 없음 |

다른 사용자·로펌은 증빙 원본을 읽을 수 없다(로펌 공개 정책 확정 전 기본 차단).

## 증빙 업로드 순서

```js
// 1) pending 행 생성 + 업로드 경로 발급 (본인 사례만)
const reg = await api.createEvidenceUpload({
  reportId, kind: 'screenshot', originalName: file.name, mimeType: file.type, sizeBytes: file.size,
});
if (reg.error) return reg;

// 2) 발급된 경로로 업로드. upsert는 쓰지 않는다(덮어쓰기 정책 없음).
const up = await supabase.storage.from(reg.data.bucketId)
  .upload(reg.data.objectPath, file, { contentType: file.type, upsert: false });

// 3) 서버 확인. 실제 크기·파일 서명이 행과 같으면 ready, 다르면 failed(객체는 서버가 정리).
const confirmed = await api.confirmEvidence({ evidenceId: reg.data.evidenceId });
// confirmed.data = { evidenceId, status: 'ready' | 'failed', uploadedAt }
// CONFLICT: 아직 객체가 없음 → 업로드 후 재시도. pending 상태는 유지된다.
```

- `kind`는 소문자·숫자·`_` 1~50자. 종류 목록은 아직 미정이라 형식만 검사한다.
- `originalName` 확장자가 MIME과 맞아야 한다(jpeg는 `.jpg`/`.jpeg`). `/`, `\`, 제어문자 불가.
- 클라이언트는 `status`를 직접 바꿀 수 없다(`evidences` UPDATE 권한 없음). `ready`는 `evidence-confirm`만 설정한다.
- 집계(`get_group_stats`)는 `ready`만 센다. pending/failed는 제외된다.

## 증빙 삭제

```js
const del = await api.deleteEvidence({ evidenceId });
// del.data = { evidenceId, deletedAt, objectPath, objectRemoved }
// objectRemoved=false → 파일만 남은 상태. 같은 objectPath로 storage.remove()를 재시도한다.
```

`delete_evidence`가 본인 행을 먼저 지우고 경로를 돌려준다. 그 뒤 데이터 모듈이 Storage 객체를 지운다. 이 순서라 ready 행이 없는 파일을 가리키는 일이 없고, 실패해도 같은 경로로 다시 지울 수 있다.

## evidence-confirm 신뢰 경계

1. 요청의 access token을 Supabase Auth(`auth.getUser`)로 검증한다(게이트웨이 `verify_jwt=true`도 유지).
2. **사용자 JWT 클라이언트**로 `evidences` 행을 조회한다 → RLS가 본인 사례 여부를 판정. 경로 접두사 `{user_id}/{report_id}/`도 다시 비교한다.
3. pending이 아니면 현재 상태를 그대로 돌려준다(재호출 안전).
4. service role로 실제 객체를 내려받아 바이트 길이 = `size_bytes`, 파일 서명(JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, PDF `%PDF-`) = `mime_type`인지 확인한다.
5. `id`·`status='pending'`·`object_path`가 모두 맞는 행만 갱신한다. service role은 `evidences`에서 `status`, `uploaded_at`만 UPDATE 가능하고, 트리거가 pending → ready/failed 외의 전이를 막는다.

## nts-verify (7장)

```js
const r = await api.verifyBusiness();            // 또는 { bizNo } / { firmId } 를 일치 확인용으로 전달
// r.data = { firmId, bizStatus: 'active'|'suspended'|'closed'|'unknown', bizCheckedAt }
```

- JWT 검증 → 사용자 JWT로 `profiles.role='firm'`, `firms.owner_id=본인` 확인 → **DB의 `biz_no`**로 조회. body의 `firmId`/`bizNo`가 DB와 다르면 각각 FORBIDDEN/CONFLICT로 거절하고 국세청을 호출하지 않는다.
- `POST https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=…` body `{"b_no":["<biz_no>"]}`. 키는 `Deno.env.get('NTS_SERVICE_KEY')`. 공공데이터포털의 **Decoding 키**를 넣는다(함수가 URL 인코딩한다).
- `b_stt_cd` 01→active, 02→suspended, 03→closed, 그 밖의 유효 응답(미등록 번호 등)→unknown.
- 네트워크 실패·타임아웃(10초)·HTTP 오류·JSON 오류·해당 번호가 없는 응답은 기존 값을 유지하고 `NETWORK_ERROR`(HTTP 502).
- UPDATE는 `id`·`owner_id`·`biz_no`를 모두 비교하며 `biz_status`·`biz_checked_at`만 바꾼다. 조회 중 `biz_no`가 바뀌어 매칭 행이 없으면 `CONFLICT`. service role은 `approval_status` 등 승인 필드 UPDATE 권한이 없다.
- 오류 응답·로그에 키, 요청 URL, 원시 오류를 넣지 않는다.

## HTTP 응답

성공 `{data}`(200), 실패 `{error:{code,message}}`. AUTH_REQUIRED 401, FORBIDDEN 403, NOT_FOUND 404, INVALID_INPUT 400(메서드 405), CONFLICT 409, NETWORK_ERROR 502, INTERNAL_ERROR 500. 데이터 모듈은 이를 기존 `{data}`/`{error:{code,message}}`로 정규화한다.

## 검증

- `npm test`: PGlite(PostgreSQL 17) + Storage 스텁으로 버킷 설정, 업로드/조회/삭제/덮어쓰기 정책, RPC, service role 컬럼 권한·상태 전이, evidence-confirm(정상/크기 불일치/서명 위조/미업로드/타인), nts-verify(코드 매핑, 네트워크 실패 시 값 유지, body 불일치, 역할, 경합 CONFLICT), HTTP 래퍼, 데이터 모듈을 검사한다.
- 개발 DB 전용 롤백 SQL: `npx supabase db query --remote=jnpbuulrmgdkzbiywjtd --file supabase/tests/hosted_storage_evidence.sql --yes`
- Storage 스텁은 실제 Storage API와 다르다. 실제 업로드·확인은 개발 프로젝트 테스트 계정으로 따로 확인한다.

## 배포 (개발 프로젝트 hande_dev 전용)

```sh
npx supabase link --project-ref jnpbuulrmgdkzbiywjtd
npx supabase db push --linked          # 개발 DB에 migration 적용
npx supabase functions deploy evidence-confirm nts-verify --project-ref jnpbuulrmgdkzbiywjtd
npx supabase secrets set NTS_SERVICE_KEY=<Decoding 키> --project-ref jnpbuulrmgdkzbiywjtd   # 직접 입력, 저장소·로그 금지
```

운영 프로젝트에는 적용하지 않는다. main 병합 시 운영 DB에 자동 반영될 수 있으므로 검토 후 병합한다.

## 남은 결정

- 사례당 증빙 최대 개수, `kind` 목록.
- 로펌에 증빙 원본을 공개하는 정책(현재 차단), signed URL 발급 API.
- 오래된 pending 행·orphan 객체 정리 배치.
- 제출된 사례의 ready 증빙 삭제 허용 여부(현재 본인이면 허용).
