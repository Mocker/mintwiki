// WikiDO: the wiki itself as a single Durable Object. One instance
// (idFromName("wiki")) holds the whole wiki's manifest in its SQLite
// storage; revision objects, page mirrors and the rendered site live
// in R2. Every mutation — and every read that must be
// revision-consistent — routes through this object, so execution is
// serialized exactly the way the Go store's single-connection SQLite
// serializes its writers.
//
// Milestone 3.1 surface: schema init, seed import, site rebuild, and
// on-demand page render for cache misses. M3.2 adds the write lane
// (/edit, the /v1/tokens exchange + pickup), M3.3 the agent surfaces
// (/mcp + tools), M3.4 the admin surface (/v1/admin/*) — which
// retired the ALLOW_SEED bootstrap routes entirely.

import { DurableObject } from "cloudflare:workers";
import { ReceiptLog } from "./receipts";
import { normalizePath, NotFoundError, WikiStore } from "./store";
import { renderIndex, renderPage, webmcpJS } from "./render";
import { Lane } from "./lane";
import { scopeString } from "./token";
import { Executor } from "./tools";
import { handleMCP } from "./mcp";
import { handleAdmin } from "./admin";

export interface Env {
  WIKI: DurableObjectNamespace;
  BLOB: R2Bucket;
  SIGNING_SECRET?: string;
  OWNER_ADMIN_TOKEN?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class WikiDO extends DurableObject<Env> {
  private store: WikiStore;
  private receipts: ReceiptLog;
  private lane: Lane;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new WikiStore(ctx.storage.sql, env.BLOB);
    this.receipts = new ReceiptLog(ctx.storage.sql);
    this.lane = new Lane(this.store, this.receipts, env.SIGNING_SECRET, async () => {
      await this.rebuildSite();
    });
    ctx.blockConcurrencyWhile(async () => {
      this.store.initSchema();
    });
  }

  // rebuildSite re-renders every artifact the Worker serves from R2:
  // one HTML file per page (with the head revision in the object's
  // custom metadata, which the Worker echoes as X-MintWiki-Revision),
  // the index, and webmcp.js. The Go runtime rebuilds its site
  // directory on every head move; this is the same rule.
  async rebuildSite(): Promise<number> {
    const paths = this.store.listPages();
    for (const path of paths) {
      const page = await this.store.getPage(path);
      await this.env.BLOB.put(`site/${path}.html`, renderPage(path, page.content, page.revID, page.version), {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: { headRev: page.revID, headVersion: String(page.version) },
      });
    }
    await this.env.BLOB.put("site/index.html", renderIndex(paths), {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    await this.env.BLOB.put("site/webmcp.js", webmcpJS(), {
      httpMetadata: { contentType: "application/javascript; charset=utf-8" },
    });
    return paths.length;
  }

  // applySeedPage is cmdSeed's per-file step (Go): a page that
  // already exists is skipped (seed is idempotent); a new page is
  // applied at base version 0 with author "seed" and receipted,
  // exactly like the Go seed command. Reached through the admin
  // surface (M3.4).
  private async applySeedPage(
    pathRaw: string,
    content: string,
  ): Promise<{ outcome: "applied" | "skipped"; revID?: string; version?: number }> {
    const path = normalizePath(pathRaw);
    if (await this.store.pageExists(path)) return { outcome: "skipped" };
    const { revID, newVersion } = await this.store.putPage(
      path,
      new TextEncoder().encode(content),
      0,
      "seed",
      "",
    );
    await this.receipts.append({
      actor: "seed",
      token_jti: "",
      scope: "",
      page: path,
      result: "applied",
      rev_id: revID,
      before_version: 0,
      after_version: newVersion,
    });
    await this.rebuildSite();
    return { outcome: "applied", revID, version: newVersion };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      // --- The write lane (M3.2): forwarded by the Worker as-is. ---
      if (req.method === "POST" && url.pathname === "/edit") {
        const r = await this.lane.handleEdit(req.headers.get("authorization"), await req.text());
        return json(r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === "/v1/tokens") {
        const r = await this.lane.handleMint(req.headers.get("authorization"), await req.text());
        return json(r.status, r.body);
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/tokens/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/tokens/".length));
        const r = await this.lane.handleMintPoll(req.headers.get("authorization"), id);
        return json(r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === "/mcp") {
        // The agent surface (M3.3): reads are token-free; propose_edit
        // runs the shared lane (the M3.2 injection, mirroring the Go
        // server's mcpPropose — auth failures are receipted as
        // rejections, like /edit rejections).
        const executor = new Executor(this.store, async (preq, auth) => {
          const { claims, reason } = await this.lane.verifyForPropose(auth || null, preq.path);
          if (reason !== "" || !claims) {
            const cur = this.store.headVersion(preq.path);
            await this.receipts.append({
              actor: claims?.actor ?? "",
              token_jti: claims?.jti ?? "",
              scope: claims ? scopeString(claims) : "",
              page: preq.path,
              result: "rejected",
              reason,
              before_version: cur,
              after_version: cur,
            });
            throw new Error(reason);
          }
          const p = await this.lane.proposeWithClaims(claims, preq.path, preq.content, preq.expectedVersion);
          if (p.reason !== "") throw new Error(p.reason);
          return p.proposalID;
        });
        const out = await handleMCP(executor, await req.text(), req.headers.get("authorization"));
        if (out.body === null) return new Response(null, { status: out.status });
        return new Response(out.body, {
          status: out.status,
          headers: { "content-type": "application/json" },
        });
      }
      // --- Admin surface (M3.4): the owner operations, gated by the
      // OWNER_ADMIN_TOKEN secret inside handleAdmin. This replaces
      // the M3.1–M3.3 ALLOW_SEED bootstrap routes, which are gone. ---
      if (url.pathname === "/v1/admin" || url.pathname.startsWith("/v1/admin/")) {
        const r = await handleAdmin(
          {
            store: this.store,
            receipts: this.receipts,
            lane: this.lane,
            signingSecretHex: this.env.SIGNING_SECRET,
            adminToken: this.env.OWNER_ADMIN_TOKEN,
            seedPage: (p, c) => this.applySeedPage(p, c),
          },
          req.method,
          url.pathname.slice("/v1/admin".length) || "/",
          url.searchParams,
          req.headers.get("authorization"),
          req.method === "POST" ? await req.text() : "",
        );
        return json(r.status, r.body);
      }
      // --- Worker↔DO plumbing below: reachable only through the
      // Worker's own stub fetches, never forwarded from outside. ---
      if (req.method === "POST" && url.pathname === "/internal/rebuild") {
        const pages = await this.rebuildSite();
        return json(200, { pages });
      }
      if (req.method === "GET" && url.pathname === "/internal/page") {
        // Worker fallback for an R2 site miss: render on demand from
        // the store (and the next rebuild refreshes the R2 copy).
        const path = normalizePath(url.searchParams.get("path") ?? "");
        const page = await this.store.getPage(path);
        return new Response(renderPage(path, page.content, page.revID, page.version), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-mintwiki-revision": page.revID,
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/internal/index") {
        return new Response(renderIndex(this.store.listPages()), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return json(404, { error: "not found" });
    } catch (e) {
      if (e instanceof NotFoundError) return json(404, { error: "not found" });
      return json(500, { error: (e as Error).message });
    }
  }
}
