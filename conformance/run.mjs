// MintWiki cross-runtime conformance suite.
//
// The same black-box HTTP checks run against ANY MintWiki runtime —
// the Go binary, the Cloudflare Worker under `wrangler dev`, or the
// deployed demo — so the two implementations are held to one contract
// (M3 scope spec §5). Checks correspond to the scenarios in
// scripts/demo.sh; as milestones land, demo sections are ported here
// and both runtimes must pass.
//
// Usage: node conformance/run.mjs --base http://localhost:8787
// The target must already be seeded (Go: `mintwiki seed`; Cloudflare:
// cloudflare/scripts/seed.mjs).

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const base = (baseIdx >= 0 ? args[baseIdx + 1] : "http://localhost:8787").replace(/\/$/, "");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log(`conformance against ${base}`);

// --- Read surface (M2 contract, live on both runtimes' seeded demo) ---
{
  const res = await fetch(`${base}/`);
  const body = await res.text();
  check("GET / is 200 and names MintWiki", res.status === 200 && body.includes("MintWiki"));
  check("index links the seeded home page", body.includes('href="/home"'));
}
{
  const res = await fetch(`${base}/home`);
  const body = await res.text();
  const rev = res.headers.get("x-mintwiki-revision");
  check("GET /home is 200", res.status === 200);
  check("home names a full SHA-256 revision", /^[0-9a-f]{64}$/.test(rev ?? ""), `header: ${rev}`);
  check("home footer repeats the header revision", !!rev && body.includes(`revision ${rev}`));
  check("home renders the seed content", body.includes("humans and agents edit"));
}
{
  const res = await fetch(`${base}/sandbox/welcome`);
  check("GET /sandbox/welcome is 200", res.status === 200);
}
{
  const res = await fetch(`${base}/webmcp.js`);
  const body = await res.text();
  check("GET /webmcp.js is 200", res.status === 200);
  check(
    "webmcp.js carries all six shared tool definitions",
    ["get_page", "get_section", "search", "backlinks", "recent_changes", "propose_edit"].every((t) =>
      body.includes(`"name":"${t}"`) || body.includes(`"name": "${t}"`),
    ),
  );
}
{
  const res = await fetch(`${base}/definitely-not-a-page`);
  check("GET missing page is 404", res.status === 404);
}

// --- Write lane (M3.2 contract) ---
// Runs when CONFORMANCE_SERVICE_CRED names a service credential
// registered on the target with ceiling /conformance/** and tiers
// allow+approve (Go: `mintwiki service add`; Cloudflare: the
// bootstrap register-service route). The owner-side steps that are
// not HTTP on either runtime — proposal accept, request decide —
// stay in each runtime's own test suite, as in scripts/demo.sh.
const cred = process.env.CONFORMANCE_SERVICE_CRED;
if (cred) {
  const auth = (t) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
  const probe = `conformance/probe-${Date.now()}`;
  const exchange = async (req) => {
    const res = await fetch(`${base}/v1/tokens`, { method: "POST", headers: auth(cred), body: JSON.stringify(req) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const edit = async (token, path, content, expected) => {
    const res = await fetch(`${base}/edit`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ path, content, expected_version: expected }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const ex = await exchange({ tool: "edit_page", paths: ["/conformance/**"], tier: "allow", ttl_seconds: 600 });
  check("exchange inside the ceiling issues a token", ex.status === 200 && !!ex.body.token, `got ${ex.status}`);

  const applied = await edit(ex.body.token, probe, "# Conformance probe\n\napplied\n", 0);
  check("allow-tier edit applies at version 1", applied.status === 200 && applied.body.version === 1, `got ${applied.status}`);

  const stale = await edit(ex.body.token, probe, "stale", 0);
  check(
    "stale edit conflicts with current_version",
    stale.status === 409 && stale.body.current_version === 1,
    `got ${stale.status}`,
  );

  const exApprove = await exchange({ paths: ["/conformance/**"], tier: "approve", ttl_seconds: 600 });
  const proposed = await edit(exApprove.body.token, `${probe}-proposed`, "# Proposed\n", 0);
  check("approve-tier edit lands as a proposal (202)", proposed.status === 202 && proposed.body.status === "proposed", `got ${proposed.status}`);
  const ghost = await fetch(`${base}/${probe}-proposed`);
  check("a proposal does not move the head (page still 404)", ghost.status === 404);

  const esc = await exchange({ paths: ["/outside-ceiling/**"], tier: "allow", ttl_seconds: 600 });
  check("outside-ceiling exchange escalates (202)", esc.status === 202 && esc.body.status === "pending_approval", `got ${esc.status}`);
  const poll = await fetch(`${base}/v1/tokens/${esc.body.request_id}`, { headers: auth(cred) });
  const pollBody = await poll.json().catch(() => ({}));
  check("escalated request polls as pending", poll.status === 200 && pollBody.status === "pending");

  const badCred = await fetch(`${base}/v1/tokens`, {
    method: "POST",
    headers: auth("mwsvc_" + "99".repeat(32)),
    body: JSON.stringify({ paths: ["/conformance/**"] }),
  });
  check("unknown credential is a flat 401", badCred.status === 401);
} else {
  console.log("  skip write-lane section (set CONFORMANCE_SERVICE_CRED to run it)");
}

// --- Agent surface (M3.3 contract: POST /mcp) ---
{
  const rpc = async (method, params, auth) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const callTool = async (name, args, auth) => {
    const { body } = await rpc("tools/call", { name, arguments: args }, auth);
    const r = body.result ?? {};
    return {
      isError: r.isError === true,
      text: r.content?.[0]?.text ?? "",
      json: r.isError ? null : JSON.parse(r.content?.[0]?.text ?? "null"),
    };
  };

  const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
  check(
    "MCP initialize echoes the protocol version and names the server",
    init.body.result?.protocolVersion === "2025-03-26" && init.body.result?.serverInfo?.name === "mintwiki",
  );
  const disc = await rpc("server/discover", {});
  check("MCP server/discover answers the same payload", disc.body.result?.serverInfo?.name === "mintwiki");

  const list = await rpc("tools/list");
  const names = (list.body.result?.tools ?? []).map((t) => t.name);
  check(
    "MCP tools/list serves the six shared definitions in order",
    JSON.stringify(names) ===
      JSON.stringify(["get_page", "get_section", "search", "backlinks", "recent_changes", "propose_edit"]),
    `got ${names.join(",")}`,
  );

  const homePage = await callTool("get_page", { path: "home" });
  const homeRes = await fetch(`${base}/home`);
  check(
    "get_page agrees with the page surface on the head revision",
    !homePage.isError && homePage.json.revision === homeRes.headers.get("x-mintwiki-revision"),
  );

  const section = await callTool("get_section", { path: "home", heading: "Start here" });
  check("get_section extracts the named section", !section.isError && section.json.content.includes("How it works"));

  const search = await callTool("search", { query: "receipt" });
  check(
    "search finds the seeded content",
    !search.isError && search.json.results.some((h) => h.path === "how-it-works"),
  );

  const backlinks = await callTool("backlinks", { path: "home" });
  check(
    "backlinks finds the seeded inbound links",
    !backlinks.isError &&
      ["agent-reads", "how-it-works", "sandbox/welcome"].every((p) => backlinks.json.backlinks.includes(p)),
    `got ${backlinks.json?.backlinks?.join(",")}`,
  );

  const changes = await callTool("recent_changes", { limit: 50 });
  check(
    "recent_changes lists the seeded home revision with its author",
    !changes.isError && changes.json.changes.some((c) => c.path === "home" && c.author === "seed"),
  );

  const noTok = await callTool("propose_edit", { path: "home", content: "x", expected_version: 1 });
  check(
    "propose_edit without a token is a lane rejection",
    noTok.isError && noTok.text === "missing bearer token",
    `got: ${noTok.text}`,
  );

  const unknown = await rpc("resources/list");
  check("unknown MCP method is -32601", unknown.body.error?.code === -32601);

  const getMcp = await fetch(`${base}/mcp`);
  check("GET /mcp is 405", getMcp.status === 405);

  // With the conformance credential, propose_edit lands a proposal
  // and the head stays put (owner accept is per-runtime, covered by
  // each runtime's own tests).
  const cred2 = process.env.CONFORMANCE_SERVICE_CRED;
  if (cred2) {
    const exRes = await fetch(`${base}/v1/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${cred2}`, "content-type": "application/json" },
      body: JSON.stringify({ paths: ["/conformance/**"], tier: "allow", ttl_seconds: 600 }),
    });
    const exBody = await exRes.json().catch(() => ({}));
    const proposed = await callTool(
      "propose_edit",
      { path: "conformance/mcp-probe", content: "# MCP probe\n", expected_version: 0 },
      exBody.token,
    );
    check("propose_edit with a token lands as a proposal", !proposed.isError && proposed.json.status === "proposed");
    const ghost = await fetch(`${base}/conformance/mcp-probe`);
    check("the MCP proposal does not move the head", ghost.status === 404);
  }
}

// --- Cross-runtime token format (M3.2) ---
// A token minted by the OTHER runtime (same signing secret) must get
// PAST signature verification here and be stopped only by the jti
// registry — proving the JWT format is portable while revocation
// state stays per-instance, as designed.
const foreign = process.env.CONFORMANCE_FOREIGN_TOKEN;
if (foreign) {
  const res = await fetch(`${base}/edit`, {
    method: "POST",
    headers: { authorization: `Bearer ${foreign}`, "content-type": "application/json" },
    body: JSON.stringify({ path: "conformance/probe-x", content: "x", expected_version: 0 }),
  });
  const body = await res.json().catch(() => ({}));
  check(
    "foreign-minted token verifies cryptographically, stops at the registry",
    res.status === 401 && body.error === "token not minted by this wiki",
    `got ${res.status} ${body.error ?? ""}`,
  );
} else {
  console.log("  skip cross-runtime section (set CONFORMANCE_FOREIGN_TOKEN to run it)");
}

console.log(`conformance: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
