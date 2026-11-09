// The admin surface (M3.4): the owner operations the Go runtime
// performs through its CLI, as HTTP endpoints under /v1/admin/*,
// gated by the OWNER_ADMIN_TOKEN Worker secret — a credential
// distinct from the wiki's signing secret and from every service
// credential. This surface replaces the M3.1–M3.3 bootstrap routes
// (/internal/seed-page and friends, gated by the ALLOW_SEED var);
// those are gone, not deprecated.
//
// Receipt behavior matches the Go CLI: decisions and accepts are
// receipted (through the lane, as before); direct mints and service
// registration are not separate receipt events (a mint's use is
// receipted at edit time, as with the Go CLI).

import { Lane, LaneResult } from "./lane";
import { ReceiptLog } from "./receipts";
import { WikiStore } from "./store";
import {
  keyBytesFromHex,
  mint,
  newServiceCredential,
  hashCredential,
  scopeString,
} from "./token";

export interface AdminContext {
  store: WikiStore;
  receipts: ReceiptLog;
  lane: Lane;
  signingSecretHex: string | undefined;
  adminToken: string | undefined;
  // seedPage applies one seed page (skip-if-exists, receipted) and
  // reports the outcome; provided by the Durable Object, which owns
  // the site-rebuild trigger.
  seedPage: (
    path: string,
    content: string,
  ) => Promise<{ outcome: "applied" | "skipped"; revID?: string; version?: number }>;
}

function err(status: number, message: string): LaneResult {
  return { status, body: { error: message } };
}

function parseBody(bodyText: string): { body: Record<string, unknown> } | { error: LaneResult } {
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof body !== "object" || body === null) throw new Error("not an object");
    return { body };
  } catch {
    return { error: err(400, "bad JSON body") };
  }
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// adminAuthorized compares bearer <redacted>s by digest so the comparison
// itself does not leak the secret through timing.
async function adminAuthorized(auth: string | null, expected: string): Promise<boolean> {
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(auth.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

export async function handleAdmin(
  ctx: AdminContext,
  method: string,
  sub: string, // path after /v1/admin, e.g. "/services"
  query: URLSearchParams,
  auth: string | null,
  bodyText: string,
): Promise<LaneResult> {
  if (!ctx.adminToken) return err(503, "admin is not configured on this wiki");
  if (!(await adminAuthorized(auth, ctx.adminToken))) return err(401, "invalid admin token");

  const route = `${method} ${sub}`;
  switch (route) {
    case "POST /mint": {
      // Mirrors cmdMint (Go): actor defaults to owner, paths to /**,
      // tier to allow, ttl 0/absent to the policy default; CheckTTL
      // is a flat refusal here (the CLI fatals), not an escalation —
      // the owner is the ceiling.
      const parsed = parseBody(bodyText);
      if ("error" in parsed) return parsed.error;
      const { body } = parsed;
      if (!ctx.signingSecretHex) return err(503, "signing secret is not configured");
      const policy = ctx.store.getPolicy();
      let ttl = typeof body.ttl_seconds === "number" ? Math.trunc(body.ttl_seconds) : 0;
      if (ttl === 0) ttl = policy.defaultTTLSeconds;
      const ttlCheck = ctx.store.checkTTL(ttl);
      if (ttlCheck !== null) return err(400, ttlCheck);
      const paths = strArr(body.paths);
      const m = await mint(
        keyBytesFromHex(ctx.signingSecretHex),
        typeof body.actor === "string" && body.actor !== "" ? body.actor : "owner",
        "edit_page",
        paths.length > 0 ? paths : ["/**"],
        body.tier === "approve" ? "approve" : "allow",
        ttl,
      );
      ctx.store.registerToken(m.claims.jti, scopeString(m.claims), m.claims.tier, m.claims.exp);
      return {
        status: 200,
        body: {
          token: m.token,
          jti: m.claims.jti,
          expires_at: new Date(m.claims.exp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        },
      };
    }

    case "POST /revoke": {
      const parsed = parseBody(bodyText);
      if ("error" in parsed) return parsed.error;
      const jti = typeof parsed.body.jti === "string" ? parsed.body.jti : "";
      if (jti === "") return err(400, "jti is required");
      ctx.store.revokeToken(jti);
      return { status: 200, body: { status: "revoked", jti } };
    }

    case "POST /services": {
      // Mirrors `service add` (Go): the credential is generated
      // here and returned exactly once; only its hash is stored.
      const parsed = parseBody(bodyText);
      if ("error" in parsed) return parsed.error;
      const { body } = parsed;
      const name = typeof body.name === "string" ? body.name : "";
      if (name === "") return err(400, "name is required");
      const ceiling = strArr(body.ceiling_paths);
      if (ceiling.length === 0) return err(400, "ceiling_paths is required");
      const tiers = strArr(body.tiers);
      const maxTTL = typeof body.max_ttl_seconds === "number" ? Math.trunc(body.max_ttl_seconds) : 0;
      if (maxTTL <= 0) return err(400, "max_ttl_seconds is required");
      const credential = newServiceCredential();
      const existing = ctx.store.listServices().find((s) => s.name === name);
      if (existing) return err(409, "service already exists");
      ctx.store.registerService(name, await hashCredential(credential), ceiling, tiers.length > 0 ? tiers : ["allow"], maxTTL);
      return {
        status: 201,
        body: {
          service: name,
          credential,
          ceiling_paths: ceiling,
          tiers: tiers.length > 0 ? tiers : ["allow"],
          max_ttl_seconds: maxTTL,
        },
      };
    }

    case "GET /services": {
      const services = ctx.store.listServices().map((s) => ({
        name: s.name,
        ceiling_paths: s.ceilingPaths,
        tiers: s.tiers,
        max_ttl_seconds: s.maxTTLSeconds,
        revoked: s.revoked,
        created_at: s.createdAt,
      }));
      return { status: 200, body: { services } };
    }

    case "POST /services/revoke": {
      const parsed = parseBody(bodyText);
      if ("error" in parsed) return parsed.error;
      const name = typeof parsed.body.name === "string" ? parsed.body.name : "";
      if (name === "") return err(400, "name is required");
      if (!ctx.store.revokeService(name)) return err(404, "no such service");
      return { status: 200, body: { status: "revoked", service: name } };
    }

    case "GET /mint-requests": {
      const requests = ctx.store.listMintRequests(query.get("status") ?? "").map((r) => ({
        id: r.id,
        service: r.service,
        tool: r.tool,
        paths: r.paths,
        tier: r.tier,
        ttl_seconds: r.ttlSeconds,
        status: r.status,
        created_at: r.createdAt,
        decided_at: r.decidedAt,
      }));
      return { status: 200, body: { requests } };
    }

    case "POST /mint-requests/decide": {
      const parsed = parseBody(bodyText);
      if ("error" in parsed) return parsed.error;
      const id = typeof parsed.body.id === "string" ? parsed.body.id : "";
      if (id === "") return err(400, "id is required");
      return ctx.lane.decideMintRequest(id, parsed.body.approve === true);
    }

    case "GET /proposals": {
      const proposals = ctx.store.listProposals(query.get("status") ?? "").map((p) => ({
        id: p.id,
        path: p.pagePath,
        rev_id: p.revID,
        base_version: p.baseVersion,
        status: p.status,
        token_jti: p.tokenJTI,
        created_at: p.createdAt,
      }));
      return { status: 200, body: { proposals } };
    }

    case "POST /proposals/accept": {
      const parsed = parseBody(bodyText);
      if ("error" in parsed) return parsed.error;
      const id = typeof parsed.body.id === "string" ? parsed.body.id : "";
      if (id === "") return err(400, "id is required");
      return ctx.lane.acceptProposal(id);
    }

    case "GET /receipts/verify": {
      // ReceiptLog.verify returns the entry count and throws on a
      // broken chain (the Go CLI's verify-receipts behaves the same).
      try {
        const entries = await ctx.receipts.verify();
        return { status: 200, body: { entries, ok: true } };
      } catch (e) {
        return { status: 200, body: { ok: false, error: (e as Error).message } };
      }
    }

    case "POST /seed-page": {
      // cmdSeed's per-file step: skip-if-exists, receipted, rebuilds.
      const parsed = parseBody(bodyText);
      if ("error" in parsed) return parsed.error;
      const path = typeof parsed.body.path === "string" ? parsed.body.path : "";
      const content = typeof parsed.body.content === "string" ? parsed.body.content : "";
      if (path === "" || content === "") return err(400, "path and content are required");
      const r = await ctx.seedPage(path, content);
      return {
        status: 200,
        body: {
          path,
          outcome: r.outcome,
          ...(r.outcome === "applied" ? { rev_id: r.revID, version: r.version } : {}),
        },
      };
    }

    default:
      return err(404, "no such admin endpoint");
  }
}
