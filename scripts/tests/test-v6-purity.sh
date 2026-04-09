#!/usr/bin/env bash
# test-v6-purity.sh — V4.1 잔재 탐지
#
# 검사 대상: 활성 지시사항 파일 (에이전트 MD, 스킬, 레퍼런스)
# 제외 패턴: "V6에서 제거", "REMOVED", "삭제", "removed", "was removed", "제거되었다"
#            — 이런 "과거형 언급"은 정상적인 마이그레이션 노트

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 검사 대상 경로
SEARCH_DIRS=(
  "$ROOT/SKILL.md"
  "$ROOT/skills"
  "$ROOT/references"
  "$ROOT/scripts/agents"
  "$ROOT/scripts/hooks"
)

# V4.1 금지 패턴 (정규식)
declare -A PATTERNS=(
  ["TeamCreate"]="TeamCreate"
  ["Teammate (active)"]="Teammate[[:space:]]"'"'"[[:alpha:]]"
  ["SendMessage"]="SendMessage"
  ["TaskCreate"]="TaskCreate"
  ["TaskUpdate"]="TaskUpdate"
  ["sdk-runner require"]="require.*sdk-runner"
  ["sdk-executor require"]="require.*sdk-executor"
  ["sdk-researcher require"]="require.*sdk-researcher"
  ["sdk-reviewer require"]="require.*sdk-reviewer"
  ["vela-pipeline run"]="vela-pipeline\.js.*run"
  ["Teammate 3명"]="Teammate.*3명\|3.*Teammate"
)

# 허용 예외 패턴 (이 문자열이 같은 줄에 있으면 무시)
ALLOW_PATTERNS="제거되었다\|V6에서 제거\|REMOVED\|삭제\|removed\|was removed\|V4\.1이었음\|V4\.1에서\|V4.1 concept\|제거됨\|더 이상\|not used\|no longer\|이 파일은.*제거\|사용하지 않는다\|불가\|사용 안\|쓰지 않는다\|존재하지 않는다"

echo "=== Vela V6 순수성 검사 ==="
echo "검사 대상: ${SEARCH_DIRS[*]}"
echo ""

for label in "${!PATTERNS[@]}"; do
  pattern="${PATTERNS[$label]}"

  # 대상 파일에서 패턴 검색, 예외 줄 제외
  matches=$(grep -rn --include="*.md" --include="*.js" --include="*.sh" \
    -E "$pattern" \
    "${SEARCH_DIRS[@]}" 2>/dev/null \
    | grep -v "$ALLOW_PATTERNS" \
    | grep -v "^Binary\|node_modules\|\.git" \
    || true)

  if [ -n "$matches" ]; then
    echo -e "${RED}[FAIL]${NC} '$label' 패턴 발견:"
    echo "$matches" | while IFS= read -r line; do
      echo "  $line"
    done
    echo ""
    FAIL=1
  fi
done

# 특수 케이스: test-v6-purity.sh 자신은 패턴 정의로 포함되므로 별도 처리
# (위 grep은 --include 필터로 자기 자신도 걸리지만 패턴 정의 줄은 허용)

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}[PASS]${NC} V4.1 잔재 없음"
  exit 0
else
  echo -e "${RED}[FAIL]${NC} V4.1 잔재 발견됨 — 위 파일을 수정하세요"
  exit 1
fi
