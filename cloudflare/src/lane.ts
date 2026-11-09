// The write lane, ported from internal/web (Go): POST /edit,
// POST /v1/tokens (the exchange), GET /v1/tokens/{id} (pickup).
// Verification order, status codes, response shapes, and receipt
// behavior mirror the Go handlers statement for statement — the
// conformance suite holds both runtimes to them.
//
// The lane runs inside the wiki Durable Object, so every step (token
// registry lookups, CAS writes, receipt appends) is serialized by the
// object's single-threaded execution.

import { ReceiptLog } from "./receipts";
import { ConflictError, NotFoundError, WikiStore, type Service } from "./store";
import {
  coversPath,
  hashCredential,
  keyBytesFromHex,
  mint,
  parse,
  scopeString,
  withinCeiling,
  TOOL_EDIT,
  TIER_ALLOW,
  TIER_APPROVE,
  type Claims,
} from "./token";
import { normalizePath } from "./store";

export interface LaneResult {
  status: number;
  body: Record<string, unknown>;
}

function result(status: number, body: Record<string, unknown>): LaneResult {
  return { status, body };
}

export class Lane {
  private keyBytes: Uint8Array | null;

  constructor(
    private store: WikiStore,
    private receipts: ReceiptLog,
    signingSecretHex: string | undefined,
    private onHeadMoved: () => Promise<void>,
  ) {
    // Fail closed: no secret configured means no lane, never a
    // default key.
    this.keyBytes = signingSecretHex ? keyBytesFromHex(signingSecretHex) : null;
  }

  private requireKey(): Uint8Array {
    if (!this.keyBytes) throw new Error("SIGNING_SECRET is not configured");
    return this.keyBytes;
  }

  // verifyEditToken runs the shared verification steps in order:
  // bearer <redacted> → signature/expiry → jti minted by this wiki → not
  // revoked → scope covers the target path. Claims may be non-null on
  // failure (for receipting) once parsing succeeded.
  private async verifyEditToken(
    auth: string | null,
    path: string,
  ): Promise<{ claims: Claims | null; code: number; reason: string }> {
    if (!auth || !auth.startsWith("Bearer ")) {
      return { claims: null, code: 401, reason: "missing bearer token" };
    }
    let claims: Claims;
    try {
      claims = await parse(this.requireKey(), auth.slice("Bearer ".length));
    } catch {
      return { claims: null, code: 401, reason: "invalid or expired token" };
    }
    if (!this.store.isRegistered(claims.jti)) {
      return { claims, code: 401, reason: "token not minted by this wiki" };
    }
    if (this.store.isRevoked(claims.jti)) {
      return { claims, code: 401, reason: "token revoked" };
    }
    if (claims.tool !== TOOL_EDIT || !coversPath(claims, path)) {
      return { claims, code: 403, reason: "token scope does not cover this page" };
    }
    return { claims, code: 0, reason: "" };
  }

  // proposeWithClaims stores an edit as a proposal under
  // already-verified claims and receipts the outcome (proposed, or
  // rejected on conflict). The head never moves here.
  async proposeWithClaims(
    claims: Claims,
    path: string,
    content: string,
    expectedVersion: number,
  ): Promise<{ proposalID: string; code: number; reason: string }> {
    const before = this.store.headVersion(path);
    try {
      const propID = await this.store.addProposal(
        path,
        new TextEncoder().encode(content),
        expectedVersion,
        claims.jti,
      );
      await this.receipts.append({
        actor: claims.actor,
        token_jti: claims.jti,
        scope: scopeString(claims),
        page: path,
        result: "proposed",
        proposal_id: propID,
        before_version: before,
        after_version: before,
      });
      return { proposalID: propID, code: 0, reason: "" };
    } catch (e) {
      if (e instanceof ConflictError) {
        const reason = "head moved since the edit was based on it";
        await this.receipts.append({
          actor: claims.actor,
          token_jti: claims.jti,
          scope: scopeString(claims),
          page: path,
          result: "rejected",
          reason,
          before_version: before,
          after_version: before,
        });
        return { proposalID: "", code: 409, reason };
      }
      throw e;
    }
  }

  // verifyForPropose exposes the shared verification to the MCP
  // propose_edit tool (M3.3), exactly as the Go server shares
  // verifyEditToken between /edit and the tool executor.
  async verifyForPropose(auth: string | null, path: string) {
    return this.verifyEditToken(auth, path);
  }

  async handleEdit(auth: string | null, rawBody: string): Promise<LaneResult> {
    let req: { path?: string; content?: string; expected_version?: number };
    try {
      req = JSON.parse(rawBody);
    } catch {
      return result(400, { error: "bad JSON body" });
    }
    let path: string;
    try {
      path = normalizePath(req.path ?? "");
    } catch {
      return result(400, { error: "invalid page path" });
    }
    const content = req.content ?? "";
    const expectedVersion = req.expected_version ?? 0;

    const reject = async (code: number, claims: Claims | null, reason: string): Promise<LaneResult> => {
      const cur = this.store.headVersion(path);
      await this.receipts.append({
        actor: claims?.actor ?? "",
        token_jti: claims?.jti ?? "",
        scope: claims ? scopeString(claims) : "",
        page: path,
        result: "rejected",
        reason,
        before_version: cur,
        after_version: cur,
      });
      return result(code, { error: reason });
    };

    const { claims, code, reason } = await this.verifyEditToken(auth, path);
    if (reason !== "" || !claims) return reject(code, claims, reason);

    const before = this.store.headVersion(path);

    // approve tier: land as a proposal; the head does not move.
    if (claims.tier === TIER_APPROVE) {
      const p = await this.proposeWithClaims(claims, path, content, expectedVersion);
      if (p.reason !== "") return result(p.code, { error: p.reason });
      return result(202, { status: "proposed", proposal_id: p.proposalID });
    }

    // allow tier: CAS write moves the head.
    try {
      const { revID, newVersion } = await this.store.putPage(
        path,
        new TextEncoder().encode(content),
        expectedVersion,
        claims.actor,
        claims.jti,
      );
      await this.receipts.append({
        actor: claims.actor,
        token_jti: claims.jti,
        scope: scopeString(claims),
        page: path,
        result: "applied",
        rev_id: revID,
        before_version: before,
        after_version: newVersion,
      });
      await this.onHeadMoved();
      return result(200, { status: "applied", revision: revID, version: newVersion });
    } catch (e) {
      if (e instanceof ConflictError) {
        await this.receipts.append({
          actor: claims.actor,
          token_jti: claims.jti,
          scope: scopeString(claims),
          page: path,
          result: "rejected",
          reason: "head conflict",
          before_version: e.currentVersion,
          after_version: e.currentVersion,
        });
        return result(409, { error: "head conflict", current_version: e.currentVersion });
      }
      throw e;
    }
  }

  // serviceFromAuth resolves the exchange's credential to a service,
  // mirroring the Go handlers' opening gates.
  private async serviceFromAuth(
    auth: string | null,
  ): Promise<{ svc: Service | null; code: number; reason: string }> {
    if (!auth || !auth.startsWith("Bearer ")) {
      return { svc: null, code: 401, reason: "missing service credential" };
    }
    try {
      const svc = this.store.getServiceByHash(await hashCredential(auth.slice("Bearer ".length)));
      return { svc, code: 0, reason: "" };
    } catch (e) {
      if (e instanceof NotFoundError) return { svc: null, code: 401, reason: "unknown service credential" };
      throw e;
    }
  }

  // handleMint is the token exchange. Gates, in the Go order:
  // credential known → not revoked → (body) → tool known → envelope
  // gates (paths empty is a flat 400; ceiling / tier / service cap /
  // policy failures ESCALATE to the approval queue as a 202, they are
  // not flat denials) → mint + register + receipt.
  async handleMint(auth: string | null, rawBody: string): Promise<LaneResult> {
    const deny = async (code: number, svc: Service | null, scopeDesc: string, reason: string) => {
      await this.receipts.append({
        actor: svc?.name ?? "",
        token_jti: "",
        scope: scopeDesc,
        page: "",
        result: "mint_denied",
        reason,
        before_version: 0,
        after_version: 0,
      });
      return result(code, { error: reason });
    };

    const { svc, code, reason } = await this.serviceFromAuth(auth);
    if (!svc) return deny(code, null, "", reason);
    if (svc.revoked) return deny(401, svc, "", "service credential revoked");

    let req: { tool?: string; paths?: string[]; tier?: string; ttl_seconds?: number };
    try {
      req = JSON.parse(rawBody);
    } catch {
      return deny(400, svc, "", "bad JSON body");
    }
    const tool = req.tool || TOOL_EDIT;
    const paths = req.paths ?? [];
    const tier = req.tier || TIER_ALLOW;
    const scopeDesc = `${tool}:${paths.join(",")}`;
    if (tool !== TOOL_EDIT) return deny(403, svc, scopeDesc, "unknown tool");

    const policy = this.store.getPolicy();
    const ttl = req.ttl_seconds && req.ttl_seconds > 0 ? req.ttl_seconds : policy.defaultTTLSeconds;

    let escalation = "";
    if (paths.length === 0) {
      return deny(400, svc, scopeDesc, "no paths requested");
    } else if (!withinCeiling(svc.ceilingPaths, paths)) {
      escalation = "requested paths exceed service ceiling";
    } else if (!svc.tiers.includes(tier)) {
      escalation = "tier not allowed for this service";
    } else if (ttl > svc.maxTTLSeconds) {
      escalation = "ttl exceeds service cap";
    } else if (this.store.checkTTL(ttl) !== null) {
      escalation = "ttl exceeds wiki policy";
    }

    if (escalation !== "") {
      const existing = this.store.findPendingMintRequest(svc.name, tool, paths, tier, ttl);
      if (existing) {
        return result(202, { status: "pending_approval", request_id: existing.id });
      }
      const id = this.store.createMintRequest(svc.name, tool, paths, tier, ttl);
      await this.receipts.append({
        actor: svc.name,
        token_jti: "",
        scope: scopeDesc,
        page: "",
        result: "mint_requested",
        reason: escalation,
        request_id: id,
        before_version: 0,
        after_version: 0,
      });
      return result(202, { status: "pending_approval", request_id: id });
    }

    try {
      const { token, claims } = await mint(this.requireKey(), svc.name, tool, paths, tier, ttl);
      this.store.registerToken(claims.jti, scopeString(claims), claims.tier, claims.exp);
      await this.receipts.append({
        actor: svc.name,
        token_jti: claims.jti,
        scope: scopeString(claims),
        page: "",
        result: "minted",
        before_version: 0,
        after_version: 0,
      });
      return result(200, {
        token,
        jti: claims.jti,
        expires_at: new Date(claims.exp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
    } catch (e) {
      return deny(400, svc, scopeDesc, (e as Error).message);
    }
  }

  // handleMintPoll is the pickup endpoint: the requesting service
  // polls with its own credential (another service's request reads as
  // not-found); an approved request's token is minted at pickup —
  // never stored — and delivered exactly once. Pending requests
  // expire after 24h.
  async handleMintPoll(auth: string | null, id: string): Promise<LaneResult> {
    const { svc, reason } = await this.serviceFromAuth(auth);
    if (!svc || svc.revoked) {
      return result(401, { error: reason || "unknown service credential" });
    }
    let mreq;
    try {
      mreq = this.store.getMintRequest(id);
    } catch (e) {
      if (e instanceof NotFoundError) return result(404, { error: "no such mint request" });
      throw e;
    }
    if (mreq.service !== svc.name) return result(404, { error: "no such mint request" });

    switch (mreq.status) {
      case "pending": {
        const created = Date.parse(mreq.createdAt);
        if (Number.isFinite(created) && Date.now() - created > 24 * 3600 * 1000) {
          this.store.setMintRequestStatus(mreq.id, "expired");
          return result(200, { status: "expired", request_id: mreq.id });
        }
        return result(200, { status: "pending", request_id: mreq.id });
      }
      case "denied":
      case "issued":
      case "expired":
        return result(200, { status: mreq.status, request_id: mreq.id });
      case "approved": {
        const { token, claims } = await mint(
          this.requireKey(),
          svc.name,
          mreq.tool,
          mreq.paths,
          mreq.tier,
          mreq.ttlSeconds,
        );
        this.store.registerToken(claims.jti, scopeString(claims), claims.tier, claims.exp);
        this.store.setMintRequestStatus(mreq.id, "issued");
        await this.receipts.append({
          actor: svc.name,
          token_jti: claims.jti,
          scope: scopeString(claims),
          page: "",
          result: "minted",
          request_id: mreq.id,
          before_version: 0,
          after_version: 0,
        });
        return result(200, {
          status: "approved",
          token,
          jti: claims.jti,
          expires_at: new Date(claims.exp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
          request_id: mreq.id,
        });
      }
      default:
        return result(500, { error: "unknown request status" });
    }
  }

  // decideMintRequest mirrors cmdDecideRequest (Go): the owner's
  // approve/deny on an escalated mint request, receipted as
  // mint_request_approved / mint_request_denied with actor "owner".
  async decideMintRequest(id: string, approve: boolean): Promise<LaneResult> {
    let mreq;
    try {
      mreq = this.store.getMintRequest(id);
    } catch (e) {
      if (e instanceof NotFoundError) return result(404, { error: "no such mint request" });
      throw e;
    }
    if (mreq.status !== "pending") {
      return result(400, { error: `mint request is ${mreq.status}` });
    }
    this.store.setMintRequestStatus(id, approve ? "approved" : "denied");
    await this.receipts.append({
      actor: "owner",
      token_jti: "",
      scope: `${mreq.tool}:${mreq.paths.join(",")}`,
      page: "",
      result: approve ? "mint_request_approved" : "mint_request_denied",
      request_id: id,
      before_version: 0,
      after_version: 0,
    });
    return result(200, { status: approve ? "approved" : "denied", request_id: id });
  }

  // acceptProposal is the owner's accept, mirroring cmdAccept (Go):
  // apply the stored revision at its base version, mark accepted, and
  // receipt it as the owner. Reached through the admin API (M3.4).
  async acceptProposal(id: string): Promise<LaneResult> {
    let p;
    try {
      p = await this.store.getProposal(id);
    } catch (e) {
      if (e instanceof NotFoundError) return result(404, { error: "no such proposal" });
      throw e;
    }
    const before = this.store.headVersion(p.pagePath);
    try {
      const { newVersion } = await this.store.acceptProposal(id, "owner");
      await this.receipts.append({
        actor: "owner",
        token_jti: p.tokenJTI,
        scope: "",
        page: p.pagePath,
        result: "accepted",
        proposal_id: p.id,
        rev_id: p.revID,
        before_version: before,
        after_version: newVersion,
      });
      await this.onHeadMoved();
      return result(200, { status: "accepted", proposal_id: id, version: newVersion });
    } catch (e) {
      if (e instanceof ConflictError) {
        return result(409, { error: "head conflict", current_version: e.currentVersion });
      }
      return result(400, { error: (e as Error).message });
    }
  }
}

export { TIER_ALLOW, TIER_APPROVE };
