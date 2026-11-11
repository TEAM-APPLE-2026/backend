# victim-support-platform
AI 기반 유사 피해자 매칭 및 공동 대응 지원 플랫폼

HANDE 백엔드(Supabase) 레포입니다. Supabase GitHub 연동이 설정되어 있어 `main`에 합쳐진 변경이 Supabase 프로젝트에 자동으로 반영됩니다.

## 폴더 구조

```
.
├── supabase/
│   ├── config.toml     # Supabase 프로젝트 설정
│   ├── migrations/     # 표(DB) 설계 SQL 파일
│   └── functions/      # Edge Functions
├── .gitignore
└── README.md
```

## 규칙

1. **표 설계는 `supabase/migrations/`에 SQL 파일로 올립니다.**
   PR을 열어 `main`에 합치면 Supabase에 자동으로 반영됩니다.
2. **대시보드에서 직접 바꾼 내용은 반영되지 않습니다.**
   대시보드에서 무언가를 바꿨다면 반드시 같은 내용을 마이그레이션 파일로 남겨 주세요.
3. **마이그레이션 파일 이름은 아래 명령으로 만듭니다.** (파일 이름 앞에 날짜·시간이 붙어 실행 순서가 유지됩니다)
   ```bash
   npx supabase migration new 이름
   # 예: npx supabase migration new create_users_table
   ```
4. **키·비밀번호는 절대 커밋하지 않습니다.**
   `.env`, `.env.*` 파일은 Git에서 무시됩니다. 필요한 변수 목록은 `.env.example`에 값 없이 적어 주세요.
