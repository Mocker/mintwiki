# MintWiki — Cloudflare runtime

The Cloudflare deployment of MintWiki: a **Worker** front door, one
**Durable Object** (SQLite storage) holding the wiki's manifest, and
**R2** for revision objects, page mirrors, and the rendered site.

The Go binary at the repo root is the **reference implementation**.
This package implements the same contract — same routes, token lane,
receipt chain, and tool definitions (the canonical
[`tools.definitions.json`](../tools.definitions.json), generated from
the Go definitions and drift-checked in CI). The black-box
[`conformance/`](../conformance) suite must pass against both
runtimes; where rendered HTML details differ (goldmark vs marked),
conformance compares content and revision footers, never bytes. The
design is specified in the Milestone 3 scope (in the project record)
and the mapping is:

| Go runtime              | Cloudflare runtime                        |
| ----------------------- | ----------------------------------------- |
| SQLite file             | Durable Object SQLite (`ctx.storage.sql`) |
| `revisions/ab/<id>.md`  | R2, same key layout                       |
| `data/pages/<path>.md`  | R2 `pages/<path>.md`                      |
| `data/site/`            | R2 `site/`, served by the Worker          |
| receipts log file       | `receipts` table in the Durable Object    |
| signing key file        | `SIGNING_SECRET` Worker secret            |
| owner CLI               | admin API (`OWNER_ADMIN_TOKEN`), M3.4     |

## Status

Milestone 3.1 (scaffold): schema, seed import, site rendering,
page serving, receipt chain. `/edit` and `/v1/tokens` land in M3.2,
`/mcp` + WebMCP execution in M3.3, the admin API in M3.4, the public
deploy in M3.5. Until their milestones land, write surfaces answer
`501`.

## Develop

```sh
npm install
npm run dev          # wrangler dev on http://localhost:8787
npm run seed         # import ../../deploy/seed into the dev instance
npm test             # vitest against the Workers pool (miniflare)
npm run typecheck
```

Seeding needs `ALLOW_SEED=true` (set in `wrangler.jsonc` for the
demo). It gates the unauthenticated bootstrap endpoints
(`/internal/seed-page`, `/internal/rebuild`,
`/internal/receipts-verify`) and **must be turned off** on any wiki
whose contents matter; M3.4 replaces the switch with the admin-token
surface.

## Deploy (M3.5, Ryan's steps included)

```sh
npx wrangler r2 bucket create mintwiki-blobs
npx wrangler secret put SIGNING_SECRET       # Ryan only — never in code
npx wrangler secret put OWNER_ADMIN_TOKEN    # Ryan only
npx wrangler deploy
```

The `mintwiki.gup.io` custom domain is attached in the Cloudflare
dashboard.
