# backend 개발 규칙

- 이 폴더에서 백엔드 개발과 관련 문서를 관리한다.
- SQL migration: supabase/migrations, 실행 검증: supabase/tests, 설명: docs/development.
- DB 이름은 snake_case. 서비스 프로필과 인증 계정은 분리한다.
- 새 사용자 데이터 테이블은 생성 시 RLS를 설정하고 권한을 명시적으로 부여한다.
- SECURITY DEFINER는 꼭 필요한 경우에만 사용하고 빈 search_path, 본인 검사, 실행 권한 제한을 포함한다.
- 비밀키·실제 개인정보를 커밋하지 않는다. PR 생성만으로 DB 배포나 병합을 하지 않는다.
