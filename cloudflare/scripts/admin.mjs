#!/usr/bin/env node
// admin.mjs — the MintWiki Cloudflare runtime's owner client (M3.4).
// The same verbs as the Go CLI, over the /v1/admin/* surface:
//
//   mint             [--actor NAME] [--paths a/**,b] [--tier allow|approve] [--ttl SECONDS]
//   revoke           --jti ID
//   service add      --name NAME --ceiling a/**[,b/**] --tiers allow[,approve] --max-ttl SECONDS
//   service list
//   service revoke   --name NAME
//   mint-requests    [--status pending]
//   approve-request  --id ID
//   deny-request     --id ID
//   proposals        [--status pending]
//   accept           --id ID
//   verify-receipts
//   seed             [DIR]   (default: ../../deploy/seed)
//
// Config (environment only — the admin token never comes from a file
// in this repo):
//   MINTWIKI_URL          base URL of the instance (default http://localhost:8787)
//   MINTWIKI_ADMIN_TOKEN  the OWNER_ADMIN_TOKEN secret value (required)
//
// A service credential is printed exactly once, at `service add` —
// same rule as the Go CLI. Store it like a password.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.env.MINTWIKI_URL ?? "http://localhost:8787").replace(/\/$/, "");
const adminToken = process.env.MINTWIKI_ADMIN_TOKEN;
if (!adminToken) {
  console.error("MINTWIKI_ADMIN_TOKEN is not set");
  process.exit(2);
}

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      out[key] = args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[++i] : "true";
    }
  }
  return out;
}

async function call(method, path, body) {
  const res = await fetch(`${base}/v1/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${method} ${path}: HTTP ${res.status} ${data.error ?? ""}`);
    process.exit(1);
  }
  return data;
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// Only `service` and `seed` take a positional second argument;
// every other command's arguments are flags from position two on.
const argv = process.argv.slice(2);
const cmd = argv[0];
const sub = cmd === "service" || cmd === "seed" ? argv[1] : undefined;
const f = flags(cmd === "service" || cmd === "seed" ? argv.slice(2) : argv.slice(1));

switch (cmd) {
  case "mint": {
    const body = {};
    if (f.actor) body.actor = f.actor;
    if (f.paths) body.paths = f.paths.split(",");
    if (f.tier) body.tier = f.tier;
    if (f.ttl) body.ttl_seconds = parseInt(f.ttl, 10);
    const r = await call("POST", "/mint", body);
    console.log("jti:", r.jti);
    console.log("expires:", r.expires_at);
    console.log("token:", r.token);
    break;
  }
  case "revoke": {
    if (!f.jti) { console.error("--jti is required"); process.exit(2); }
    print(await call("POST", "/revoke", { jti: f.jti }));
    break;
  }
  case "service": {
    if (sub === "add") {
      if (!f.name || !f.ceiling || !f["max-ttl"]) {
        console.error("service add requires --name, --ceiling, --max-ttl");
        process.exit(2);
      }
      const r = await call("POST", "/services", {
        name: f.name,
        ceiling_paths: f.ceiling.split(","),
        tiers: f.tiers ? f.tiers.split(",") : ["allow"],
        max_ttl_seconds: parseInt(f["max-ttl"], 10),
      });
      console.log(`service: ${r.service}`);
      console.log(`credential (shown once, store it now): ${r.credential}`);
      console.log(`ceiling: ${r.ceiling_paths.join(",")}  tiers: ${r.tiers.join(",")}  max ttl: ${r.max_ttl_seconds}s`);
    } else if (sub === "list") {
      const r = await call("GET", "/services");
      for (const s of r.services) {
        console.log(`${s.name}\tceiling=${s.ceiling_paths.join(",")}\ttiers=${s.tiers.join(",")}\tmax_ttl=${s.max_ttl_seconds}s${s.revoked ? "\tREVOKED" : ""}`);
      }
      if (r.services.length === 0) console.log("(no services)");
    } else if (sub === "revoke") {
      if (!f.name) { console.error("--name is required"); process.exit(2); }
      print(await call("POST", "/services/revoke", { name: f.name }));
    } else {
      console.error("usage: service add|list|revoke");
      process.exit(2);
    }
    break;
  }
  case "mint-requests": {
    const q = f.status ? `?status=${encodeURIComponent(f.status)}` : "";
    const r = await call("GET", `/mint-requests${q}`);
    for (const req of r.requests) {
      console.log(`${req.id}\t${req.status}\t${req.service}\t${req.tool}:${req.paths.join(",")}\t${req.tier}\tttl=${req.ttl_seconds}s\t${req.created_at}`);
    }
    if (r.requests.length === 0) console.log("(no mint requests)");
    break;
  }
  case "approve-request":
  case "deny-request": {
    if (!f.id) { console.error("--id is required"); process.exit(2); }
    print(await call("POST", "/mint-requests/decide", { id: f.id, approve: cmd === "approve-request" }));
    break;
  }
  case "proposals": {
    const q = f.status ? `?status=${encodeURIComponent(f.status)}` : "";
    const r = await call("GET", `/proposals${q}`);
    for (const p of r.proposals) {
      console.log(`${p.id}\t${p.status}\t${p.path}\tbase=v${p.base_version}\t${p.created_at}`);
    }
    if (r.proposals.length === 0) console.log("(no proposals)");
    break;
  }
  case "accept": {
    if (!f.id) { console.error("--id is required"); process.exit(2); }
    print(await call("POST", "/proposals/accept", { id: f.id }));
    break;
  }
  case "verify-receipts": {
    const r = await call("GET", "/receipts/verify");
    console.log(r.ok ? `receipt chain OK (${r.entries} entries)` : `RECEIPT CHAIN BROKEN: ${r.error ?? "unknown"}`);
    if (!r.ok) process.exit(1);
    break;
  }
  case "seed": {
    // Client-side loop over POST /v1/admin/seed-page, as scoped:
    // seed content is runtime-agnostic (the same tree the Go
    // `mintwiki seed` consumes); seeding is idempotent.
    const dir = sub
      ? sub
      : fileURLToPath(new URL("../../deploy/seed", import.meta.url));
    async function walk(d) {
      const out = [];
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(p)));
        else if (entry.name.endsWith(".md")) out.push(p);
      }
      return out;
    }
    let applied = 0;
    let skipped = 0;
    for (const file of (await walk(dir)).sort()) {
      const pagePath = relative(dir, file).replace(/\\/g, "/").replace(/\.md$/, "");
      const content = await readFile(file, "utf8");
      const r = await call("POST", "/seed-page", { path: pagePath, content });
      if (r.outcome === "applied") applied++;
      else skipped++;
      console.log(`${r.outcome}: ${pagePath}`);
    }
    console.log(`seed complete: ${applied} applied, ${skipped} skipped`);
    break;
  }
  default:
    console.error("usage: admin.mjs mint|revoke|service|mint-requests|approve-request|deny-request|proposals|accept|verify-receipts|seed");
    process.exit(2);
}
