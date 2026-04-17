# 파이프라인 스텝 실패 시 복구

에이전트 스텝 실행 중 실패하면 아래 매트릭스에 따라 **즉시** 행동을 전환한다.

**스코프 구분**: `block-recovery.md`는 게이트(VK-*/VG-*)가 PM 행동을 **차단**했을 때 사용한다. 이 문서는 Agent 도구 호출이 스텝 실행 자체를 **실패**했을 때 사용한다. 두 문서는 상호 배타적이다.

## 에이전트 실패 유형 — 진단 × 복구

| 실패 유형 | 진단 신호 | 복구 행동 |
|-----------|-----------|-----------|
| **산출물 미생성** | 스텝 완료 후 artifact 파일 없음 | 같은 subagent_type으로 1회 재시도. 재실패 시 AskUserQuestion |
| **품질 기준 미달** | reviewer 점수 < 20/25 또는 CRITICAL 존재 | 리뷰 피드백을 포함하여 동일 에이전트 재호출 (max_revisions 준수) |
| **plan-check FAIL** | plan-check.md에 FAIL 기록 | 실패 이유를 planner에게 전달하고 plan.md 재작성 요청 |
| **verify FAIL** | verification.md에 FAIL 기록 | 실패 내용을 executor에게 주입하여 execute 재시도 (ralph 루프) |
| **Agent 도구 오류** | Agent 호출 자체가 에러 반환 | 에러 메시지 확인 후 1회 재시도. 재실패 시 AskUserQuestion |
| **반복 실패** | 동일 스텝 max_revisions 소진 | `escalate_to_pm` — AskUserQuestion으로 사용자에게 판단 위임 |

## 재시도 프롬프트 조립 방법

재시도 시 이전 실패 내용을 프롬프트에 포함한다:

```
이전 실행에서 다음 문제가 발생했습니다:
{reviewer 피드백 또는 에러 내용}

이 문제를 해결하여 다시 시도하십시오.
```

## 절대 금지 규칙

1. **PM이 직접 코드를 수정하여 실패를 우회하지 않는다** — 항상 executor 에이전트에 위임
2. **리뷰어 우회 경로는 없다** — 리뷰 실패 시 PM이 직접 승인하지 않는다
3. **복구 행동이 불확실하면 즉시 AskUserQuestion** — 근거 없는 재시도 금지
4. **`pipeline-state.json`을 직접 수정하여 실패를 감추지 않는다** — 엔진 CLI만 사용 (VG-05)
