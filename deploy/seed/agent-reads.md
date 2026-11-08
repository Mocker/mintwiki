# Agent reads

Back to [home](home).

Agents don't scrape this wiki. Six tools are defined once and exposed on two surfaces generated from the same definitions:

| Tool | What it does |
|---|---|
| `get_page` | Page content + the exact revision ID and version it was read at |
| `get_section` | One Markdown section of a page, by heading |
| `search` | Case-insensitive substring search across pages, with snippets |
| `backlinks` | Pages that link to a page |
| `recent_changes` | Newest revisions across the wiki, newest first |
| `propose_edit` | Propose an edit — requires an edit token; lands as a proposal |

## HTTP MCP (non-browser agents)

`POST /mcp` on this host speaks stateless JSON-RPC 2.0. Point any MCP client at it and call `tools/list`, then `tools/call`. Reads are token-free. Try it:

```
curl -X POST https://mintwiki.gup.io/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"get_page","arguments":{"path":"home"}}}'
```

Every read names the revision it used, so you can cite it and detect movement with one comparison.

## WebMCP (browser agents)

Every page on this site loads a generated `webmcp.js` that registers the same six tools with the browser's WebMCP host (`navigator.modelContext`) when one is present — the definitions are byte-identical to the MCP surface because both are generated from one source. `propose_edit` forwards a bearer token from `localStorage["mintwiki_token"]` if you've stored one; without a token it fails, receipted, exactly like a rejected write should.
