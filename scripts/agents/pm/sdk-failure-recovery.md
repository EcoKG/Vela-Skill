# SDK 스텝 실패 시 복구 — 파이프라인을 수동으로 재현하지 않는다

SDK 오케스트레이터(`vela-pipeline.js`)가 스텝 실행 중 실패(`ok: false`)를 반환하면, 아래 매트릭스에 따라 **즉시** 행동을 전환한다.

**스코프 구분**: `block-recovery.md`는 게이트(VK-*/VG-*)가 PM 행동을 **차단**했을 때 사용한다. 이 문서는 SDK가 스텝 실행 자체를 **실패**했을 때 사용한다. 두 문서는 상호 배타적이다.

## SDK 에러 코드 7종 — 진단 신호 × 복구 행동

| 에러 코드 | 사유 | 진단 신호 | 복구 |
|-----------|------|-----------|------|
| `sdk_not_available` | Claude Code SDK 미설치/미로드 | cost=0, numTurns=null | `npm ls @anthropic-ai/claude-agent-sdk` 확인 → install.sh 재실행 지시 |
| `no_result` | SDK 쿼리 완료했으나 result 메시지 없음 | durationMs > 0, cost=0 | 동일 스텝 1회 재시도 (일시적 통신 오류 가능). 재실패 시 AskUserQuestion |
| `error_max_turns` | SDK 내부 최대 턴 초과 | Turns used: N (SDK 내부 상한 도달) | 프롬프트 축소 필요 → 엔진 재구성 필요, AskUserQuestion |
| `error_during_execution` | 실행 중 에러 (rate limit은 자동 재시도 처리됨) | details 필드에 원인 문자열, retriesAttempted 존재 가능 | details 원인 확인. Rate limit 소진이면 대기 후 재시도, 그 외는 AskUserQuestion |
| `error_max_structured_output_retries` | 구조화 출력 재시도 한도 초과 | outputFormat 지정된 스텝에서만 발생 | JSON 스키마 적합성 문제 — 스텝 프롬프트 수정 필요, AskUserQuestion |
| `max_turns_exceeded` | catch 블록에서 감지된 턴 초과 (예외 경로) | details에 "max turns" 패턴 | `error_max_turns`와 동일 처리 |
| `unexpected_error` | 기타 예외 (SDK 던진 미분류 오류) | details에 원시 에러 메시지 | details 확인 후 AskUserQuestion — 자동 복구 불가 |

## 진단 신호 3종 해석 가이드

SDK 스텝 실행 종료 시 콘솔/아티팩트에 3종 신호가 기록된다. 실패 원인 분류에 반드시 이 신호를 사용한다.

1. **`Turns used: N`** (콘솔 로그)
   - SDK 내부 상한에 도달하면 `error_max_turns` / `max_turns_exceeded` 에러 코드와 함께 기록됨
   - 정상 종료 시에도 소비 턴 수가 기록됨 (details 필드 확인 필수)
2. **`denied-tools.json`** (artifactDir 하위)
   - 파일 존재 → 스텝이 차단된 도구를 호출하려 시도함. 각 denial의 `tool_name`/`reason`을 확인하여 프롬프트 수정 방향 결정
   - 파일 없음 → 도구 접근 문제는 아님
3. **`cost: $X.XXXX`** (콘솔 로그)
   - `$0.0000` → SDK 쿼리가 실질적으로 실행되지 않음 (`sdk_not_available` / 초기 차단 의심)
   - `> $0` → SDK가 최소 1회 응답 반환 (실행 중 실패로 분류)

## 절대 금지 규칙

1. **Claude Code Agent 도구로 SDK 스텝을 수동 재현하지 않는다** — Task 도구로 reviewer/executor/researcher를 호출하여 파이프라인 단계를 우회하는 경로는 **없다**. 실패한 스텝은 반드시 `vela-pipeline.js`를 통해 재실행한다.
2. **SDK reviewer 우회 경로는 존재하지 않는다** — 리뷰 실패 시 PM이 직접 리뷰를 작성하거나 승인하지 않는다.
3. **복구 행동이 불확실하면 즉시 AskUserQuestion** — 같은 스텝을 근거 없이 재시도하지 않는다 (K001 원칙과 동일).
4. **`pipeline-state.json`을 직접 수정하여 실패를 감추지 않는다** — 엔진 CLI만 사용한다 (VG-05).
