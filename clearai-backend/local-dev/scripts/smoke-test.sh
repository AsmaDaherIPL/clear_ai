#!/usr/bin/env bash
# ============================================================================
# smoke-test.sh — hit every live endpoint against a local backend.
#
# Usage:
#   ./local-dev/scripts/smoke-test.sh [BASE_URL]
#
# Default BASE_URL: http://localhost:3000
#
# Auth: in NODE_ENV=development the backend's APIM-secret check is a no-op,
# so requests don't need any headers. Behind APIM in prod, this script needs
# an Entra token (out of scope here — see the infra-agent handover).
#
# Exit codes:
#   0 — every probe matched its expected status
#   1 — one or more probes failed
# ============================================================================

set -u

BASE_URL="${1:-http://localhost:3000}"
PASS=0
FAIL=0

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
nope() { printf '\033[31m  ✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }

check_status() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    ok "$name → $actual"
  else
    nope "$name → expected $expected, got $actual"
  fi
}

bold "Smoke-testing $BASE_URL"
echo

# ----------------------------------------------------------------------------
# 1. Probes
# ----------------------------------------------------------------------------
bold "Probes"

status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
check_status "GET /health" "200" "$status"

status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/ready")
# /ready may return 503 briefly during cold start; both are acceptable.
if [[ "$status" == "200" || "$status" == "503" ]]; then
  ok "GET /ready → $status (200=ready, 503=warming both fine)"
else
  nope "GET /ready → expected 200 or 503, got $status"
fi

# ----------------------------------------------------------------------------
# 2. Submission description
# ----------------------------------------------------------------------------
echo
bold "Pipeline / submission-description"

# Pick a real 12-digit code that exists in zatca_hs_codes. Fallback to a
# made-up one to exercise the 404 path; real test should use a known good code.
status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/pipeline/submission-description" \
  -H "content-type: application/json" \
  -d '{"description":"wireless headphones","code":"851830000000"}')
# 200 if the code exists in the loaded catalog, 404 if your DB hasn't been seeded.
case "$status" in
  200) ok "POST /pipeline/submission-description → 200 (code present in catalog)";;
  404) ok "POST /pipeline/submission-description → 404 unknown_code (DB not seeded? run 'pnpm db:seed')";;
  *)   nope "POST /pipeline/submission-description → expected 200 or 404, got $status";;
esac

status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/pipeline/submission-description" \
  -H "content-type: application/json" \
  -d '{"description":"x","code":"BADCODE"}')
check_status "POST /pipeline/submission-description (bad code) → 400" "400" "$status"

# ----------------------------------------------------------------------------
# 3. Declaration runs
# ----------------------------------------------------------------------------
echo
bold "Declaration runs"

# 3a. POST without body → 400 (missing file part)
status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/declaration-runs" \
  -H "content-type: multipart/form-data; boundary=X" \
  -d "")
# Either 400 (validation) or 415 (bad content-type). Both prove the route is mounted.
case "$status" in
  400|415) ok "POST /declaration-runs (no body) → $status (validation/415 both expected)";;
  *)       nope "POST /declaration-runs (no body) → expected 400 or 415, got $status";;
esac

# 3b. GET non-existent run → 404
fake_id="00000000-0000-0000-0000-000000000000"
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/declaration-runs/$fake_id")
check_status "GET /declaration-runs/$fake_id → 404" "404" "$status"

# 3c. PATCH non-existent run with bad body → 400 or 404
status=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH "$BASE_URL/declaration-runs/$fake_id" \
  -H "content-type: application/json" \
  -d '{"status":"completed"}')
case "$status" in
  400|404) ok "PATCH /declaration-runs/$fake_id (bad body) → $status";;
  *)       nope "PATCH /declaration-runs/$fake_id (bad body) → expected 400 or 404, got $status";;
esac

# 3d. GET classifications on non-existent run → 404
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/declaration-runs/$fake_id/classifications")
check_status "GET /declaration-runs/$fake_id/classifications → 404" "404" "$status"

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo
bold "Result: $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
