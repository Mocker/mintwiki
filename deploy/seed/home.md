# MintWiki — live demo

This is a running instance of **MintWiki**: a wiki where humans and agents edit under narrow scoped, short-lived tokens instead of standing accounts, pages are immutable content-addressed revisions with CAS head pointers, and agents read through structured tools (WebMCP + MCP) instead of scraping HTML.

Everything you see here is the real software — a single Go binary, SQLite, and one data directory. Source: [github.com/Mocker/mintwiki](https://github.com/Mocker/mintwiki) (Apache-2.0).

## Start here

- [How it works](how-it-works) — tokens, tiers, CAS writes, and the hash-chained receipt log.
- [Agent reads](agent-reads) — the six tools, and how to point your own MCP client at this wiki.
- [Sandbox welcome](sandbox/welcome) — about this demo instance.

## The one-sentence version

An agent should hold exactly the permission for *this* edit, on *these* pages, for *minutes* — with a receipt. Current wiki software (MediaWiki, Wiki.js, BookStack) trusts accounts forever; MintWiki trusts a token for one job.
