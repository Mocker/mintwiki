# MintWiki

A wiki where humans and agents edit under narrow scoped, short-lived tokens — immutable revisions, CAS head pointers, structured agent reads (WebMCP + MCP).

Current wiki software (MediaWiki, Wiki.js, BookStack) trusts standing accounts: an account can edit a page, forever, until someone revokes the account. Agent editors break that model. An agent should hold exactly the permission for *this* edit, on *these* pages, for *minutes* — with a receipt. MintWiki fixes both sides of that: scoped tokens for writes, and structured tool surfaces for reads (WebMCP + HTTP MCP), so agents call tools instead of scraping HTML.

**Status:** Milestone 2 — storage core + scoped-token write lane + agent read surfaces. Portable by design: a single Go binary, SQLite, one data directory, no cloud-vendor dependencies. Apache-2.0.

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

The minting question — *what authenticates the minter?* The root stays local: the signing key is a `0600` file in the data directory, and the owner's CLI mints with it directly (the SSH-key trust model). But editors never touch that path day-to-day — it would put a human in the loop for every edit. Instead, day-to-day issuance is a **token exchange**:

## Service credentials & the token exchange

Each agent runtime / service gets a long-lived **service credential** with a **scope ceiling** set by the owner:

```
mintwiki service add --name anna --ceiling /projects/**,/notes/** --tiers allow --max-ttl 30m
```

The credential is shown exactly once; only its SHA-256 hash is stored. The service keeps it in its own secret store and exchanges it at the mint endpoint for short-lived edit tokens:

```
POST /v1/tokens   Authorization: Bearer <service credential>
{"paths": ["/projects/**"], "tier": "allow", "ttl_seconds": 600}
→ {"token": "<short-lived JWT>", "jti": "...", "expires_at": "..."}
```

The gates, checked in order: credential known → service not revoked → requested paths **within the service's ceiling** (a subset check — a service can narrow its scope, never widen it) → tier allowed for this service → TTL within both the service cap and wiki policy. Requests inside the ceiling are issued automatically, no human involved; anything outside is denied and receipted. This is the standard exchange pattern (OAuth 2.0 token exchange, AWS STS): the sensitive credential never authorizes an edit itself — it only authenticates its holder to the minter, and the tokens it buys are scoped, short-lived, and revocable per-jti. Revoking the service credential (`service revoke`) cuts off all future exchanges; already-issued tokens still die at their short expiry or by jti.

Requests *above* a ceiling are not flatly denied — they **escalate to the owner's approval queue**. The exchange answers `202` with a request ID; the service polls `GET /v1/tokens/<request-id>` with its credential. The owner reviews with `mintwiki mint-requests` and decides with `approve-request` / `deny-request`. On approval, the token is minted *at pickup* (TTL counts from pickup, nothing sensitive is stored against the request) and delivered exactly once. A request is worthless until approved, so submitting one needs no trust — and the human gate appears exactly where the envelope ends, which is where it belongs. Pending requests expire after 24 hours; re-submitting an identical pending request returns the original instead of spamming the queue.

Backup is copying the data directory. Moving the wiki is copying the data directory.

## Agent reads: one tool set, two surfaces

Six tools are defined **once** in `internal/tools` — name, description, JSON Schema — and both agent surfaces are generated from that single definition set, so they can never drift:

| Tool | What it does |
|---|---|
| `get_page` | Page content + the exact revision ID and version it was read at |
| `get_section` | One Markdown section of a page, by heading |
| `search` | Case-insensitive substring search across pages, with snippets |
| `backlinks` | Pages that link to a page (Markdown links and `[[wiki links]]`) |
| `recent_changes` | Newest revisions across the wiki, newest first |
| `propose_edit` | Propose an edit — the one write-shaped tool; see below |

**HTTP MCP server** (`POST /mcp`, JSON-RPC 2.0, stateless) for non-browser agents — CLI agents, runtimes like Anna, anything that speaks MCP:

```
curl -X POST localhost:8090/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"get_page","arguments":{"path":"projects/demo"}}}'
```

Both the `initialize` handshake and the stateless `server/discover` method are answered, so clients across the MCP spec transition can connect. `mintwiki tools` prints the shared definitions as JSON.

**WebMCP registration** for browser agents: the static build generates `webmcp.js` from the same definitions, and every built page loads it. When a WebMCP host is present (`navigator.modelContext`), the page registers all six tools; their `execute` calls the wiki's own `/mcp` endpoint, so there is exactly one server-side execution path. With no WebMCP host — an ordinary browser — the script does nothing.

Reads are token-free (public-wiki semantics). `propose_edit` is not a back door around the token lane: it requires the same bearer edit token as `POST /edit`, sent as the `/mcp` request's `Authorization` header (WebMCP calls forward one from `localStorage["mintwiki_token"]` when present), runs the identical verification order and CAS check, is receipted like any other write attempt — and always lands as a *proposal*. The head moves only when the owner accepts it, exactly like an `approve`-tier edit.

## Acceptance demo

`scripts/demo.sh` runs the acceptance test end-to-end (fresh binary, empty data dir): first edit, stale-writer conflict, out-of-scope rejection, approve-tier propose/accept, revoked token, expired token, the service token exchange and its approval queue, the MCP tools (list, initialize, get_page/get_section/search/backlinks/recent_changes, propose_edit with and without a token), the WebMCP registration file, receipt-chain verification, and a restart from a copied data directory.

```
bash scripts/demo.sh
```

## Layout

```
cmd/mintwiki/     CLI: init | serve | build | mint | revoke | service | mint-requests | approve-request | deny-request | proposals | accept | verify-receipts | tools
internal/store/   content-addressed .md revisions + SQLite manifest & CAS heads + pages/ mirror + service registry
internal/token/   mint / verify / scope matching (single-purpose HMAC secret)
internal/policy/  local policy file (TTL caps), checked at request time
internal/receipts/ append-only hash-chained audit log
internal/tools/   the shared tool definitions + read implementations (single source for both agent surfaces)
internal/site/    static HTML builder (index + one .html per page + generated webmcp.js)
internal/web/     static site serving + POST /edit + POST /v1/tokens (the exchange) + POST /mcp (HTTP MCP server)
```

## Roadmap

- **M2 (done):** agent read surfaces — WebMCP tool registration in the web app and an HTTP MCP server, both generated from one tool definition set (`get_page`, `get_section`, `search`, `backlinks`, `recent_changes`, `propose_edit`).
- Next: public demo deployment.
- Later: human edit UI with a propose-and-accept queue, private-wiki read tokens, optional maintenance ("dreaming") modules, S3-compatible revision backend.

## License

Apache-2.0 — see [LICENSE](LICENSE).
