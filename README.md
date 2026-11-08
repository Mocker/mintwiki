# MintWiki

A wiki where humans and agents edit under narrow scoped, short-lived tokens — immutable revisions, CAS head pointers, structured agent reads (WebMCP + MCP).

Current wiki software (MediaWiki, Wiki.js, BookStack) trusts standing accounts: an account can edit a page, forever, until someone revokes the account. Agent editors break that model. An agent should hold exactly the permission for *this* edit, on *these* pages, for *minutes* — with a receipt. MintWiki fixes both sides of that: scoped tokens for writes, and structured tool surfaces for reads (WebMCP + HTTP MCP, landing in a later milestone).

**Status:** Milestone 1 — storage core + scoped-token write lane. Portable by design: a single Go binary, SQLite, one data directory, no cloud-vendor dependencies. Apache-2.0.

## How editing works (no accounts)

There are no user accounts and no passwords. The owner holds one capability — a signing key file in the data directory — and mints edit tokens with it:

```
mintwiki mint --actor agent-1 --paths /projects/** --tier allow --ttl 30m
```

A token is an HMAC-signed JWT carrying:

- an enumerated scope: the `edit_page` tool + path prefixes (`/projects/**`)
- a tier: `allow` (the edit moves the page head) or `approve` (the edit lands as a proposed diff the owner accepts)
- a `jti`, registered at mint time, so the owner can revoke that exact token instantly
- a short expiry (30 minutes by default; the wiki's policy file caps it)

Every write is checked at request time, in order: signature → expiry → token was minted here → not revoked → scope covers this page → tier → compare-and-swap on the page head. Every attempt — applied, proposed, or rejected — appends a hash-chained audit receipt.

Pages are Markdown files, all the way down. Every revision is an immutable `.md` file named by its content hash; each page's current head also lives as a plain `.md` file at `data/pages/<path>.md`, readable (and inspectable) with any tool. The only mutable state is one head pointer per page in SQLite, moved by CAS inside a transaction. A stale writer gets a conflict and the current head version, never a silent overwrite. Revert = move the head back; history is never rewritten.

Viewing is static: the wiki builds to plain HTML (`data/site/`, one `.html` per page plus an index) and the server serves those files — the build is regenerated whenever a head moves, and any static file server can serve the output just as well. Every built page names the exact revision it shows.

## Quickstart

```
go build -o mintwiki ./cmd/mintwiki
./mintwiki init  --data data
./mintwiki serve --data data --addr :8090 &

# mint a token, then edit with it
./mintwiki mint --data data --actor agent-1 --paths /projects/** --tier allow
curl -X POST localhost:8090/edit \
  -H "Authorization: Bearer <token>" \
  -d '{"path":"projects/demo","content":"# Hello","expected_version":0}'

curl localhost:8090/projects/demo        # serves the built page + its revision ID
./mintwiki build --data data             # rebuild the static site by hand
./mintwiki verify-receipts --data data   # check the audit chain
```

The minting question — *what authenticates the minter?* Minting is deliberately **not** a network service: it is a local CLI operation, and its authentication is the operating system — whoever can read the `0600` signing-key file in the data directory can mint, exactly the trust model of an SSH private key. There is no remote mint endpoint to attack. A future module may let agents *request* tokens remotely, but a request would only land in the owner's approval queue; issuance stays local and owner-approved.

Backup is copying the data directory. Moving the wiki is copying the data directory.

## Acceptance demo

`scripts/demo.sh` runs the Milestone 1 acceptance test end-to-end (fresh binary, empty data dir): first edit, stale-writer conflict, out-of-scope rejection, approve-tier propose/accept, revoked token, expired token, receipt-chain verification, and a restart from a copied data directory.

```
bash scripts/demo.sh
```

## Layout

```
cmd/mintwiki/     CLI: init | serve | build | mint | revoke | proposals | accept | verify-receipts
internal/store/   content-addressed .md revisions + SQLite manifest & CAS heads + pages/ mirror
internal/token/   mint / verify / scope matching (single-purpose HMAC secret)
internal/policy/  local policy file (TTL caps), checked at request time
internal/receipts/ append-only hash-chained audit log
internal/site/    static HTML builder (index + one .html per page)
internal/web/     static site serving + POST /edit
```

## Roadmap

- **M2:** agent read surfaces — WebMCP tool registration in the web app and an HTTP MCP server, both generated from one tool definition set (`get_page`, `get_section`, `search`, `backlinks`, `recent_changes`, `propose_edit`).
- Later: human edit UI with a propose-and-accept queue, private-wiki read tokens, optional maintenance ("dreaming") modules, S3-compatible revision backend.

## License

Apache-2.0 — see [LICENSE](LICENSE).
