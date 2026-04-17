---
name: "vela:ralph"
description: "[DEPRECATED v7.3-M3] Claude Code 번들 /loop + /vela:ship으로 대체. v8.1에서 제거 예정."
---

# /vela:ralph — Deprecated (→ /loop /vela:ship으로 대체)

v7.3-M3에서 ralph의 TDD 반복 루프는 Claude Code 번들 `/loop` 스킬에 위임한다. Vela가 중복 구현하던 루프 로직이 Claude Code v2026 번들에 공식 지원되었다.

## 절차

1. 사용자에게 deprecation 경고 출력:
   ```
   ⚠️ /vela:ralph는 v7.3-M3에서 deprecated되었습니다.
   → /loop /vela:ship "작업 설명" 형태로 사용하세요.
      예: /loop /vela:ship "null 참조 버그 수정"
   v8.1에서 이 명령은 제거됩니다.
   ```
2. 사용자가 계속하길 원하면 `skills/ship/SKILL.md` 절차를 1회 실행. 반복이 필요한 경우 `/loop /vela:ship`으로 교체 안내.
