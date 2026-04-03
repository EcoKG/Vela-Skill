#!/usr/bin/env bash
# Integration tests for multi-language token extraction in change-surface.js
# Tests the 4 new universal extractors (identifier, getter_setter, template_expr, xml_attr)
# across 6 real-world scenarios per M018-CONTEXT.md test spec.
#
# Cases:
#   1. Java field rename → JSP EL residual reference (actual bug reproduction)
#   2. Python function rename → import reference
#   3. XML property rename → other XML reference
#   4. Existing JS extractor regression test
#   5. Complete rename → no false positive (verdict.pass === true)
#   6. Unknown language coverage via universal identifier extractor (.rs/.ex/.hs)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHANGE_SURFACE="$SCRIPT_DIR/scripts/shared/change-surface.js"
PASS=0
FAIL=0
TOTAL=0

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "  ❌ $1"; }

cleanup() {
  if [ -n "${TMPDIR_BASE:-}" ] && [ -d "$TMPDIR_BASE" ]; then
    rm -rf "$TMPDIR_BASE"
  fi
}
trap cleanup EXIT

TMPDIR_BASE="$(mktemp -d)"

# Helper: create an isolated git repo in a temp directory
# Usage: setup_repo "case_name"
# Sets REPO_DIR to the new repo path
setup_repo() {
  local name="$1"
  REPO_DIR="$TMPDIR_BASE/$name"
  mkdir -p "$REPO_DIR"
  cd "$REPO_DIR"
  git init -q
  git config user.email "test@test.com"
  git config user.name "Test"
}

# Helper: run analyze() and capture verdict.pass
# Usage: run_analyze → sets VERDICT_PASS ("true" or "false")
run_analyze() {
  VERDICT_PASS=$(node -e "
    const { analyze } = require('$CHANGE_SURFACE');
    const result = analyze('HEAD', { cwd: '$REPO_DIR' });
    console.log(result.verdict.pass);
  ")
}

echo "=== Multi-Language Token Extraction Tests ==="
echo "  change-surface.js: $CHANGE_SURFACE"
echo ""

# ────────────────────────────────────────────────────────────────
# Case 1: Java field rename → JSP EL residual reference
# Reproduces the actual bug: user_name → userName in Java,
# but ${loginUser.user_name} in JSP is not updated.
# Only the field lines are changed — no getter/setter in the diff
# so the getter_setter extractor doesn't produce a masking token.
# ────────────────────────────────────────────────────────────────
echo "--- Case 1: Java field rename → JSP EL residual reference ---"
setup_repo "case1"

# Initial commit: Java model with field + JSP view
mkdir -p src/model src/view
cat > src/model/User.java <<'JAVA'
public class User {
    private String user_name;
    private String email;

    public User(String user_name, String email) {
        this.user_name = user_name;
        this.email = email;
    }
}
JAVA

cat > src/view/profile.jsp <<'JSP'
<%@ page contentType="text/html" %>
<html>
<body>
  <h1>Profile</h1>
  <p>Name: ${loginUser.user_name}</p>
  <p>Email: ${loginUser.email}</p>
</body>
</html>
JSP

git add -A && git commit -q -m "initial: User model + JSP"

# Rename user_name → userName in Java only, JSP left unchanged
cat > src/model/User.java <<'JAVA'
public class User {
    private String userName;
    private String email;

    public User(String userName, String email) {
        this.userName = userName;
        this.email = email;
    }
}
JAVA
git add src/model/User.java

run_analyze
if [ "$VERDICT_PASS" = "false" ]; then
  pass "Case 1: Java rename detected JSP EL residual (verdict.pass=false)"
else
  fail "Case 1: Should detect user_name in JSP EL but got pass=true"
fi

# ────────────────────────────────────────────────────────────────
# Case 2: Python function rename → import reference
# ────────────────────────────────────────────────────────────────
echo "--- Case 2: Python function rename → import reference ---"
setup_repo "case2"

mkdir -p src
cat > src/utils.py <<'PY'
def get_user_name(user_id):
    """Fetch username from database"""
    return db.query(user_id).name
PY

cat > src/main.py <<'PY'
from utils import get_user_name

def run():
    name = get_user_name(42)
    print(name)
PY

git add -A && git commit -q -m "initial: Python utils + main"

# Rename function in utils.py, leave import in main.py unchanged
cat > src/utils.py <<'PY'
def getUserName(user_id):
    """Fetch username from database"""
    return db.query(user_id).name
PY
git add src/utils.py

run_analyze
if [ "$VERDICT_PASS" = "false" ]; then
  pass "Case 2: Python rename detected import residual (verdict.pass=false)"
else
  fail "Case 2: Should detect get_user_name in import but got pass=true"
fi

# ────────────────────────────────────────────────────────────────
# Case 3: XML property rename → other XML reference
# Renames both property and column in UserMapper, leaves
# OrderMapper untouched — tests xml_attr extractor detection.
# ────────────────────────────────────────────────────────────────
echo "--- Case 3: XML property rename → other XML reference ---"
setup_repo "case3"

mkdir -p mapper
cat > mapper/UserMapper.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.UserMapper">
  <resultMap id="userMap" type="User">
    <result property="user_name" column="user_name"/>
    <result property="email" column="email"/>
  </resultMap>
</mapper>
XML

cat > mapper/OrderMapper.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.OrderMapper">
  <resultMap id="orderMap" type="Order">
    <result property="user_name" column="buyer_name"/>
    <result property="total" column="total_amount"/>
  </resultMap>
</mapper>
XML

git add -A && git commit -q -m "initial: MyBatis XML mappers"

# Rename both property and column in UserMapper, leave OrderMapper unchanged
cat > mapper/UserMapper.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.UserMapper">
  <resultMap id="userMap" type="User">
    <result property="userName" column="userName"/>
    <result property="email" column="email"/>
  </resultMap>
</mapper>
XML
git add mapper/UserMapper.xml

run_analyze
if [ "$VERDICT_PASS" = "false" ]; then
  pass "Case 3: XML property rename detected residual in OrderMapper (verdict.pass=false)"
else
  fail "Case 3: Should detect user_name in OrderMapper.xml but got pass=true"
fi

# ────────────────────────────────────────────────────────────────
# Case 4: Existing JS extractor regression test
# module.exports rename: oldHelper → newHelper
# ────────────────────────────────────────────────────────────────
echo "--- Case 4: JS extractor regression test ---"
setup_repo "case4"

mkdir -p lib
cat > lib/helpers.js <<'JS'
function oldHelper(data) {
  return data.map(d => d.value);
}

module.exports = { oldHelper };
JS

cat > lib/consumer.js <<'JS'
const { oldHelper } = require('./helpers');

function process(items) {
  return oldHelper(items);
}

module.exports = { process };
JS

git add -A && git commit -q -m "initial: JS helpers + consumer"

# Rename oldHelper → newHelper in helpers.js, leave consumer.js unchanged
cat > lib/helpers.js <<'JS'
function newHelper(data) {
  return data.map(d => d.value);
}

module.exports = { newHelper };
JS
git add lib/helpers.js

run_analyze
if [ "$VERDICT_PASS" = "false" ]; then
  pass "Case 4: JS rename detected residual in consumer (verdict.pass=false)"
else
  fail "Case 4: Should detect oldHelper in consumer.js but got pass=true"
fi

# ────────────────────────────────────────────────────────────────
# Case 5: Complete rename → no false positive (verdict.pass === true)
# All references updated, nothing should be flagged
# ────────────────────────────────────────────────────────────────
echo "--- Case 5: Complete rename → no false positive ---"
setup_repo "case5"

mkdir -p src
cat > src/model.java <<'JAVA'
public class Model {
    private String user_name;
}
JAVA

cat > src/view.jsp <<'JSP'
<p>${model.user_name}</p>
JSP

cat > src/config.xml <<'XML'
<result property="user_name" column="user_name"/>
XML

git add -A && git commit -q -m "initial: all files with user_name"

# Rename user_name → userName in ALL files (complete rename)
cat > src/model.java <<'JAVA'
public class Model {
    private String userName;
}
JAVA

cat > src/view.jsp <<'JSP'
<p>${model.userName}</p>
JSP

cat > src/config.xml <<'XML'
<result property="userName" column="userName"/>
XML

git add -A

run_analyze
if [ "$VERDICT_PASS" = "true" ]; then
  pass "Case 5: Complete rename produces no false positive (verdict.pass=true)"
else
  fail "Case 5: Complete rename should pass but got verdict.pass=false"
fi

# ────────────────────────────────────────────────────────────────
# Case 6: Universal extractor covers unknown languages (.rs/.ex/.hs)
# No language-specific extractor exists — relies on identifier extractor
# ────────────────────────────────────────────────────────────────
echo "--- Case 6: Unknown language coverage via universal identifier extractor ---"
setup_repo "case6"

mkdir -p src
cat > src/math.rs <<'RS'
pub fn calculate_total(items: &[Item]) -> f64 {
    items.iter().map(|i| i.price).sum()
}
RS

cat > src/main.ex <<'EX'
defmodule App do
  def run do
    result = Math.calculate_total(items)
    IO.puts(result)
  end
end
EX

cat > src/lib.hs <<'HS'
import Math (calculate_total)

main :: IO ()
main = print (calculate_total [1, 2, 3])
HS

git add -A && git commit -q -m "initial: Rust + Elixir + Haskell with calculate_total"

# Rename calculate_total → computeTotal in Rust only
cat > src/math.rs <<'RS'
pub fn computeTotal(items: &[Item]) -> f64 {
    items.iter().map(|i| i.price).sum()
}
RS
git add src/math.rs

run_analyze
if [ "$VERDICT_PASS" = "false" ]; then
  pass "Case 6: Universal extractor detected residual in unknown langs (verdict.pass=false)"
else
  fail "Case 6: Should detect calculate_total in .ex/.hs but got pass=true"
fi

# ────────────────────────────────────────────────────────────────
# Summary
# ────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS/$TOTAL PASS, $FAIL FAIL ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "All tests passed."
exit 0
