# 프롬프트 강화 및 최적화 — 반드시 실행

이 절차는 모든 모드(Explore/Research/Develop)에서 **예외 없이 최우선 실행**한다.

---

## 1단계: 분석

사용자 요청에서 다음을 파악한다:

- **도메인 감지**: UI/프론트엔드, API/백엔드, DB/데이터, 인프라/설정 중 해당 도메인
- **대상 파악**: 어떤 파일/모듈/클래스/기능인가
- **모호성 식별**: 불분명한 표현, 범위가 열려 있는 부분, 누락된 정보
- **기술 맥락**: 사용 중인 언어, 프레임워크, 패턴

---

## 2단계: 강화 프롬프트 생성 — 반드시 실행

분석 결과를 바탕으로 사용자의 원본 요청을 **구조화된 명확한 버전**으로 재작성한다.

### 강화 버전 작성 규칙

1. **대상(Target)**: 파일/모듈/클래스/API endpoint를 가능한 구체적으로 명시
2. **작업(Action)**: 동사 + 목적어 형태로 명확히 (예: "고쳐줘" → "X 파일의 Y 함수에서 Z 조건일 때 발생하는 버그 수정")
3. **현재 상태/문제(Current State)**: 기존 동작, 에러 메시지, 재현 방법 (해당 시)
4. **기대 결과(Expected Output)**: 완료 후 어떤 상태여야 하는가
5. **범위/제약(Constraints)**: 변경 범위 한정, 건드리면 안 되는 부분 (해당 시)

### 도메인별 강화 포인트 — 반드시 적용

**UI/프론트엔드**: 어떤 컴포넌트/화면, 어떤 인터랙션, 빈 상태/에러 상태/로딩 상태 처리 방법을 포함

**API/백엔드**: 엔드포인트 경로, HTTP 메서드, 요청/응답 형식, 에러 처리 방식을 포함

**DB/데이터**: 스키마 변경 범위, 마이그레이션 전략, 영향받는 쿼리를 포함

**인프라/설정**: 대상 환경(dev/staging/prod), 필요한 환경변수, 배포 방식을 포함

### 강화 버전 출력 포맷

강화 버전을 텍스트로 출력한 후 AskUserQuestion으로 확인한다:

```
원본 요청: "{user_original}"

✨ 강화된 프롬프트:
- 대상: {구체적인 파일/모듈/기능}
- 작업: {명확한 동사 + 목적어}
- 현재 상태: {기존 동작 또는 에러} (해당 시)
- 기대 결과: {완료 후 상태}
- 범위/제약: {변경 범위, 금지 영역} (해당 시)
```

---

## 3단계: 사용자와 협력 검토 — 반드시 실행

강화 버전을 출력한 후 `.vela/references/interactive-ui.md`의 **"프롬프트 강화 — 원본/강화 버전 확인"** 섹션 템플릿으로 AskUserQuestion을 실행한다.

### 선택별 처리

- **"강화 버전으로 진행" (Recommended)** → 강화된 프롬프트를 최종 프롬프트로 확정
- **"직접 수정"** → 사용자의 수정 의견을 수집한 후 반영하여 강화 버전 재생성 → 다시 3단계 반복 (최대 3회)
- **"원본으로 진행"** → 원본 프롬프트를 최종 프롬프트로 확정
- **"취소"** → 절차 중단

> 반복 루프: "직접 수정"을 선택하면 수정사항을 반영하여 강화 버전을 재생성하고, 다시 출력 후 3단계를 반복한다.

---

## 4단계: 이해 확인(Reflection) — 반드시 실행

최종 확정된 프롬프트를 바탕으로 PM이 이해한 내용을 아래 포맷으로 출력한다.
이 단계를 건너뛰는 것은 **금지**한다.

### Reflection 포맷

1. **대상**: 어떤 파일/모듈/클래스를 수정하는가
2. **작업**: 무엇을 하는가
3. **상세**: 재현 조건, 에러, 기대 동작 (해당 시)
4. **범위**: 수정 범위 한정
5. **결정사항**: 도메인별 회색 영역에서 결정된 내용 (해당 시)

Reflection 출력 후 `.vela/references/interactive-ui.md`의 **"프롬프트 최적화 — 조립 후 확인"** 템플릿으로 AskUserQuestion을 실행한다:

- **"이대로 진행" (Recommended)** → 실행 방식 결정으로 진행 (단일 파이프라인 or 스프린트)
- **"추가 보완"** → 3단계 "직접 수정" 경로로 복귀
- **"원본으로 진행"** → 원본 프롬프트로 실행 방식 결정
- **"취소"** → 절차 중단

승인된 프롬프트가 확정되면 **5단계 Scale Mismatch Guard**로 진행한다. 그 이후 `vela-engine.js init`을 호출하고, PM이 Agent 도구로 파이프라인을 진행한다.

---

## 5단계: Scale Mismatch Guard (v6.1+ / v7.0 확장) — 반드시 실행

사용자가 선택한 scale(`/vela:fix`, `/vela:small`, `/vela:medium`, `/vela:large`, `/vela:ralph`, `/vela:hotfix`)과 실제 작업 무게가 명백히 어긋나면, **제안만** 띄워 사용자에게 변경 기회를 준다. 자동 변경은 절대 금지 — 사용자 의도 존중이 최우선이다.

### 설계 원칙

1. **자동 변경 금지** — PM은 절대로 사용자가 선택한 scale을 자기 마음대로 바꾸지 않는다. 제안 후 사용자 결정을 기다린다.
2. **제안만 제공** — 아래 heuristic 신호가 2개 이상 동시에 만족될 때만 AskUserQuestion을 띄운다.
3. **첫 옵션은 "그대로 진행"** — 사용자가 무심코 Enter 쳐도 원래 선택이 유지된다.
4. **약한 신호 무시** — 노이즈 방지.
5. **ralph/hotfix는 점검 대상 제외** — 의도가 매우 specific한 경우라 제안 없이 사용자 선택 존중.
6. **`.vela/config.json`의 `scale_guard.enabled: false`로 옵트아웃 가능** — 설정이 꺼져 있으면 이 단계를 스킵한다.
7. **(v7.0) fix ↔ large 변환** — `/vela:fix`는 targets가 명확한 일상 작업에 최적. 다음 두 경우에만 large 제안:
   - upgrade 키워드가 매우 강하게 감지됨 (bootstrap / 신규 모듈 / 시스템 전체 재설계)
   - locate confidence가 low로 예측됨 (모호한 프롬프트, 좌표 없음)

### Heuristic 신호 리스트

#### Downgrade 신호 (선택한 scale이 너무 큼 — 더 작은 scale 제안)

**2개 이상 만족 시 발동**:

1. 프롬프트에 downgrade 키워드 포함:
   - 한국어: `typo`, `오타`, `주석`, `포맷팅`, `들여쓰기`, `한 줄`, `하나만`, `간단히`, `빠르게`
   - 영어: `typo`, `comment`, `formatting`, `one line`, `small`, `minor`, `quick`

2. 프롬프트 길이 20단어 미만

3. 프롬프트에 명확한 좌표가 이미 있음 (예: `auth.ts:42`, `loginHandler` 함수명, 단일 파일 경로)

4. `scale = large`이고 위 1~3 중 2개 이상 → small 또는 medium 제안

#### Upgrade 신호 (선택한 scale이 너무 작음 — 더 큰 scale 제안)

**2개 이상 만족 시 발동**:

1. 프롬프트에 upgrade 키워드 포함:
   - 한국어: `마이그레이션`, `리팩토링`, `재설계`, `전체`, `시스템`, `보안`, `인증`, `결제`, `OAuth`, `aggregate`, `도메인`, `레이어`
   - 영어: `migration`, `refactor`, `redesign`, `system-wide`, `security`, `authentication`, `payment`, `OAuth`, `aggregate`, `domain`

2. 3개 이상의 파일/디렉토리 언급

3. "신규" + "기능" 또는 "새로운" + "모듈" 조합

4. `scale = small` 또는 `scale = medium`이고 위 1~3 중 2개 이상 → 더 큰 scale 제안

### 판정 매트릭스

| 사용자 선택 | downgrade ≥2 | upgrade ≥2 | 신호 부족 |
|---|---|---|---|
| `/vela:small` | — | medium 또는 fix 제안 | 그대로 |
| `/vela:medium` | small 제안 | fix 또는 large 제안 | 그대로 |
| `/vela:fix` (v7.0) | small 제안 | large 제안 (bootstrap/refactor/모호할 때) | 그대로 |
| `/vela:large` | small 또는 fix 제안 (대부분의 명확한 작업에서) | — | 그대로 |
| `/vela:ralph` | (점검 제외) | (점검 제외) | 그대로 |
| `/vela:hotfix` | (점검 제외) | (점검 제외) | 그대로 |

**v7.0 이후 `/vela:fix`가 일상 작업의 기본 추천이다.** 사용자가 `/vela:large`를 호출했는데 작업이 명확한 target을 가지고 있다면 `fix`로 제안 (research exploratory → targeted 전환으로 ~80% 비용 절감).

### AskUserQuestion — Scale 점검 제안

신호 2개 이상 발동 시 `.vela/references/interactive-ui.md`의 **"Scale 점검 — 작업 무게 재확인"** 섹션 템플릿으로 AskUserQuestion을 실행한다.

예시 (downgrade 시):
```
⛵ Scale 점검 — 이 작업은 {현재 scale}보다 가벼워 보입니다.

원본: {user_original}
추정: {단일 파일 / 1-2줄 / 간단한 편집 등 — 감지된 신호 요약}
현재 scale: {현재} ({현재 pipeline type}, 단계 수, 추정 토큰 범위)
권장 scale: {권장} ({권장 pipeline type}, 단계 수, 추정 토큰 범위)
```

옵션 (순서 절대 고정 — "그대로 진행"이 반드시 첫 번째):
1. **"{현재 scale} 그대로 진행 (사용자 의도 존중)"** ← 안전 기본값
2. **"{권장 scale}로 변경 (비용/단계 축소)"**
3. **"중간 scale로 절충"** (downgrade small vs 현재 large인 경우 medium, upgrade small vs large인 경우 medium)
4. **"취소"**

사용자가 옵션 1을 선택하면 원래 scale 그대로 `vela-engine init` 호출.
옵션 2~3을 선택하면 새 scale로 `vela-engine init` 호출.
옵션 4를 선택하면 절차 중단.

### 설정

`.vela/config.json`:
```json
{
  "scale_guard": {
    "enabled": true,
    "thresholds": {
      "downgrade_signals_min": 2,
      "upgrade_signals_min": 2
    }
  }
}
```

- `enabled: false` → 이 단계 전체 스킵
- `thresholds`를 낮추면 더 민감하게 (발동률 ↑), 높이면 덜 민감하게 (노이즈 ↓)

### 제외 조건 (한 번 더 강조)

- **ralph/hotfix scale 선택 시 이 단계 전체 스킵** — 사용자가 의도를 명확히 표현한 경우
- `config.scale_guard.enabled == false` 시 스킵
- 신호 미달 시 조용히 진행 — 사용자에게 보여주지 않는다

---

## 도메인별 회색 영역 가이드 — 강화 시 적용

요청 내용에서 도메인을 감지하고, 해당 도메인의 **회색 영역**(모호한 결정 지점)을 강화 버전에 포함하거나 사용자에게 묻는다.

### UI/프론트엔드 작업
- 레이아웃: 어떤 배치? 반응형 필요?
- 인터랙션: 클릭/호버/드래그 동작?
- 빈 상태: 데이터 없을 때 어떻게 표시?
- 에러 상태: 실패 시 사용자에게 어떻게 알림?
- 로딩 상태: 스피너? 스켈레톤?

### API/백엔드 작업
- 응답 형식: JSON 구조? 페이지네이션?
- 에러 처리: HTTP 상태 코드? 에러 메시지 형식?
- 인증: 필요 여부? 방식 (JWT/세션/OAuth)?
- 유효성 검사: 어떤 입력을 어떻게 검증?
- 속도 제한: Rate limiting 필요?

### DB/데이터 작업
- 스키마: 어떤 필드? 타입? 제약조건?
- 마이그레이션: 기존 데이터 어떻게 처리?
- 인덱스: 어떤 쿼리 패턴?
- 관계: 1:N? M:N? CASCADE?

### 인프라/설정 작업
- 환경: dev/staging/prod 차이?
- 비밀: 어떤 환경변수 필요?
- 배포: 자동/수동?

---

## UI 템플릿

모든 AskUserQuestion은 `.vela/references/interactive-ui.md`에서 읽어라.
