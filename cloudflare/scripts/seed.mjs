// Seed a running MintWiki Cloudflare instance with the demo wiki:
// walks ../../deploy/seed (the same Markdown tree the Go `mintwiki
// seed` command consumes — seed content is runtime-agnostic) and
// posts each page to the instance's /internal/seed-page. Seeding is
// idempotent: pages that already exist are skipped, so this is safe
// to run on every deploy.
//
// Usage: BASE_URL=https://mintwiki.example node scripts/seed.mjs
// Requires ALLOW_SEED=true on the Worker (see wrangler.jsonc).

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const seedDir = fileURLToPath(new URL("../../deploy/seed", import.meta.url));

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

let applied = 0;
let skipped = 0;
for (const file of (await walk(seedDir)).sort()) {
  const pagePath = relative(seedDir, file).replace(/\\/g, "/").replace(/\.md$/, "");
  const content = await readFile(file, "utf8");
  const res = await fetch(`${base}/internal/seed-page`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: pagePath, content }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`seed ${pagePath}: HTTP ${res.status} ${body.error ?? ""}`);
    process.exit(1);
  }
  if (body.status === "applied") applied++;
  else skipped++;
  console.log(`${body.status}: ${pagePath}`);
}
console.log(`seed complete: ${applied} applied, ${skipped} skipped`);
