import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// M3.3 acceptance for the Cloudflare runtime: the HTTP MCP server
// behaves like the Go server's — discovery handshake, tools/list from
// the shared definitions, the five read tools, and propose_edit
// running the shared token lane (always a proposal, never a head
// move). Mirrors the MCP scenarios in scripts/demo.sh.

const CRED = "mwsvc_" + "44".repeat(32);

async function rpc(body: unknown, auth?: string): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch("https://mw/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let rpcID = 0;
async function callTool(name: string, args: Record<string, unknown>, auth?: string) {
  const { body } = await rpc(
    { jsonrpc: "2.0", id: ++rpcID, method: "tools/call", params: { name, arguments: args } },
    auth,
  );
  const result = body.result as { content: { text: string }[]; isError: boolean };
  return {
    isError: result.isError,
    text: result.content[0].text,
    json: result.isError ? null : JSON.parse(result.content[0].text),
  };
}

async function seed(path: string, content: string) {
  const res = await SELF.fetch("https://mw/internal/seed-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(200);
}

describe("mintwiki MCP surface (M3.3)", () => {
  it("discovers, lists, reads, and proposes like the Go server", async () => {
    await seed("mcp/target", "# Target\n\n## Details\n\nDeep content here.\n\n## Other\n\nNope.\n");
    await seed("mcp/linker", "# Linker\n\nSee [the target](mcp/target) and [[mcp/target|Target]].\n");

    // Discovery: initialize echoes the client's protocol version;
    // server/discover answers the same payload.
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(init.body.result.protocolVersion).toBe("2025-03-26");
    expect(init.body.result.serverInfo).toEqual({ name: "mintwiki", version: "0.2.0" });
    const disc = await rpc({ jsonrpc: "2.0", id: 2, method: "server/discover", params: {} });
    expect(disc.body.result.protocolVersion).toBe("2024-11-05");

    // tools/list serves the shared definitions verbatim, in order.
    const list = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "get_page",
      "get_section",
      "search",
      "backlinks",
      "recent_changes",
      "propose_edit",
    ]);

    // Reads.
    const page = await callTool("get_page", { path: "mcp/target" });
    expect(page.isError).toBe(false);
    expect(page.json.version).toBe(1);
    expect(page.json.content).toContain("Deep content here.");

    const section = await callTool("get_section", { path: "mcp/target", heading: "details" });
    expect(section.isError).toBe(false);
    expect(section.json.level).toBe(2);
    expect(section.json.content).toContain("Deep content here.");
    expect(section.json.content).not.toContain("Nope.");

    const missing = await callTool("get_section", { path: "mcp/target", heading: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("section not found");

    const search = await callTool("search", { query: "Deep content" });
    expect(search.json.results[0].path).toBe("mcp/target");

    const backlinks = await callTool("backlinks", { path: "mcp/target" });
    expect(backlinks.json.backlinks).toContain("mcp/linker");

    const changes = await callTool("recent_changes", { limit: 5 });
    expect(changes.json.changes.length).toBeGreaterThan(0);
    expect(changes.json.changes[0].author).toBe("seed");

    const unknownTool = await callTool("nope", {});
    expect(unknownTool.isError).toBe(true);
    expect(unknownTool.text).toContain("unknown tool: nope");

    // Protocol errors.
    const unknownMethod = await rpc({ jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(unknownMethod.body.error.code).toBe(-32601);
    const parseErr = await rpc("{not json");
    expect(parseErr.status).toBe(400);
    expect(parseErr.body.error.code).toBe(-32700);
    expect("id" in parseErr.body).toBe(false);

    // propose_edit: no token → lane rejection as a tool error.
    const noTok = await callTool("propose_edit", {
      path: "mcp/target",
      content: "# Target\n\nv2\n",
      expected_version: 1,
    });
    expect(noTok.isError).toBe(true);
    expect(noTok.text).toBe("missing bearer token");

    // With a token (any tier — the tool always proposes): lands as a
    // proposal, head unmoved, acceptable by the owner.
    await SELF.fetch("https://mw/internal/register-service", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "mcp-agent",
        credential: CRED,
        ceiling_paths: ["/mcp/**"],
        tiers: ["allow"],
        max_ttl_seconds: 1800,
      }),
    });
    const exRes = await SELF.fetch("https://mw/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${CRED}`, "content-type": "application/json" },
      body: JSON.stringify({ paths: ["/mcp/**"], tier: "allow", ttl_seconds: 600 }),
    });
    const { token } = (await exRes.json()) as { token: string };

    const proposed = await callTool(
      "propose_edit",
      { path: "mcp/target", content: "# Target\n\nv2 via MCP\n", expected_version: 1 },
      token,
    );
    expect(proposed.isError).toBe(false);
    expect(proposed.json.status).toBe("proposed");

    const stillV1 = await callTool("get_page", { path: "mcp/target" });
    expect(stillV1.json.version).toBe(1);

    const accept = await SELF.fetch("https://mw/internal/accept-proposal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: proposed.json.proposal_id }),
    });
    expect(accept.status).toBe(200);
    const nowV2 = await callTool("get_page", { path: "mcp/target" });
    expect(nowV2.json.version).toBe(2);
    expect(nowV2.json.content).toContain("v2 via MCP");

    // A stale-base proposal conflicts.
    const stale = await callTool(
      "propose_edit",
      { path: "mcp/target", content: "stale", expected_version: 1 },
      token,
    );
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("head moved since the edit was based on it");

    const verify = await SELF.fetch("https://mw/internal/receipts-verify");
    const vbody = (await verify.json()) as { ok: boolean };
    expect(vbody.ok).toBe(true);
  });
});
