# How it works

Back to [home](home).

## No accounts

There are no usernames, passwords, or sessions. The wiki owner holds one capability — a signing key file in the data directory — and everything else is a **scoped, short-lived token**: an HMAC-signed JWT carrying an enumerated scope (the `edit_page` tool + path patterns like `/projects/**`), a tier, a unique `jti`, and an expiry (30 minutes by default, policy-capped).

## Tiers

- `allow` — the edit moves the page head immediately.
- `approve` — the edit lands as a *proposal*; the head moves only when the owner accepts it.

## Service credentials & the exchange

Day-to-day, services (an agent runtime, a CI job) hold one long-lived **service credential** with an owner-set **scope ceiling**. They exchange it at `POST /v1/tokens` for short-lived edit tokens: inside the ceiling, issuance is automatic; above it, the request escalates to the owner's approval queue instead of failing. The credential itself never authorizes an edit — it only authenticates its holder to the minter.

## Storage: immutable revisions, one moving pointer

Every revision is a plain Markdown file named by its SHA-256 hash. The only mutable state is one head pointer per page in SQLite, moved by compare-and-swap: a writer names the head version its edit is based on, and a stale writer gets a conflict, never a silent overwrite. Revert = move the head back. History is never rewritten.

## Receipts

Every write attempt — applied, proposed, or *rejected* — appends an entry to a hash-chained audit log: actor, token scope, page, revision, before/after versions. Tampering with history breaks the chain, and `mintwiki verify-receipts` proves it.
