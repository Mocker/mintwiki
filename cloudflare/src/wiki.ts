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
// (/edit, the /v1/tokens exchange + pickup) plus the gated bootstrap
// stand-ins for the Go CLI's owner operations. The agent surfaces
// land in M3.3, the admin API in M3.4.

import { DurableObject } from "cloudflare:workers";
import { ReceiptLog } from "./receipts";
import { normalizePath, NotFoundError, WikiStore } from "./store";
import { renderIndex, renderPage, webmcpJS } from "./render";
import { Lane } from "./lane";
import { hashCredential } from "./token";

export interface Env {
  WIKI: DurableObjectNamespace;
  BLOB: R2Bucket;
  ALLOW_SEED?: string;
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

  // seedPage is cmdSeed's per-file step (Go): a page that already
  // exists is skipped (seed is idempotent); a new page is applied at
  // base version 0 with author "seed" and receipted, exactly like the
  // Go seed command.
  private async seedPage(pathRaw: string, content: string): Promise<Response> {
    let path: string;
    try {
      path = normalizePath(pathRaw);
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
    if (await this.store.pageExists(path)) return json(200, { status: "skipped", path });
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
    return json(200, { status: "applied", path, rev_id: revID, version: newVersion });
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
      // --- Bootstrap surface (ALLOW_SEED-gated at the Worker). These
      // are the pre-admin stand-ins for the Go CLI's direct-store
      // owner operations — service add, revoke, accept, decide — and
      // M3.4's admin API replaces them. ---
      if (req.method === "POST" && url.pathname === "/internal/register-service") {
        const body = (await req.json()) as {
          name?: string;
          credential?: string;
          ceiling_paths?: string[];
          tiers?: string[];
          max_ttl_seconds?: number;
        };
        if (!body.name || !body.credential) return json(400, { error: "name and credential are required" });
        this.store.registerService(
          body.name,
          await hashCredential(body.credential),
          body.ceiling_paths ?? [],
          body.tiers ?? ["allow"],
          body.max_ttl_seconds ?? 1800,
        );
        return json(200, { status: "registered", service: body.name });
      }
      if (req.method === "POST" && url.pathname === "/internal/revoke-token") {
        const body = (await req.json()) as { jti?: string };
        if (!body.jti) return json(400, { error: "jti is required" });
        this.store.revokeToken(body.jti);
        return json(200, { status: "revoked", jti: body.jti });
      }
      if (req.method === "POST" && url.pathname === "/internal/accept-proposal") {
        const body = (await req.json()) as { id?: string };
        if (!body.id) return json(400, { error: "id is required" });
        const r = await this.lane.acceptProposal(body.id);
        return json(r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === "/internal/decide-mint-request") {
        const body = (await req.json()) as { id?: string; approve?: boolean };
        if (!body.id) return json(400, { error: "id is required" });
        const r = await this.lane.decideMintRequest(body.id, body.approve === true);
        return json(r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === "/internal/seed-page") {
        const body = (await req.json()) as { path?: string; content?: string };
        if (!body.path || typeof body.content !== "string") {
          return json(400, { error: "path and content are required" });
        }
        return await this.seedPage(body.path, body.content);
      }
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
      if (req.method === "GET" && url.pathname === "/internal/receipts-verify") {
        const entries = await this.receipts.verify();
        return json(200, { entries, ok: true });
      }
      return json(404, { error: "not found" });
    } catch (e) {
      if (e instanceof NotFoundError) return json(404, { error: "not found" });
      return json(500, { error: (e as Error).message });
    }
  }
}
