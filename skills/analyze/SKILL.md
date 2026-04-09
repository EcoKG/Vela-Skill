---
name: "vela:analyze"
description: "📊 Vela 분석 보고서 — 의존성, 보안, 버그, 성능, 코드 품질, 아키텍처를 선택적으로 분석하고 PDF 보고서를 생성합니다."
---

# /vela:analyze — 프로젝트 분석 + PDF 보고서

이 커맨드가 호출되면 프로젝트의 의존성, 보안, 버그, 성능, 코드 품질, 아키텍처를 선택적으로 분석하고 PDF 보고서를 생성한다.

### 절차

1. **분석 항목 선택**

   사용자에게 분석할 항목을 다중 선택으로 질문한다:

   ```json
   {
     "questions": [
       {
         "question": "📊 분석할 항목을 선택하세요:",
         "header": "📊 Analyze",
         "options": [
           { "label": "Dependencies (Recommended)", "description": "npm audit + outdated 기반 의존성 취약점/업데이트 분석" },
           { "label": "Security", "description": "인증 취약점, 인젝션, 자격증명 노출, 데이터 유출 분석" },
           { "label": "Bugs", "description": "로직 에러, 레이스 컨디션, null 참조, 에러 핸들링 분석" },
           { "label": "Performance", "description": "N+1 쿼리, 메모리 릭, 알고리즘 복잡도, I/O 병목 분석" },
           { "label": "Code Quality", "description": "네이밍, 중복, 결합도, 가독성, 데드코드 분석" },
           { "label": "Architecture", "description": "레이어 분리, 의존성 방향, 추상화, 모듈 경계 분석" }
         ],
         "multiSelect": true
       }
     ]
   }
   ```

2. **선택 항목 매핑**

   | 선택 라벨 | CLI 값 |
   |----------|--------|
   | Dependencies | `deps` |
   | Security | `security` |
   | Bugs | `bugs` |
   | Performance | `performance` |
   | Code Quality | `code-quality` |
   | Architecture | `architecture` |

3. **코드 분석 항목 처리 (V6)**

   Dependencies만 선택된 경우: CLI만 실행 (npm audit 기반, 모델 불필요).
   Security, Bugs, Performance, Code Quality, Architecture 중 하나라도 선택되었으면:
   `Agent(subagent_type="vela-analyzer")`를 직접 호출하여 분석을 수행한다.

   ```
   Agent(
     subagent_type="vela-analyzer",
     prompt="분석 요청: {perspectives}, 프로젝트 경로: {cwd}, 출력 경로: {artifactDir}/analysis.md"
   )
   ```

4. **CLI 실행 (deps 항목 포함 시)**

   ```bash
   node .vela/cli/vela-analyze.js full --items <comma-separated-items> --output ./vela-analysis-report.pdf
   ```

5. **결과 표시**

   - 성공 시: `📊 분석 완료! PDF 보고서: ./vela-analysis-report.pdf` + 선택된 항목 요약
   - 실패 시: 에러 메시지를 사용자에게 표시하고 원인 안내
