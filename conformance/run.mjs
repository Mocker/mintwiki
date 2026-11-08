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

console.log(`conformance: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
