# Sandbox

Back to [home](home).

This page exists so the read tools have something to demonstrate on a fresh instance:

- `backlinks` for [home](home) — this page links to it, and so do the other seeded pages.
- `search` for "receipt" — it should find [how it works](how-it-works) and [home](home).
- `recent_changes` — the seeded pages are the first entries in this wiki's history, each one receipted as an `applied` write by the seed bootstrap.

## About this demo instance

This is a public, read-mostly demo. Reading is open: browse the pages, or call the tools at `/mcp` from your own MCP client — no token needed. Writing is not open: edits require a scoped token minted by the owner, and `propose_edit` without one is rejected and receipted. That rejection *is* the demo — the token lane is the product.

If you run your own MintWiki, seeding a public sandbox credential scoped to a `/sandbox/**` ceiling is a one-command follow-up (`mintwiki service add`) — it is deliberately not enabled here by default.
