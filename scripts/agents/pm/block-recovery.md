# 차단 시 복구 — 같은 행동을 절대 재시도하지 않는다

Vela가 도구 호출을 차단하면, **stderr 마지막 줄에 `[VK-XX]` 또는 `[VG-XX]` 코드와 복구 힌트가 포함**된다 (v7.2부터). 그 한 줄을 **먼저 읽고** 아래 테이블에 맞춰 **즉시** 행동을 전환한다. structured deny의 reason에 이미 `→ 복구: …` 힌트가 있다면 그것을 우선 따른다.

단, `VG-13`/`VG-14`(config 변조, 시크릿 탐지)와 corrupt stdin은 **silent hard-block** 으로 stderr 이유를 공개하지 않는다 — 탐지 회피 우려 때문이다. 이 경우 도구 결과에 exit 2만 보이면 아래 테이블의 **VG-13/14 행동**으로 분기한다.

## Gate Keeper (VK-*)

| 코드 | 사유 | 복구 |
|------|------|------|
| VK-01 | Bash 쓰기 (읽기 모드) | Read/Glob/Grep |
| VK-02 | Bash 제한 | Claude Code 내장 도구. git/gh는 파이프라인 활성 시 허용 |
| VK-03 | pipeline-state.json 직접 수정 | `vela-engine transition` |
| VK-04 | 읽기 모드에서 쓰기 | `vela-engine transition` → 쓰기 가능 단계 |
| VK-05 | 민감 파일 | .env.example 사용 |
| VK-06 | 시크릿 감지 | 환경변수로 대체 |
| VK-07 | PM 소스코드 직접 수정 | `Agent(subagent_type="vela-executor")`로 실행 위임 |
| VK-08 | 체인 연산자 (`&&`, `\|\|`, `;`, `\|`) | 단일 명령으로 분리하여 순차 실행 |
| VK-10 | write 모드에서 WebFetch/WebSearch | research 단계에서 조회하거나, researcher 재호출 |

## Gate Guard (VG-*)

| 코드 | 사유 | 복구 |
|------|------|------|
| VG-03 | corrupt tracker-signals.json → git commit 불가 | `.vela/tracker-signals.json` 삭제 또는 유효한 JSON으로 복구 |
| VG-13 | `.vela/templates/pipeline.json` 직접 수정 | `vela-engine` CLI로 상태 전이. pipeline.json은 직접 수정 금지 |
| VG-14 | Write 내용에 시크릿 패턴 | 시크릿을 환경변수로 대체 후 재시도 |
| VG-15 | 연속 실패 5회 → 서킷 브레이커 | AskUserQuestion으로 사용자에게 보고. 사용자가 `.vela/state/circuit-open.json` 삭제 시 복구 |

## 원칙
1. **절대 재시도 금지** — 같은 도구+같은 입력은 같은 차단
2. **stderr의 `[VK-XX]` 라인과 `→ 복구` 힌트를 먼저 읽는다** — structured deny는 이미 복구 경로를 포함하고 있다
3. **단계를 건너뛰지 않는다**
4. **복구 불가능 시 AskUserQuestion으로 사용자에게 알린다**

## 정책 완화 (프로젝트별)

특정 코드의 차단이 너무 잦으면 `.vela/config.json`의 `gate_policy`로 강도 조절:

```json
"gate_policy": {
  "chain_operator":   "ask",   // VK-08 체인 연산자 → 확인 UI
  "web_in_write":     "ask",   // VK-10 WebFetch/Search → 확인 UI
  "researcher_scope": "warn"   // M11 scope 밖 Read → 경고만 남기고 허용
}
```

`node .vela/cli/vela-friction.js` 으로 집계 후 자주 발생하는 코드를 식별해 선택적으로 완화한다. 완전차단을 피하면서 하네스 강제는 유지하는 방법이다.
