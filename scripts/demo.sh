#!/usr/bin/env bash
# MintWiki acceptance demo: Milestone 1 steps 1–6 + token exchange and
# approval queue (6b/6c), Milestone 2 agent surfaces (step 7), and the
# receipts/portability check (step 8). Fresh binary, empty data directory.
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
grep -q "# Demo page" "$DATA/pages/projects/demo.md" && echo "PASS: page head lives as a plain .md file" && PASS=$((PASS+1)) || { echo "FAIL: .md mirror missing"; FAIL=$((FAIL+1)); }
grep -q "Demo page" "$DATA/site/projects/demo.html" && echo "PASS: static HTML built for the page" && PASS=$((PASS+1)) || { echo "FAIL: static html missing"; FAIL=$((FAIL+1)); }

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
grep -q "Demo page v2" "$DATA/pages/projects/demo.md" && echo "PASS: .md mirror follows the accepted head" && PASS=$((PASS+1)) || { echo "FAIL: .md mirror stale after accept"; FAIL=$((FAIL+1)); }

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

echo "== step 6b: service credential exchanges for a short-lived token =="
SVC_OUT=$("$BIN" service add --data "$DATA" --name demo-agent --ceiling /projects/** --tiers allow --max-ttl 30m)
SVC_CRED=$(echo "$SVC_OUT" | sed -n 's/^credential: //p')
[ -n "$SVC_CRED" ] && echo "PASS: service registered, credential shown once" && PASS=$((PASS+1)) || { echo "FAIL: service add"; FAIL=$((FAIL+1)); }
mint_call() { # cred body -> "code body"
  curl -s -w $'\n%{http_code}' -X POST "$BASE/v1/tokens" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$2"
}
resp=$(mint_call "$SVC_CRED" '{"paths":["/projects/**"],"ttl_seconds":600}'); code=$(echo "$resp" | tail -1); body=$(echo "$resp" | head -n -1)
ok "$code" "200" "exchange inside ceiling issues a token"
XTOK=$(echo "$body" | json_get token)
resp=$(edit "$XTOK" projects/demo "# Demo page v2 (service edit)" 2); code=$(echo "$resp" | tail -1)
ok "$code" "200" "exchanged token edits the page"
resp=$(mint_call "$SVC_CRED" '{"paths":["/private/**"],"ttl_seconds":600}'); code=$(echo "$resp" | tail -1); body=$(echo "$resp" | head -n -1)
ok "$code" "202" "exchange above ceiling escalates to the owner queue (202)"
REQID=$(echo "$body" | json_get request_id)
resp=$(mint_call "mwsvc_bogus" '{"paths":["/projects/**"]}'); code=$(echo "$resp" | tail -1)
ok "$code" "401" "unknown service credential rejected with 401"

echo "== step 6c: owner approves the escalated request; service picks up its token =="
poll() { curl -s -w $'\n%{http_code}' "$BASE/v1/tokens/$2" -H "Authorization: Bearer $1"; }
resp=$(poll "$SVC_CRED" "$REQID"); body=$(echo "$resp" | head -n -1)
[ "$(echo "$body" | json_get status)" = "pending" ] && echo "PASS: request waits as pending" && PASS=$((PASS+1)) || { echo "FAIL: poll pending: $body"; FAIL=$((FAIL+1)); }
"$BIN" mint-requests --data "$DATA" | grep -q "$REQID" && echo "PASS: owner queue lists the request" && PASS=$((PASS+1)) || { echo "FAIL: mint-requests list"; FAIL=$((FAIL+1)); }
"$BIN" approve-request --data "$DATA" --id "$REQID" >/dev/null || { echo "FAIL: approve-request"; FAIL=$((FAIL+1)); }
resp=$(poll "$SVC_CRED" "$REQID"); body=$(echo "$resp" | head -n -1)
XTOK2=$(echo "$body" | json_get token)
[ -n "$XTOK2" ] && echo "PASS: pickup after approval delivers the token" && PASS=$((PASS+1)) || { echo "FAIL: pickup: $body"; FAIL=$((FAIL+1)); }
resp=$(edit "$XTOK2" private/x "# Approved scope page" 0); code=$(echo "$resp" | tail -1)
ok "$code" "200" "approved token edits the out-of-ceiling page"
resp=$(mint_call "$SVC_CRED" '{"paths":["/secret/**"],"ttl_seconds":600}'); body=$(echo "$resp" | head -n -1)
REQID2=$(echo "$body" | json_get request_id)
"$BIN" deny-request --data "$DATA" --id "$REQID2" >/dev/null || { echo "FAIL: deny-request"; FAIL=$((FAIL+1)); }
resp=$(poll "$SVC_CRED" "$REQID2"); body=$(echo "$resp" | head -n -1)
[ "$(echo "$body" | json_get status)" = "denied" ] && [ -z "$(echo "$body" | json_get token)" ] && echo "PASS: denied request yields no token" && PASS=$((PASS+1)) || { echo "FAIL: denied poll: $body"; FAIL=$((FAIL+1)); }

echo "== step 7: M2 agent surfaces — HTTP MCP tools + WebMCP registration =="
mcp() { # body [token] -> response body
  if [ -n "${2:-}" ]; then
    curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $2" -H 'Content-Type: application/json' -d "$1"
  else
    curl -s -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d "$1"
  fi
}
rpc_call() { # tool args-json [token] -> inner result JSON, or ERROR
  mcp "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" "${3:-}" | python3 -c "
import sys,json
rpc=json.load(sys.stdin); res=rpc.get('result',{})
print('ERROR' if res.get('isError') else res['content'][0]['text'])
"
}
list=$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
names=$(echo "$list" | python3 -c "import sys,json;print(','.join(sorted(t['name'] for t in json.load(sys.stdin)['result']['tools'])))")
ok "$names" "backlinks,get_page,get_section,propose_edit,recent_changes,search" "MCP tools/list serves the six shared tools"
init=$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')
echo "$init" | grep -q '"name":"mintwiki"' && echo "PASS: MCP initialize answers with server info" && PASS=$((PASS+1)) || { echo "FAIL: initialize: $init"; FAIL=$((FAIL+1)); }
gp=$(rpc_call get_page '{"path":"projects/demo"}')
echo "$gp" | grep -q "Demo page v2" && echo "PASS: MCP get_page returns the page content" && PASS=$((PASS+1)) || { echo "FAIL: get_page: $gp"; FAIL=$((FAIL+1)); }
GREV=$(echo "$gp" | json_get revision)
page=$(curl -s "$BASE/projects/demo")
echo "$page" | grep -q "$GREV" && echo "PASS: MCP get_page revision matches the rendered page" && PASS=$((PASS+1)) || { echo "FAIL: revision mismatch"; FAIL=$((FAIL+1)); }
GUIDE=$(printf '# Guide\n\n## Alpha\n\nalpha banana text.\n\n## Beta\n\nbeta text.\n')
resp=$(edit "$TOK" projects/guide "$GUIDE" 0); code=$(echo "$resp" | tail -1)
ok "$code" "200" "guide page created for section/backlink checks"
LINKER=$(printf '# Linker\n\nSee [the guide](/projects/guide).\n')
resp=$(edit "$TOK" projects/linker "$LINKER" 0); code=$(echo "$resp" | tail -1)
ok "$code" "200" "linker page created for backlink checks"
sec=$(rpc_call get_section '{"path":"projects/guide","heading":"Alpha"}')
echo "$sec" | grep -q "banana" && ! echo "$sec" | grep -q "beta text" && echo "PASS: MCP get_section returns only the named section" && PASS=$((PASS+1)) || { echo "FAIL: get_section: $sec"; FAIL=$((FAIL+1)); }
srch=$(rpc_call search '{"query":"banana"}')
echo "$srch" | grep -q "projects/guide" && echo "PASS: MCP search finds pages by body text" && PASS=$((PASS+1)) || { echo "FAIL: search: $srch"; FAIL=$((FAIL+1)); }
bl=$(rpc_call backlinks '{"path":"projects/guide"}')
echo "$bl" | grep -q "projects/linker" && echo "PASS: MCP backlinks finds the linking page" && PASS=$((PASS+1)) || { echo "FAIL: backlinks: $bl"; FAIL=$((FAIL+1)); }
rc=$(rpc_call recent_changes '{"limit":1}')
echo "$rc" | grep -q '"path":"projects/linker"' && echo "PASS: MCP recent_changes returns the newest revision first" && PASS=$((PASS+1)) || { echo "FAIL: recent_changes: $rc"; FAIL=$((FAIL+1)); }
np=$(rpc_call propose_edit '{"path":"projects/demo","content":"# nope","expected_version":3}')
ok "$np" "ERROR" "MCP propose_edit without a token is an error"
pp=$(rpc_call propose_edit '{"path":"projects/demo","content":"# Demo page v2 (MCP proposed)","expected_version":3}' "$TOK")
MPROP=$(echo "$pp" | json_get proposal_id)
[ -n "$MPROP" ] && echo "PASS: MCP propose_edit with an allow token lands a proposal" && PASS=$((PASS+1)) || { echo "FAIL: propose_edit: $pp"; FAIL=$((FAIL+1)); }
page=$(curl -s "$BASE/projects/demo")
echo "$page" | grep -q "MCP proposed" && { echo "FAIL: MCP proposal moved the head"; FAIL=$((FAIL+1)); } || { echo "PASS: head unchanged while MCP proposal pending"; PASS=$((PASS+1)); }
"$BIN" accept --data "$DATA" --proposal "$MPROP" >/dev/null || { echo "FAIL: accept MCP proposal"; FAIL=$((FAIL+1)); }
page=$(curl -s "$BASE/projects/demo")
echo "$page" | grep -q "MCP proposed" && echo "PASS: accepted MCP proposal moved the head" && PASS=$((PASS+1)) || { echo "FAIL: accepted MCP content not live"; FAIL=$((FAIL+1)); }
grep -q "registerTool" "$DATA/site/webmcp.js" && grep -q "propose_edit" "$DATA/site/webmcp.js" && echo "PASS: static build generates webmcp.js from the shared definitions" && PASS=$((PASS+1)) || { echo "FAIL: webmcp.js missing or incomplete"; FAIL=$((FAIL+1)); }
grep -q "/webmcp.js" "$DATA/site/projects/demo.html" && echo "PASS: built pages load webmcp.js" && PASS=$((PASS+1)) || { echo "FAIL: page does not reference webmcp.js"; FAIL=$((FAIL+1)); }
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/webmcp.js")
ok "$code" "200" "server serves /webmcp.js"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/mcp")
ok "$code" "405" "GET /mcp refused with 405"

echo "== step 8: receipts verify; restart + data-dir copy renders the same page =="
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
