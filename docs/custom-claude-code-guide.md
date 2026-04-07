# 나만의 Claude Code 만들기 — 탐구 가이드

> Claude Agent SDK를 이용해 자체 CLI/TUI 에이전트를 만드는 방법과 옵션을 정리한 문서.
> 당장 구현하지 않고 방향성 탐구용으로 작성됨.

---

## 핵심 통찰

Claude Code는 2025년 **Claude Agent SDK**로 오픈되었다. Agent loop(도구 호출 루프, 컨텍스트 관리, 세션 관리)가 이미 패키지화되어 있어, **처음부터 다시 만들 필요가 없다**. 당신은 그 위에 UI 레이어와 도메인 로직만 입히면 된다.

> "The Agent SDK gives you the same tools, agent loop, and context management that power Claude Code, programmable in Python and TypeScript."
> — [Claude Agent SDK 공식 문서](https://platform.claude.com/docs/en/agent-sdk/overview)

---

## 아키텍처 레이어

```
┌─────────────────────────────────────────┐
│  TUI Layer (Ink / Textual / Rezi)       │  ← 사용자가 보는 화면
├─────────────────────────────────────────┤
│  Agent Loop (claude-agent-sdk)          │  ← query() / ClaudeSDKClient
├─────────────────────────────────────────┤
│  Tools (Read/Write/Bash/Grep/MCP)       │  ← 도구 호출
├─────────────────────────────────────────┤
│  Claude API (Sonnet/Opus/Haiku)         │  ← LLM
└─────────────────────────────────────────┘
```

| 레이어 | 역할 | 대표 선택지 |
|--------|------|------------|
| **Agent Loop** | 도구 호출 루프 자동화, 세션/컨텍스트 관리 | `@anthropic-ai/claude-agent-sdk` |
| **Tools** | 파일/쉘/웹 등 외부 접근 | 내장 툴 + MCP 서버 |
| **TUI** | 터미널 UI | **Ink** (React 기반, TS), **Textual** (Python), **Rezi** (고급 위젯) |
| **Permissions** | 도구 허가 제어 | `permissionMode`, `allowedTools`, 훅 |
| **Hooks** | 도구 호출 가로채기/감사 | PreToolUse, PostToolUse |

---

## SDK 두 가지 모드

### query() — 단방향 스트리밍

간단한 one-shot 작업에 적합. 세션 유지 불필요.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.ts",
  options: {
    allowedTools: ["Read", "Edit", "Bash"],
    permissionMode: "bypassPermissions",
  },
})) {
  console.log(message);
}
```

### ClaudeSDKClient — 양방향 대화

멀티턴 대화, 세션 유지, 커스텀 툴, 훅 지원. TUI를 만들려면 이걸 써야 한다.

```python
from claude_agent_sdk import ClaudeSDKClient

async with ClaudeSDKClient() as client:
    await client.query("What's the capital of France?")
    async for msg in client.receive_response():
        print(msg)

    # 같은 세션 — 컨텍스트 유지됨
    await client.query("What's the population of that city?")
    async for msg in client.receive_response():
        print(msg)
```

---

## 3가지 구현 옵션

### 옵션 1: 최소 단위 TUI (~10분)

**목표:** React 스타일 터미널 채팅 UI

**스택:** TypeScript + Ink + claude-agent-sdk

```bash
npm init -y
npm pkg set type=module
npm install @anthropic-ai/claude-agent-sdk ink react
npm install -D tsx typescript @types/react
```

**핵심 패턴:**
```tsx
// app.tsx
import { query } from "@anthropic-ai/claude-agent-sdk";
import { render, Box, Text, useInput } from "ink";
import { useState } from "react";

function App() {
  const [messages, setMessages] = useState<string[]>([]);
  const [input, setInput] = useState("");

  useInput(async (char, key) => {
    if (key.return) {
      setMessages(m => [...m, `> ${input}`]);
      for await (const msg of query({
        prompt: input,
        options: {
          allowedTools: ["Read", "Edit", "Bash", "Grep", "Glob"],
          permissionMode: "bypassPermissions",
        },
      })) {
        if (msg.type === "assistant") {
          setMessages(m => [...m, msg.message.content[0].text]);
        }
      }
      setInput("");
    } else if (key.backspace) {
      setInput(s => s.slice(0, -1));
    } else {
      setInput(s => s + char);
    }
  });

  return (
    <Box flexDirection="column">
      {messages.map((m, i) => <Text key={i}>{m}</Text>)}
      <Text color="cyan">{"> " + input}</Text>
    </Box>
  );
}

render(<App />);
```

**실행:**
```bash
ANTHROPIC_API_KEY=sk-... npx tsx app.tsx
```

**장점:** 빠른 프로토타입, React 지식 재사용
**한계:** 권한 승인 UI, 파일 선택, 멀티 탭 등은 직접 구현 필요

---

### 옵션 2: 도메인 특화 파이프라인 (Vela 방식)

**목표:** Claude Code 위에서 특정 워크플로우 강제

**스택:** 기존 Vela 아키텍처 (`vela-pipeline.js`)

Vela는 이미 이 방식을 구현했다:
- SDK query()를 감싸서 research → plan → execute → review 파이프라인 강제
- 도구 화이트리스트 + disallowedTools로 PM의 코드 작성 차단
- SDK reviewer가 Opus 단일 리뷰 게이트

**핵심 코드 위치:**
- `scripts/cli/vela-pipeline.js` — 오케스트레이터
- `scripts/shared/sdk-*.js` — 각 단계별 SDK 모듈
- `templates/pipeline.json` — 파이프라인 정의

**장점:** 비결정론적 LLM에 구조를 강제, 잘못된 결과물 방지
**한계:** TUI 없음 (Claude Code CLI를 통해 호출)

---

### 옵션 3: Full Custom Claude Code (TUI + MCP)

**목표:** 자체 UI로 완전한 인터랙티브 에이전트

**스택:** Python + Textual (또는 TS + Ink) + ClaudeSDKClient + MCP

**핵심 기법: MCP로 커스텀 인터랙티브 툴 만들기**

SDK가 subprocess로 돌기 때문에 내장 AskUserQuestion은 TUI를 렌더링할 수 없다. 대신 **SDK MCP Server**로 자체 툴을 만들어 Claude가 당신의 UI를 호출하게 한다:

```python
from claude_agent_sdk import tool, create_sdk_mcp_server, ClaudeSDKClient, ClaudeAgentOptions

# 커스텀 질문 툴 — 당신의 TUI가 질문을 렌더링하고 답을 수집
@tool("ask_user", "Ask the user a question", {
    "question": str,
    "options": list
})
async def ask_user(args):
    # 여기서 Textual 모달을 띄우고 사용자 입력 대기
    answer = await my_tui.show_question(args["question"], args["options"])
    return {"content": [{"type": "text", "text": answer}]}

# MCP 서버로 등록
server = create_sdk_mcp_server(
    name="interactive-ui",
    version="1.0.0",
    tools=[ask_user]
)

options = ClaudeAgentOptions(
    mcp_servers={"ui": server},
    allowed_tools=["mcp__ui__ask_user", "Read", "Edit", "Bash"]
)

async with ClaudeSDKClient(options=options) as client:
    await client.query("Help me refactor this code.")
    async for msg in client.receive_response():
        # TUI에 메시지 스트리밍
        my_tui.append_message(msg)
```

**참고 구현:**
- [oneryalcin/claude-ask-user-demo](https://github.com/oneryalcin/claude-ask-user-demo) — MCP로 AskUserQuestion 구현
- [mager/claude-tui-demo](https://github.com/mager/claude-tui-demo) — Ink + TypeScript TUI

**장점:** 완전한 UX 제어 (승인 모달, 파일 피커, 설정 마법사 등)
**한계:** 구현 복잡도, 유지보수 부담

---

## Permission Mode 비교

| 모드 | 동작 | 용도 |
|------|------|------|
| `default` | 매 도구마다 승인 요청 | 대화형 앱 (승인 콜백 필요) |
| `acceptEdits` | Edit/Write 자동 승인 | 코드 수정 자동화 |
| `bypassPermissions` | 전체 자동 승인 | 비대화형 자동 파이프라인 |

**주의:** K024 참조 — `dontAsk`/`acceptEdits`는 Read에도 interactive prompt 발생. 완전 자동 오케스트레이션에는 **`bypassPermissions` + `allowDangerouslySkipPermissions: true`** 조합 필수.

---

## Hooks (도구 호출 가로채기)

```typescript
import { HookMatcher } from "@anthropic-ai/claude-agent-sdk";

const options = {
  hooks: {
    PreToolUse: [
      new HookMatcher("Bash", [async (input, toolUseId, context) => {
        if (input.tool_input.command.includes("rm -rf /")) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Dangerous command blocked"
            }
          };
        }
        return {};
      }])
    ]
  }
};
```

**Vela 활용 예시:**
- PM의 Write/Edit 차단 (VK-07)
- 특정 경로 보호 (.vela/ 읽기 전용 등)
- 명령어 감사 로깅

---

## 시작 경로 권장

| 당신의 목표 | 권장 옵션 | 예상 시간 |
|-------------|-----------|-----------|
| Claude Code를 학습용으로 따라 만들기 | 옵션 1 (Ink + query) | 30분~1시간 |
| 특정 워크플로우(예: 코드 리뷰) 전용 에이전트 | 옵션 1 + 도메인 훅 | 1~2일 |
| 팀 전체의 개발 프로세스 강제 | 옵션 2 (Vela 확장) | 1~2주 |
| 완전한 자체 Claude Code 대체품 | 옵션 3 (TUI + MCP) | 2주+ |

---

## 참고 자료

### 공식 문서
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Python SDK Reference](https://platform.claude.com/docs/en/agent-sdk/python)
- [TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [How the Agent Loop Works](https://platform.claude.com/docs/en/agent-sdk/agent-loop)
- [Anthropic Engineering Blog — Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)

### 오픈소스 예제
- [claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python) — 공식 Python SDK (examples/streaming_mode.py 참고)
- [mager/claude-tui-demo](https://github.com/mager/claude-tui-demo) — Ink 기반 TUI 데모
- [oneryalcin/claude-ask-user-demo](https://github.com/oneryalcin/claude-ask-user-demo) — MCP 커스텀 툴 데모

### TUI 프레임워크
- **Ink** (TypeScript) — https://github.com/vadimdemedes/ink
- **Textual** (Python) — https://textual.textualize.io/
- **Rezi** (TypeScript, 고급) — Ink보다 리치한 위젯

---

## Vela와의 관계

Vela는 옵션 2(도메인 파이프라인)의 구현체다. 만약 Vela에 TUI를 추가한다면:

```
Vela 현재                      Vela + TUI (확장)
━━━━━━━━━━━━━━━━━━━━━━━━━━    ━━━━━━━━━━━━━━━━━━━━━━━━━━
vela-pipeline.js              vela-tui (Ink)
  ↓ query()                     ↓ ClaudeSDKClient
SDK 오케스트레이터              양방향 대화 루프 + MCP UI 툴
  ↓                              ↓
research/plan/execute         사용자 ↔ Claude ↔ MCP tools
                              (승인/거부/파일 선택 UI)
```

**확장 시 추가될 파일:**
- `scripts/tui/` — Ink 기반 React 컴포넌트
- `scripts/shared/mcp-ui-tools/` — AskUserQuestion/FileSelector/ApprovalModal MCP 래퍼
- `scripts/cli/vela-tui.js` — TUI 엔트리포인트

이 확장은 별도 마일스톤(M023+)으로 분리해서 진행할 수 있다.

---

## 결론

**Claude Agent SDK는 Claude Code의 엔진 자체를 라이브러리로 오픈한 것이다.** 당신이 할 일은:

1. **옵션 1** — 학습용 최소 TUI (30분)
2. **옵션 2** — 도메인 워크플로우 파이프라인 (Vela가 이미 구현)
3. **옵션 3** — 완전 커스텀 TUI + MCP (가장 복잡)

가장 빠른 시작: [mager/claude-tui-demo](https://github.com/mager/claude-tui-demo)를 clone해서 돌려보고, 코드를 읽으면서 변경해보는 것.
