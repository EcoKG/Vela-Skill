# Plan: {request}

## Architecture

전체 설계 접근과 레이어 구조를 서술한다. 변경되는 파일 목록을 명시.

- Layer map: 어느 레이어 (domain / application / infrastructure / interface) 에
  이번 수정이 닿는지 적는다
- 변경 파일: `src/foo/bar.ts`, `src/foo/bar.test.ts`, ...
- 전체 설계 접근: (요청의 핵심 변경을 3~5 문장으로)

## Architecture Guardrails

이 섹션은 v7.1 M4 이후 plan-check 가 **강제** 한다. 없거나 하위 항목이 누락되면
plan-check Phase 3 (a) FAIL. executor/verifier 도 이 섹션을 scope 판단 근거로 쓴다.

**Allowed imports** — 이번 수정에서 새로 import 해도 되는 레이어/모듈 목록:
- `application/user-service → domain/user`
- `application/user-service → infrastructure/repo/user-repo`
- `application/user-service → shared/http-client` (외부 HTTP 호출용)

**Forbidden imports** — 절대 import 하면 안 되는 경로:
- `interface/server → infrastructure/repo/*` (DIP 위반 — interface 는 application port 를 통해서만 repo 에 닿아야 함)
- `domain/* → infrastructure/*` (도메인 모델이 영속성 구현 알면 안 됨)
- `application/* → interface/*` (역방향 의존)

**Injection points** — DI 가 필요하면 어디에 어떤 인터페이스를 주입할지:
- `server bootstrap (interface/server/main.ts)` 에서 `UserRepoPort` 를 `UserRepoPg` 로 바인딩
- `UserService constructor` 가 `UserRepoPort` 를 받도록 변경

## Class Specification

### `UserService` (application/user-service.ts)
- `constructor(repo: UserRepoPort, log: Logger)` — `UserRepoPort` 주입
- `getByEmail(email: string — must be valid RFC 5322 address, lowercased)` → `Promise<User | null>`
- `createUser(input: { email: string — must match /^[^@]+@[^@]+\.[^@]+$/, password: string — must be ≥ 12 chars })` → `Promise<User>`

### `UserRepoPort` (application/ports/user-repo.ts)
- `findByEmail(email: string — lowercased)` → `Promise<UserRow | null>`
- `insert(row: UserRow)` → `Promise<UserRow>`

(도메인 값 URL / ID / email / token / secret 등에는 반드시 `format:` 또는 `must be` 제약 — plan-check Phase 3 (b))

## Test Strategy

### 단위 테스트 (`user-service.test.ts`)
- `getByEmail returns null for unknown email`
- `createUser returns the inserted user`
- **edge**: `createUser rejects email missing @ sign` (엣지 1)
- **edge**: `createUser rejects password < 12 chars` (엣지 2)
- **edge**: `createUser retries once on transient repo error` (엣지 3)

(각 주요 클래스/함수마다 edge case ≥ 2개 — plan-check Phase 3 (c))

### 통합 테스트
- `server boots with UserRepoPg bound to UserRepoPort`
- `POST /users with valid body inserts a user`

## Implementation Steps
1. Define `UserRepoPort` interface in `application/ports/user-repo.ts`
2. Move existing `UserRepo` impl under `infrastructure/repo/user-repo-pg.ts` renaming class → `UserRepoPg`
3. Refactor `UserService` to inject `UserRepoPort`
4. Wire `UserRepoPg` at server bootstrap
5. Write unit tests first (TDD red)
6. Run `npm run test` to confirm green

## Risk Assessment
- 기존 `UserService` 가 `UserRepo` 를 직접 import 하던 code-path 2곳: (1) `server/handlers/user.ts`, (2) `cli/user-cmd.ts`. 둘 다 DI 로 맞춰야 test 가 통과한다.
- `UserRepoPg` 이름 변경으로 기존 import 경로 (`infrastructure/repo/user-repo`) 가 깨진다 — Change-Surface-Analysis 가 reference 무결성 실패를 찾는다.
