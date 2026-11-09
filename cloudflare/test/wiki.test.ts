import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// M3.1 acceptance for the Cloudflare runtime: seed import is
// idempotent and receipted, seeded pages serve with their head
// revision named, and webmcp.js is generated from the shared tool
// definitions. Runs against the real Worker + Durable Object + R2
// bindings in the Workers test pool (miniflare).

async function seed(path: string, content: string) {
  return SELF.fetch("https://mw/internal/seed-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
}

describe("mintwiki cloudflare runtime (M3.1)", () => {
  it("seeds, serves, and skips on re-seed", async () => {
    const md = "# Home\n\nSeed demo content.\n\nSee [how it works](how-it-works).\n";

    const first = await seed("home", md);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { status: string; rev_id: string };
    expect(firstBody.status).toBe("applied");
    expect(firstBody.rev_id).toMatch(/^[0-9a-f]{64}$/);

    const page = await SELF.fetch("https://mw/home");
    expect(page.status).toBe(200);
    expect(page.headers.get("x-mintwiki-revision")).toBe(firstBody.rev_id);
    const html = await page.text();
    expect(html).toContain("Seed demo content.");
    expect(html).toContain(`revision ${firstBody.rev_id} · version 1`);

    const again = await seed("home", md);
    const againBody = (await again.json()) as { status: string };
    expect(againBody.status).toBe("skipped");

    const index = await SELF.fetch("https://mw/");
    expect(index.status).toBe(200);
    // Not asserting the full page list here: test files share one R2
    // bucket (miniflare) while each file's Durable Object is its own
    // instance, so another file's rebuild can legitimately overwrite
    // site/index.html between this file's seed and this fetch. The
    // index's exact contents are asserted by the conformance suite
    // against a standalone runtime, where one wiki owns the bucket.
    expect(await index.text()).toContain("<h1>MintWiki</h1>");

    const js = await SELF.fetch("https://mw/webmcp.js");
    expect(js.status).toBe(200);
    const jsText = await js.text();
    expect(jsText).toContain('"get_page"');
    expect(jsText).toContain('"propose_edit"');

    const missing = await SELF.fetch("https://mw/no-such-page");
    expect(missing.status).toBe(404);
  });

  it("receipts chain verifies after seeding", async () => {
    const res = await SELF.fetch("https://mw/internal/receipts-verify");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: number; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.entries).toBeGreaterThanOrEqual(1);
  });

  it("GET /mcp is refused; a notification is accepted silently", async () => {
    const get = await SELF.fetch("https://mw/mcp");
    expect(get.status).toBe(405);
    const note = await SELF.fetch("https://mw/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
  });
});
