#!/usr/bin/env bash
# server/node/smoke-test.sh — Quick regression check for server modularization
# Usage: Start server in background, then run this script.
#
# TLS note: The real server starts HTTPS when ssl/certificate/ exists.
# This script auto-detects the protocol by trying HTTP first, falling back
# to HTTPS with -k (accept self-signed). To force HTTP-only during dev,
# temporarily move server/node/ssl/certificate/ aside, or pass an explicit
# base URL: bash smoke-test.sh https://localhost:6001
set -euo pipefail

PORT="${PORT:-6001}"
BASE="${1:-}"

if [ -z "$BASE" ]; then
    if curl -sf --max-time 2 "http://localhost:$PORT/" -o /dev/null 2>/dev/null; then
        BASE="http://localhost:$PORT"
        CURL="curl -sf"
    else
        BASE="https://localhost:$PORT"
        CURL="curl -sfk"
    fi
else
    if [[ "$BASE" == https://* ]]; then
        CURL="curl -sfk"
    else
        CURL="curl -sf"
    fi
fi

fail() { echo "FAIL: $1"; exit 1; }
pass() { echo "  OK: $1"; }

echo "=== Smoke test against $BASE ==="

$CURL "$BASE/" -o /dev/null || fail "GET / — server not responding"
pass "GET / — index.html served"

STATUS=$($CURL "$BASE/api/test_auth" | node -e "let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>console.log(JSON.parse(s).status))")
[ "$STATUS" = "unset" ] || [ "$STATUS" = "success" ] || [ "$STATUS" = "incorrect" ] || fail "GET /api/test_auth — unexpected status: $STATUS"
pass "GET /api/test_auth — responded with status=$STATUS"

HTTP=$($CURL -o /dev/null -w "%{http_code}" "$BASE/api/list" 2>/dev/null || true)
[ "$HTTP" = "400" ] || [ "$HTTP" = "200" ] || fail "GET /api/list — unexpected HTTP $HTTP"
pass "GET /api/list — route wired (HTTP $HTTP)"

HTTP=$($CURL -o /dev/null -w "%{http_code}" -X POST "$BASE/proxy" -H "Content-Type: application/json" 2>/dev/null || true)
[ "$HTTP" = "400" ] || [ "$HTTP" = "401" ] || fail "POST /proxy — unexpected HTTP $HTTP"
pass "POST /proxy — route wired (HTTP $HTTP)"

HTTP=$($CURL -o /dev/null -w "%{http_code}" -X POST "$BASE/api/backup/import/prepare" -H "Content-Type: application/json" -d '{}' 2>/dev/null || true)
[ "$HTTP" = "400" ] || [ "$HTTP" = "200" ] || [ "$HTTP" = "401" ] || fail "POST /api/backup/import/prepare — unexpected HTTP $HTTP"
pass "POST /api/backup/import/prepare — route wired (HTTP $HTTP)"

HTTP=$($CURL -o /dev/null -w "%{http_code}" -X POST "$BASE/api/migrate/save-folder/scan" -H "Content-Type: application/json" -d '{}' 2>/dev/null || true)
[ "$HTTP" = "400" ] || [ "$HTTP" = "200" ] || [ "$HTTP" = "401" ] || fail "POST /api/migrate/save-folder/scan — unexpected HTTP $HTTP"
pass "POST /api/migrate/save-folder/scan — route wired (HTTP $HTTP)"

HTTP=$($CURL -o /dev/null -w "%{http_code}" "$BASE/api/update-check" 2>/dev/null || true)
[ "$HTTP" = "200" ] || fail "GET /api/update-check — unexpected HTTP $HTTP"
pass "GET /api/update-check — responded OK"

echo "=== All smoke tests passed ==="
