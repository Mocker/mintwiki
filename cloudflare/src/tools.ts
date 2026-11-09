// The six agent tools, ported from internal/tools (Go). The
// definitions themselves are NOT redefined here: they are imported
// from the canonical tools.definitions.json at the repo root — the
// file generated from the Go definitions and drift-checked in CI —
// so this surface, the Go MCP server, and webmcp.js all advertise
// identically.
//
// Reads are token-free (public-wiki semantics). propose_edit has no
// implementation here: it runs the token lane (lane.ts), injected by
// the Durable Object as a ProposeFunc, exactly as the Go server
// injects it into its Executor.

import { normalizePath, NotFoundError, WikiStore } from "./store";
import definitions from "../../tools.definitions.json";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export const DEFINITIONS = definitions as unknown as ToolDefinition[];

export interface ProposeRequest {
  path: string;
  content: string;
  expectedVersion: number;
}

// auth is the raw Authorization header value from the tool-call
// request ("" if none). Returns a proposal ID, or throws an error
// whose message is safe to show the caller.
export type ProposeFunc = (req: ProposeRequest, auth: string) => Promise<string>;

function invalid(msg: string): Error {
  return new Error(`invalid arguments: ${msg}`);
}

function normalizeToolPath(p: string): string {
  try {
    return normalizePath(p);
  } catch {
    throw invalid(`bad page path ${JSON.stringify(p)}`);
  }
}

export class Executor {
  constructor(
    private store: WikiStore,
    private propose: ProposeFunc | null,
  ) {}

  async dispatch(name: string, args: unknown, auth: string): Promise<unknown> {
    switch (name) {
      case "get_page": {
        const a = argsObj(args);
        return this.getPage(str(a.path));
      }
      case "get_section": {
        const a = argsObj(args);
        return this.getSection(str(a.path), str(a.heading));
      }
      case "search": {
        const a = argsObj(args);
        return this.search(str(a.query), num(a.limit));
      }
      case "backlinks": {
        const a = argsObj(args);
        return this.backlinks(str(a.path));
      }
      case "recent_changes": {
        const a = args === undefined || args === null ? {} : argsObj(args);
        return this.recentChanges(num(a.limit));
      }
      case "propose_edit": {
        const a = argsObj(args);
        if (a.expected_version === undefined || a.expected_version === null) {
          throw invalid("expected_version is required");
        }
        const path = normalizeToolPath(str(a.path));
        if (!this.propose) throw new Error("propose_edit is not available on this surface");
        const id = await this.propose(
          { path, content: str(a.content), expectedVersion: num(a.expected_version) },
          auth,
        );
        return { status: "proposed", proposal_id: id, path };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  private async getPage(rawPath: string) {
    const path = normalizeToolPath(rawPath);
    const page = await this.mustGetPage(path);
    return { path: page.path, revision: page.revID, version: page.version, content: page.content };
  }

  private async getSection(rawPath: string, heading: string) {
    const path = normalizeToolPath(rawPath);
    if (heading.trim() === "") throw invalid("heading is required");
    const page = await this.mustGetPage(path);
    const found = extractSection(page.content, heading);
    if (!found) throw new Error(`section not found: ${JSON.stringify(heading)} in ${path}`);
    return {
      path: page.path,
      revision: page.revID,
      version: page.version,
      heading: canonicalHeading(heading),
      level: found.level,
      content: found.text,
    };
  }

  private async mustGetPage(path: string) {
    try {
      return await this.store.getPage(path);
    } catch (e) {
      if (e instanceof NotFoundError) throw new Error(`page not found: ${path}`);
      throw e;
    }
  }

  private async search(query: string, limit: number) {
    if (query.trim() === "") throw invalid("query is required");
    if (limit <= 0) limit = 20;
    if (limit > 50) limit = 50;
    const q = query.toLowerCase();
    const hits: { path: string; revision: string; snippet: string }[] = [];
    for (const p of this.store.listPages()) {
      const page = await this.store.getPage(p);
      const idx = page.content.toLowerCase().indexOf(q);
      if (idx >= 0) {
        hits.push({ path: p, revision: page.revID, snippet: snippet(page.content, idx, query.length) });
      } else if (p.toLowerCase().includes(q)) {
        hits.push({ path: p, revision: page.revID, snippet: p });
      }
      if (hits.length >= limit) break;
    }
    return { query, results: hits };
  }

  private async backlinks(rawPath: string) {
    const path = normalizeToolPath(rawPath);
    await this.mustGetPage(path);
    const found: string[] = [];
    for (const p of this.store.listPages()) {
      if (p === path) continue;
      const page = await this.store.getPage(p);
      if (linkTargets(page.content)[path]) found.push(p);
    }
    return { path, backlinks: found };
  }

  private recentChanges(limit: number) {
    if (limit <= 0) limit = 20;
    if (limit > 100) limit = 100;
    const changes = this.store.recentChanges(limit).map((r) => ({
      revision: r.revID,
      path: r.pagePath,
      parent_revision: r.parentRev,
      author: r.author,
      created_at: r.createdAt,
    }));
    return { changes };
  }
}

function argsObj(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) throw invalid("missing arguments object");
  if (typeof args !== "object" || Array.isArray(args)) throw invalid("bad arguments: not an object");
  return args as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

// --- Section extraction (mirrors tools.ExtractSection) ---

export function canonicalHeading(h: string): string {
  return h.trim().replace(/^#+/, "").trim();
}

function headingLine(line: string): { level: number; text: string } | null {
  const trimmed = line.replace(/[ \t\r]+$/, "");
  let n = 0;
  while (n < trimmed.length && trimmed[n] === "#") n++;
  if (n === 0 || n > 6 || n >= trimmed.length || trimmed[n] !== " ") return null;
  return { level: n, text: trimmed.slice(n).trim() };
}

export function extractSection(
  content: string,
  heading: string,
): { text: string; level: number } | null {
  const want = canonicalHeading(heading).toLowerCase();
  const lines = content.split("\n");
  let start = -1;
  let lvl = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = headingLine(lines[i]);
    if (h && h.text.toLowerCase() === want) {
      start = i;
      lvl = h.level;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = headingLine(lines[i]);
    if (h && h.level <= lvl) {
      end = i;
      break;
    }
  }
  return { text: lines.slice(start, end).join("\n").replace(/\n+$/, "") + "\n", level: lvl };
}

// --- Link extraction (mirrors tools.linkTargets) ---

const MD_LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

// linkTargets returns the normalized page paths a document links to.
// External URLs are skipped; relative-link resolution is out of
// scope (links are wiki-root paths), exactly as in the Go tools.
export function linkTargets(content: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const add = (dest: string) => {
    dest = dest.trim();
    if (dest === "" || dest.includes("://") || dest.startsWith("#") || dest.startsWith("mailto:")) return;
    const hash = dest.indexOf("#");
    if (hash >= 0) dest = dest.slice(0, hash);
    if (dest.endsWith(".md")) dest = dest.slice(0, -3);
    if (dest.endsWith(".html")) dest = dest.slice(0, -5);
    try {
      out[normalizePath(dest)] = true;
    } catch {
      /* not a wiki path: not a link target */
    }
  };
  for (const m of content.matchAll(MD_LINK_RE)) add(m[1]);
  for (const m of content.matchAll(WIKI_LINK_RE)) add(m[1]);
  return out;
}

// snippet returns a window of content around a match, newlines
// folded (±60 chars, ellipses at truncated ends).
export function snippet(content: string, idx: number, qlen: number): string {
  let start = idx - 60;
  if (start < 0) start = 0;
  let end = idx + qlen + 60;
  if (end > content.length) end = content.length;
  let s = content.slice(start, end).replace(/\n/g, " ");
  if (start > 0) s = "…" + s;
  if (end < content.length) s += "…";
  return s;
}
