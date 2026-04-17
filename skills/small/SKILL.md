---
name: "vela:small"
description: "[DEPRECATED v7.3-M3] /vela:ship의 deprecation 셤. v8.1에서 제거 예정."
---

# /vela:small — Deprecated (→ /vela:ship으로 리다이렉트)

v7.3-M3에서 small/medium/large/ralph는 모두 `/vela:ship`으로 통합되었다.

## 절차

1. 사용자에게 deprecation 경고 출력:
   ```
   ⚠️ /vela:small은 v7.3-M3에서 deprecated되었습니다.
   → /vela:ship을 사용하세요. v8.1에서 이 명령은 제거됩니다.
   자동으로 /vela:ship으로 리다이렉트합니다.
   ```
2. `skills/ship/SKILL.md` 절차를 실행 (동일한 $ARGUMENTS 전달)
