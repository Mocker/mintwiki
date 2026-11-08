// The Worker front door. Read traffic is served straight from the R2
// site objects the wiki Durable Object renders on every head move —
// viewing MintWiki is reading static files, as in the Go runtime —
// and everything else routes to the single wiki Durable Object.
//
// Milestone 3.1 surface: page/index/webmcp.js reads, the gated seed
// import, and receipts verification. /edit, /v1/tokens and /mcp
// answer 501 until M3.2/M3.3 land them.

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

    if (path === "edit" || path === "mcp" || path.startsWith("v1/")) {
      return new Response(
        JSON.stringify({ error: "not implemented in milestone 3.1 (Cloudflare runtime scaffold)" }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("404 page not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
