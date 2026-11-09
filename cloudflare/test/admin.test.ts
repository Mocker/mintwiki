import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// M3.4 acceptance for the Cloudflare runtime: the admin surface is
// the only owner door — token-gated, parity with the Go CLI's
// operations — and the retired bootstrap routes stay closed. The
// full owner workflow through the admin.mjs client against a live
// server is the milestone's exit test (run under wrangler dev).

const ADMIN = "mintwiki-test-admin-token";

async function admin(
  path: string,
  init: RequestInit = {},
  token: string | null = ADMIN,
): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch(`https://mw/v1/admin${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("mintwiki admin surface (M3.4)", () => {
  it("gates on the admin token and covers the owner operations", async () => {
    // No token and wrong token are both flat 401s.
    expect((await admin("/services", {}, null)).status).toBe(401);
    expect((await admin("/services", {}, "not-the-admin-token")).status).toBe(401);

    // The retired bootstrap surface is closed from outside.
    const retired = await SELF.fetch("https://mw/internal/seed-page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "x", content: "y" }),
    });
    expect(retired.status).toBe(404);

    // Unknown admin endpoints 404 (after auth).
    expect((await admin("/nope")).status).toBe(404);

    // Admin mint: the owner's direct mint, registered immediately.
    const minted = await admin("/mint", {
      method: "POST",
      body: JSON.stringify({ actor: "owner", paths: ["/admin-probe/**"], tier: "allow", ttl_seconds: 600 }),
    });
    expect(minted.status).toBe(200);
    expect(minted.body.token).toBeTruthy();
    const edit = await SELF.fetch("https://mw/edit", {
      method: "POST",
      headers: { authorization: `Bearer ${minted.body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "admin-probe/page", content: "# Admin minted\n", expected_version: 0 }),
    });
    expect(edit.status).toBe(200);

    // Policy still binds the owner: over-cap TTL is a 400, not a mint.
    const overCap = await admin("/mint", {
      method: "POST",
      body: JSON.stringify({ paths: ["/admin-probe/**"], ttl_seconds: 99999 }),
    });
    expect(overCap.status).toBe(400);

    // Services: registration returns the credential once; listings
    // never carry credential material; duplicates conflict.
    const svc = await admin("/services", {
      method: "POST",
      body: JSON.stringify({
        name: "admin-agent",
        ceiling_paths: ["/admin-probe/**"],
        tiers: ["allow", "approve"],
        max_ttl_seconds: 1800,
      }),
    });
    expect(svc.status).toBe(201);
    expect(svc.body.credential).toMatch(/^mwsvc_[0-9a-f]{64}$/);

    const dup = await admin("/services", {
      method: "POST",
      body: JSON.stringify({ name: "admin-agent", ceiling_paths: ["/x/**"], tiers: ["allow"], max_ttl_seconds: 60 }),
    });
    expect(dup.status).toBe(409);

    const list = await admin("/services");
    expect(list.status).toBe(200);
    const mine = list.body.services.find((s: any) => s.name === "admin-agent");
    expect(mine).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toContain("cred_hash");
    expect(JSON.stringify(list.body)).not.toContain(svc.body.credential);

    // Approve-tier edit → visible in the proposals listing.
    const exApprove = await SELF.fetch("https://mw/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${svc.body.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ paths: ["/admin-probe/**"], tier: "approve", ttl_seconds: 600 }),
    });
    const approveToken = ((await exApprove.json()) as any).token as string;
    const proposedRes = await SELF.fetch("https://mw/edit", {
      method: "POST",
      headers: { authorization: `Bearer ${approveToken}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "admin-probe/page", content: "# v2\n", expected_version: 1 }),
    });
    expect(proposedRes.status).toBe(202);
    const proposals = await admin("/proposals?status=pending");
    const mine2 = proposals.body.proposals.find((p: any) => p.path === "admin-probe/page");
    expect(mine2).toBeTruthy();
    expect(mine2.status).toBe("pending");

    // Revoking the service kills its credential at the exchange.
    const revoked = await admin("/services/revoke", {
      method: "POST",
      body: JSON.stringify({ name: "admin-agent" }),
    });
    expect(revoked.status).toBe(200);
    const exAfter = await SELF.fetch("https://mw/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${svc.body.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ paths: ["/admin-probe/**"] }),
    });
    expect(exAfter.status).toBe(401);

    // Revoking an unknown service says so.
    expect(
      (await admin("/services/revoke", { method: "POST", body: JSON.stringify({ name: "ghost" }) })).status,
    ).toBe(404);

    // Receipts verify through the admin surface too.
    const verify = await admin("/receipts/verify");
    expect(verify.body.ok).toBe(true);
    expect(verify.body.entries).toBeGreaterThan(0);
  });
});
