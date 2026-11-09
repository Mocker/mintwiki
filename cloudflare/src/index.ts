// The Worker front door. Read traffic is served straight from the R2
// site objects the wiki Durable Object renders on every head move —
// viewing MintWiki is reading static files, as in the Go runtime —
// and everything else routes to the single wiki Durable Object.
//
// Milestone 3.1 surface: page/index/webmcp.js reads, the gated seed
// import, and receipts verification. M3.2 adds the write lane
// (/edit, /v1/tokens), M3.3 the agent surface (/mcp) — both forwarded
// to the wiki object below.

import { WikiDO, type Env } from "./wiki";

export { WikiDO };

function wikiStub(env: Env): DurableObjectStub {
  return env.WIKI.get(env.WIKI.idFromName("wiki"));
}

async function serveSiteObject(env: Env, key: string): Promise<Response | null> {
  const obj = await env.BLOB.get(key);
  if (!obj) return null;
  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType ?? "application/octet-stream");
  if (obj.customMetadata?.headRev) headers.set("x-mintwiki-revision", obj.customMetadata.headRev);
  return new Response(obj.body, { headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\//, "");

    // Bootstrap operations (seed import, site rebuild, receipt
    // verification). ALLOW_SEED gates them until M3.4 replaces this
    // switch with the admin-token surface; the var's own comment in
    // wrangler.jsonc says when it must be off.
    if (path.startsWith("internal/")) {
      if (env.ALLOW_SEED !== "true") return new Response("not found", { status: 404 });
      return wikiStub(env).fetch(new Request(`https://do/${path}`, req));
    }

    // The write lane (M3.2) runs inside the wiki Durable Object. This
    // forward must precede the page-serving block below: GET
    // /v1/tokens/{id} is the pickup endpoint, not a page view.
    if (path === "edit" || path === "v1/tokens" || path.startsWith("v1/tokens/")) {
      return wikiStub(env).fetch(req);
    }

    // The agent surface (M3.3) also runs inside the wiki object;
    // GET /mcp is refused exactly as the Go server refuses it. This
    // branch must also precede page serving ("mcp" is a valid page
    // path shape, but it is not a page).
    if (path === "mcp") {
      if (req.method === "POST") return wikiStub(env).fetch(req);
      return new Response("MCP endpoint accepts POST only", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    if (req.method === "GET") {
      if (path === "" || path === "index.html") {
        const hit = await serveSiteObject(env, "site/index.html");
        if (hit) return hit;
        return wikiStub(env).fetch("https://do/internal/index");
      }
      if (path === "webmcp.js") {
        const hit = await serveSiteObject(env, "site/webmcp.js");
        if (hit) return hit;
        await wikiStub(env).fetch(new Request("https://do/internal/rebuild", { method: "POST" }));
        return (await serveSiteObject(env, "site/webmcp.js")) ?? new Response("not found", { status: 404 });
      }
      // A page view: site/<path>.html, rendered on the last head move.
      // Extension-bearing paths are not pages.
      if (!path.includes(".")) {
        const hit = await serveSiteObject(env, `site/${path}.html`);
        if (hit) return hit;
        const res = await wikiStub(env).fetch(
          `https://do/internal/page?path=${encodeURIComponent(path)}`,
        );
        if (res.status === 200) return res;
        return new Response("404 page not found\n", { status: 404 });
      }
      return new Response("404 page not found\n", { status: 404 });
    }

    return new Response("404 page not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
