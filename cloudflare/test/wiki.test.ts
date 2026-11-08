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
    expect(await index.text()).toContain('<a href="/home">home</a>');

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

  it("write surfaces answer 501 until their milestones land", async () => {
    const res = await SELF.fetch("https://mw/edit", { method: "POST", body: "{}" });
    expect(res.status).toBe(501);
  });
});
