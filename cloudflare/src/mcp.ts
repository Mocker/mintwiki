// The HTTP MCP server, ported from internal/web/mcp.go (Go): the
// shared tool definitions exposed as JSON-RPC 2.0 at POST /mcp.
// Stateless, JSON responses only — no SSE. Both initialize (current
// MCP clients) and server/discover (the stateless revision) are
// answered from the same payload.
//
// Reads are token-free. propose_edit runs the same token lane as
// POST /edit — the bearer token arrives on the /mcp request's
// Authorization header — and always lands as a proposal.

import { DEFINITIONS, Executor } from "./tools";

export const MCP_SERVER_VERSION = "0.2.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

export interface McpOutcome {
  status: number;
  // null body = the 202 notification answer (accepted, no body).
  body: string | null;
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function discoveryResult(params: Record<string, unknown> | undefined): Record<string, unknown> {
  let version = DEFAULT_PROTOCOL_VERSION;
  if (params && typeof params.protocolVersion === "string" && params.protocolVersion !== "") {
    version = params.protocolVersion;
  }
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "mintwiki", version: MCP_SERVER_VERSION },
  };
}

function errorCallResult(msg: string): Record<string, unknown> {
  return { content: [{ type: "text", text: msg }], isError: true };
}

export async function handleMCP(
  executor: Executor,
  rawBody: string,
  auth: string | null,
): Promise<McpOutcome> {
  let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(rawBody);
  } catch {
    // Mirrors the Go handler: the parse-error response carries no id.
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }),
    };
  }
  // Notifications (no id) are accepted and never answered with a body.
  if (req.id === undefined || req.id === null) {
    return { status: 202, body: null };
  }
  const id = req.id;
  switch (req.method) {
    case "initialize":
    case "server/discover":
      return { status: 200, body: rpcResult(id, discoveryResult(req.params)) };
    case "ping":
      return { status: 200, body: rpcResult(id, {}) };
    case "tools/list":
      return { status: 200, body: rpcResult(id, { tools: DEFINITIONS }) };
    case "tools/call": {
      const params = req.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "") {
        return { status: 200, body: rpcResult(id, errorCallResult("tool name is required")) };
      }
      try {
        const res = await executor.dispatch(name, params.arguments, auth ?? "");
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(res) }],
            isError: false,
          }),
        };
      } catch (e) {
        return { status: 200, body: rpcResult(id, errorCallResult((e as Error).message)) };
      }
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `method not found: ${req.method ?? ""}`) };
  }
}
