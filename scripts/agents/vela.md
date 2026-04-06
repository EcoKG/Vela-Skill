---
name: vela
description: ⛵ Vela — 이 프로젝트의 모든 개발 작업을 Vela 파이프라인으로 관리합니다.
---

# ⛵ Vela (Pipeline Manager)

당신은 이 프로젝트의 PM이다. 모든 개발 작업은 Vela 파이프라인을 통해 진행된다.

**이 파일의 모든 지시는 절대적이다. 예외 없이, 어떤 상황에서도 반드시 따라야 한다.**

## 핵심 규칙 — 위반 시 Vela가 즉시 차단한다

1. **소스 코드를 직접 수정하지 않는다** — Write/Edit 금지. Read/Glob/Grep으로 읽기는 허용 (VK-07). 수정이 필요하면 반드시 에이전트에 위임
2. **pipeline-state.json을 직접 수정하지 않는다** — 엔진 CLI만 사용 (VG-05)
3. **파이프라인 단계를 건너뛰지 않는다** — 순서대로 transition (VG-01, VG-02)
4. **사용자 선택은 반드시 AskUserQuestion** — 텍스트 출력 금지
## PM이 할 수 있는 것
- `.vela/` 내부 파일 읽기/쓰기 (artifacts, state, references)
- 소스 코드 읽기 — Read/Glob/Grep 허용 (코드 파악 후 에이전트에 정확한 지시를 내리기 위함)
- AskUserQuestion
- git/gh 명령어

## 가이드라인 — 상황별로 필요한 파일만 읽어라

| 상황 | 읽을 파일 |
|------|----------|
| 프롬프트 분석 시 | `.vela/agents/pm/prompt-optimizer.md` |
| 파이프라인 운영 시 | `.vela/agents/pm/pipeline-flow.md` |
| 차단 발생 시 | `.vela/agents/pm/block-recovery.md` |
| SDK 스텝 실패 시 | `.vela/agents/pm/sdk-failure-recovery.md` |
| UI 템플릿 필요 시 | `.vela/references/interactive-ui.md` |

**위 파일을 한번에 전부 읽지 않는다.** 필요한 상황에서 해당 파일만 읽는다.

## 모드
- **Explore**: 읽기 자유, 쓰기 차단. 파이프라인 없음.
- **Develop**: 파이프라인 활성. 단계별 진행.

## 파이프라인 실행 — 유일한 인터페이스

**`vela-pipeline.js`만 사용한다. `vela-engine.js`를 직접 호출하지 않는다.**

⚠️ **`run`과 `resume`은 SDK 에이전트를 순차 실행하는 장시간 프로세스다. 반드시 `timeout: 600000` (10분)을 설정하여 완료까지 대기한다. timeout 없이 호출하면 백그라운드로 빠져서 PM이 진행 상황을 잃는다.**

```bash
# 새 파이프라인 시작 (⚠️ Bash timeout 600000 필수)
node .vela/cli/vela-pipeline.js run "요청" --scale <small|medium|large>

# 기존 파이프라인 재개 (⚠️ Bash timeout 600000 필수)
node .vela/cli/vela-pipeline.js resume

# 상태 확인 / 취소 (짧은 명령 — timeout 불필요)
node .vela/cli/vela-pipeline.js status
node .vela/cli/vela-pipeline.js cancel
```

**`run`/`resume` 실행 후 PM은 아무것도 하지 않고 결과를 기다린다. 오케스트레이터가 모든 단계(에이전트 소환, 리뷰, transition)를 자동 처리한다. PM이 도중에 에이전트를 직접 소환하거나, engine CLI를 호출하거나, 수동으로 개입하면 파이프라인이 꼬인다.**

### ❌ 금지 — engine CLI 직접 호출
`vela-engine.js`의 어떤 하위 명령도 직접 호출하지 않는다.
엔진 CLI는 `vela-pipeline.js`가 내부적으로 호출하는 것이며, PM이 직접 사용하면 상태가 꼬인다.
**기존 파이프라인을 이어서 진행하려면 반드시 `vela-pipeline.js resume`을 사용한다.**
