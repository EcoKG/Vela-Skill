---
name: "vela:analyze"
description: "📊 Vela 분석 — 의존성/보안/버그/성능/품질/아키텍처를 선택적으로 분석하고 markdown 요약을 생성한다."
---

# /vela:analyze — 프로젝트 경량 분석

v7.3-M1b에서 PDF 리포트 파이프라인이 제거됐다. 결과는 markdown으로 `.vela/artifacts/<ts>/analysis.md`에 저장되며, 필요하면 Claude Code가 브라우저/에디터에서 직접 PDF로 출력하면 된다.

### 절차

1. **분석 항목 선택** — 사용자에게 `AskUserQuestion`으로 다중 선택 질문:

   ```json
   {
     "questions": [
       {
         "question": "📊 분석할 항목을 선택하세요:",
         "header": "📊 Analyze",
         "options": [
           { "label": "Dependencies (Recommended)", "description": "npm audit + outdated 취약점/업데이트" },
           { "label": "Security", "description": "인증 취약점, 인젝션, 자격증명 노출, 데이터 유출" },
           { "label": "Bugs", "description": "로직 에러, 레이스 컨디션, null 참조, 에러 핸들링" },
           { "label": "Performance", "description": "N+1, 메모리 릭, 알고리즘 복잡도, I/O 병목" },
           { "label": "Code Quality", "description": "네이밍, 중복, 결합도, 가독성, 데드코드" },
           { "label": "Architecture", "description": "레이어 분리, 의존성 방향, 추상화, 모듈 경계" }
         ],
         "multiSelect": true
       }
     ]
   }
   ```

2. **Dependencies (선택된 경우)** — CLI 없이 skill 내부에서 직접 실행:

   ```bash
   npm audit --json 2>/dev/null || echo '{}'
   npm outdated --json 2>/dev/null || echo '{}'
   ```

   Claude가 두 JSON 출력을 읽고 severity/버전 gap 기준으로 요약 markdown을 작성한다. `.vela/artifacts/<ts>/deps.md` 에 저장.

3. **Security / Bugs / Performance / Code Quality / Architecture** — 코드 정적 분석:

   ```
   Agent(
     subagent_type="vela-researcher",
     prompt="mode: analyze\nitems: {selected_perspectives}\n프로젝트 경로: {cwd}\noutputPath: .vela/artifacts/{ts}/analysis.md"
   )
   ```

   v7.3-M2a: vela-analyzer가 vela-researcher(mode=analyze)로 흡수됨. v8.0 후속에서 번들 `/simplify` 위임 검토.

4. **결과 표시**

   - 성공: `📊 분석 완료! .vela/artifacts/<ts>/analysis.md`
   - 실패: stderr 메시지를 그대로 전달하고 원인 안내

### Friction Report (별도)

훅 마찰 집계는 이 스킬과 분리되어 있다. 언제든 직접 호출:

```bash
node .vela/cli/vela-friction.js [--limit 500] [--json]
```

gate-events.jsonl을 읽어 상위 VK/VG 코드, 단계별 분포, 정책 조정 제안을 출력한다.

### 제거 메모 (v7.3-M1b)

- `scripts/cli/vela-analyze.js` (817줄), `scripts/shared/dep-analyzer.js` (229줄) 삭제
- PDF 생성 파이프라인 제거 — 필요 시 Claude Code의 브라우저 출력 사용
- `vela-analyze.js friction` → `vela-friction.js`로 분리 (~130줄)
