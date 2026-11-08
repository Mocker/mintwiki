#!/usr/bin/env bash
# MintWiki Milestone 1 acceptance demo: the 7 steps from the build spec,
# run against a fresh binary and an empty data directory.
set -u
cd "$(dirname "$0")/.."

BIN="${BIN:-/tmp/mintwiki-demo-bin}"
PORT="${PORT:-18099}"
BASE="http://127.0.0.1:${PORT}"
DATA="$(mktemp -d)/data"
DATA2="$(mktemp -d)/data-copy"
PASS=0; FAIL=0
SRV_PID=""

cleanup() { [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; }
trap cleanup EXIT

ok()   { if [ "$1" = "$2" ]; then echo "PASS: $3"; PASS=$((PASS+1)); else echo "FAIL: $3 (want [$2], got [$1])"; FAIL=$((FAIL+1)); fi }
json_get() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))"; }

echo "== build =="
go build -o "$BIN" ./cmd/mintwiki || { echo "build failed"; exit 1; }

"$BIN" init --data "$DATA" >/dev/null
"$BIN" serve --data "$DATA" --addr "127.0.0.1:${PORT}" >/tmp/mintwiki-demo-server.log 2>&1 &
SRV_PID=$!
for i in $(seq 1 30); do curl -s -o /dev/null "$BASE/" && break || sleep 0.3; done

edit() { # token path content expected -> "code body"
  local body
  body=$(python3 -c "import json,sys;print(json.dumps({'path':sys.argv[1],'content':sys.argv[2],'expected_version':int(sys.argv[3])}))" "$2" "$3" "$4")
  curl -s -w $'\n%{http_code}' -X POST "$BASE/edit" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$body"
}

echo "== step 1: empty wiki, page not found =="
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/projects/demo")
ok "$code" "404" "GET missing page returns 404"

echo "== step 2: owner mints allow token; agent creates the page =="
MINT_OUT=$("$BIN" mint --data "$DATA" --actor agent-1 --paths /projects/** --tier allow)
TOK=$(echo "$MINT_OUT" | sed -n 's/^token: //p')
resp=$(edit "$TOK" projects/demo "# Demo page" 0); code=$(echo "$resp" | tail -1); body=$(echo "$resp" | head -n -1)
ok "$code" "200" "first edit applied (HTTP 200)"
REV1=$(echo "$body" | json_get revision)
[ -n "$REV1" ] && echo "PASS: revision returned ($REV1)" && PASS=$((PASS+1)) || { echo "FAIL: no revision in response"; FAIL=$((FAIL+1)); }
page=$(curl -s "$BASE/projects/demo")
echo "$page" | grep -q "Demo page" && echo "PASS: page renders its content" && PASS=$((PASS+1)) || { echo "FAIL: page render"; FAIL=$((FAIL+1)); }
echo "$page" | grep -q "$REV1" && echo "PASS: render names revision R1" && PASS=$((PASS+1)) || { echo "FAIL: revision not in render"; FAIL=$((FAIL+1)); }

echo "== step 3: stale writer conflicts =="
resp=$(edit "$TOK" projects/demo "# stale overwrite" 0); code=$(echo "$resp" | tail -1)
ok "$code" "409" "stale expected_version rejected with 409"
page=$(curl -s "$BASE/projects/demo")
echo "$page" | grep -q "Demo page" && echo "PASS: head unchanged after conflict" && PASS=$((PASS+1)) || { echo "FAIL: head moved on conflict"; FAIL=$((FAIL+1)); }

echo "== step 4: out-of-scope edit rejected =="
resp=$(edit "$TOK" private/x "# secret" 0); code=$(echo "$resp" | tail -1)
ok "$code" "403" "edit outside token scope rejected with 403"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/private/x")
ok "$code" "404" "no page was written out of scope"

echo "== step 5: approve tier proposes; owner accepts =="
MINT_OUT=$("$BIN" mint --data "$DATA" --actor agent-2 --paths /projects/** --tier approve)
TOK2=$(echo "$MINT_OUT" | sed -n 's/^token: //p')
resp=$(edit "$TOK2" projects/demo "# Demo page v2 (proposed)" 1); code=$(echo "$resp" | tail -1); body=$(echo "$resp" | head -n -1)
ok "$code" "202" "approve-tier edit lands as proposal (HTTP 202)"
PROP=$(echo "$body" | json_get proposal_id)
page=$(curl -s "$BASE/projects/demo")
echo "$page" | grep -q "Demo page v2" && { echo "FAIL: proposal moved the head"; FAIL=$((FAIL+1)); } || { echo "PASS: head unchanged while proposal pending"; PASS=$((PASS+1)); }
"$BIN" accept --data "$DATA" --proposal "$PROP" >/dev/null || { echo "FAIL: accept command"; FAIL=$((FAIL+1)); }
page=$(curl -s "$BASE/projects/demo")
echo "$page" | grep -q "Demo page v2" && echo "PASS: accepted proposal moved the head" && PASS=$((PASS+1)) || { echo "FAIL: accepted content not live"; FAIL=$((FAIL+1)); }

echo "== step 6: revoked and expired tokens rejected =="
MINT_OUT=$("$BIN" mint --data "$DATA" --actor agent-3 --paths /projects/** --tier allow)
TOK3=$(echo "$MINT_OUT" | sed -n 's/^token: //p'); JTI3=$(echo "$MINT_OUT" | sed -n 's/^jti: //p')
"$BIN" revoke --data "$DATA" --jti "$JTI3" >/dev/null
resp=$(edit "$TOK3" projects/demo "# revoked write" 2); code=$(echo "$resp" | tail -1)
ok "$code" "401" "revoked token rejected with 401"
MINT_OUT=$("$BIN" mint --data "$DATA" --actor agent-4 --paths /projects/** --tier allow --ttl 1s)
TOK4=$(echo "$MINT_OUT" | sed -n 's/^token: //p')
sleep 2
resp=$(edit "$TOK4" projects/demo "# expired write" 2); code=$(echo "$resp" | tail -1)
ok "$code" "401" "expired token rejected with 401"

echo "== step 7: receipts verify; restart + data-dir copy renders the same page =="
out=$("$BIN" verify-receipts --data "$DATA")
echo "$out" | grep -q "receipt chain OK" && echo "PASS: $out" && PASS=$((PASS+1)) || { echo "FAIL: receipts: $out"; FAIL=$((FAIL+1)); }
kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""
cp -r "$DATA" "$DATA2"
"$BIN" serve --data "$DATA2" --addr "127.0.0.1:${PORT}" >/tmp/mintwiki-demo-server2.log 2>&1 &
SRV_PID=$!
for i in $(seq 1 30); do curl -s -o /dev/null "$BASE/" && break || sleep 0.3; done
hdr=$(curl -s -D - -o /dev/null "$BASE/projects/demo" | grep -i "^X-MintWiki-Revision:" | tr -d '\r' | awk '{print $2}')
page=$(curl -s "$BASE/projects/demo")
echo "$page" | grep -q "Demo page v2" && [ -n "$hdr" ] && echo "PASS: copied data dir renders same page (revision $hdr)" && PASS=$((PASS+1)) || { echo "FAIL: portability check"; FAIL=$((FAIL+1)); }

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
