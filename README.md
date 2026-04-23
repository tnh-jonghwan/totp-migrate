# totp-migrate

`TUSERACCOUNT.TOTPSECRET` 컬럼에 평문으로 저장된 TOTP secret을 **AES-256-GCM 암호화 포맷**으로 일괄 변환하는 Node.js 도구.

contact-center CN-25 배포 전/후 기존 평문 계정을 정리하는 용도.

## 왜 필요한가

- 기존 contact-center는 `authenticator.generateSecret()` 결과를 **평문**으로 DB에 저장하고 있었다.
- CN-25 이후 contact-center는 ims-nest와 동일한 AES-256-GCM 암호화 포맷으로 바뀌었다.
- 배포 후 기존 평문 계정은 `decrypt()`가 실패해 로그인 불가.
- **암호 기반 키가 같은** ims-nest의 암호화 포맷과 호환되도록 DB를 덮어써야 한다.

사용자의 Authenticator 앱은 **건드릴 필요 없다**. secret 자체는 동일하고 DB 저장 포맷만 바뀌므로 기존 등록 그대로 유지.

## 설치

```bash
cd totp-migrate
pnpm install   # 또는 npm install / yarn install
cp .env.example .env
# .env 편집: CRYPTO_SECRET_KEY(ims-nest와 동일 값), DB 접속 정보 입력
```

## 환경변수 (.env)

| 키 | 설명 |
|---|---|
| `CRYPTO_SECRET_KEY` | **ims-nest/contact-center와 동일한** 32바이트 hex(64자) |
| `DB_HOST` | trustnhopedb 호스트 |
| `DB_PORT` | 기본 3306 |
| `DB_USERNAME` / `DB_PASSWORD` | DB 계정 |
| `DB_DATABASE` | 보통 `trustnhopedb` |

> ⚠️ `CRYPTO_SECRET_KEY`가 ims-nest와 다르면 마이그레이션 해도 서비스에서 복호화 실패. 반드시 동일 값 확인.

## 마이그레이션

```bash
pnpm run list          # 대상 확인
pnpm run migrate:dry   # 미리보기
pnpm run migrate       # 실제 반영 (yes 입력)
```

## 권장 순서

1. `.env` 설정 (특히 `CRYPTO_SECRET_KEY`가 운영 값인지 재확인)
2. `pnpm run list` — 대상 파악
3. `pnpm run migrate:dry` — 변경 계획 확인
4. **DB 백업** (mysqldump 등) — 이건 이 스크립트가 해주지 않음
5. `pnpm run migrate` — `yes` 입력 후 반영
6. `pnpm run list` 재실행 — 결과가 비었는지 확인

## 주의사항

- **같은 평문을 돌려도 매번 다른 암호문이 나옵니다** (AES-GCM의 IV 랜덤). 정상. `decrypt()`로 원래 값이 나오는지로 검증.
- 이 스크립트는 **멱등하지 않지만 안전**합니다: `list`/`migrate`의 WHERE 조건이 이미 암호화된 행을 제외하므로 두 번 돌려도 같은 결과.
- DB 스키마는 `TUSERACCOUNT(ACCOUNTID, USERID, USERNAME, TOTPSECRET)` 기준. 다른 테이블 구조면 `SELECT_PLAINTEXT_ROWS` 상수와 UPDATE 쿼리를 맞춰 수정.
- 운영 배포 직후 대량 잠금을 피하려면 사용자 오프 시간대에 실행.

## 구조

```
totp-migrate/
├── .env.example
├── .gitignore
├── migrate.js       메인 스크립트 (단일 파일, ~220줄)
├── package.json
└── README.md
```

의존성 2개(`dotenv`, `mysql2`)만 사용. 프로덕션 아닌 **일회성 마이그레이션 도구**이므로 TypeScript 미사용.
