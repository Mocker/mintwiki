// The wiki store, ported from internal/store (Go). Same model:
//   - revisions are immutable objects named by their SHA-256 hash,
//     stored in R2 under revisions/<2-hex-prefix>/<id>.md (the Go
//     store's on-disk layout, kept so the two runtimes' data shapes
//     stay parallel);
//   - page heads live in SQLite — here the Durable Object's own
//     storage — and move only by compare-and-swap on head_version;
//   - the manifest tables (pages, revisions, tokens, proposals,
//     services, mint_requests) keep the Go schemas verbatim, plus a
//     receipts table (internal/receipts is a file in Go; see
//     receipts.ts) and a meta table for policy values.
// The Durable Object executes one request at a time, so the CAS
// protocol needs no extra locking — serialization is structural.

import { rfc3339Seconds, sha256hex } from "./receipts";

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS pages (
     path TEXT PRIMARY KEY,
     head_rev TEXT NOT NULL,
     head_version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS revisions (
     rev_id TEXT PRIMARY KEY,
     page_path TEXT NOT NULL,
     parent_rev TEXT NOT NULL DEFAULT '',
     author TEXT NOT NULL DEFAULT '',
     token_jti TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tokens (
     jti TEXT PRIMARY KEY,
     scope TEXT NOT NULL DEFAULT '',
     tier TEXT NOT NULL DEFAULT '',
     exp INTEGER NOT NULL DEFAULT 0,
     revoked INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS proposals (
     id TEXT PRIMARY KEY,
     page_path TEXT NOT NULL,
     rev_id TEXT NOT NULL,
     base_version INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     token_jti TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS services (
     name TEXT PRIMARY KEY,
     cred_hash TEXT NOT NULL,
     ceiling_paths TEXT NOT NULL DEFAULT '',
     tiers TEXT NOT NULL DEFAULT '',
     max_ttl_seconds INTEGER NOT NULL DEFAULT 1800,
     revoked INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS mint_requests (
     id TEXT PRIMARY KEY,
     service TEXT NOT NULL,
     tool TEXT NOT NULL,
     paths TEXT NOT NULL DEFAULT '',
     tier TEXT NOT NULL DEFAULT 'allow',
     ttl_seconds INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at TEXT NOT NULL,
     decided_at TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS receipts (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     hash TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

// Policy defaults, mirroring the Go policy file's defaults + hard cap.
export const POLICY_DEFAULT_TTL_SECONDS = 1800;
export const POLICY_CAP_TTL_SECONDS = 3600;

export class ConflictError extends Error {
  constructor(public currentVersion: number) {
    super("version conflict");
  }
}

export class NotFoundError extends Error {}

// normalizePath mirrors store.NormalizePath (Go): trims one leading
// slash and whitespace, rejects empty/dot segments.
export function normalizePath(p: string): string {
  p = p.trim().replace(/^\//, "");
  if (p === "") throw new Error("empty path");
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new Error(`invalid path segment in ${JSON.stringify(p)}`);
    }
  }
  return p;
}

export interface Page {
  path: string;
  content: string;
  revID: string;
  version: number;
}

export class WikiStore {
  constructor(
    private sql: SqlStorage,
    private blob: R2Bucket,
  ) {}

  initSchema(): void {
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  private revisionKey(revID: string): string {
    return `revisions/${revID.slice(0, 2)}/${revID}.md`;
  }

  // writeRevision stores content as an immutable revision object and
  // returns its hash. Writing the same content twice is a no-op.
  async writeRevision(content: Uint8Array): Promise<string> {
    const id = await sha256hex(content);
    const key = this.revisionKey(id);
    if (!(await this.blob.head(key))) {
      await this.blob.put(key, content, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      });
    }
    return id;
  }

  async readRevision(revID: string): Promise<string> {
    const obj = await this.blob.get(this.revisionKey(revID));
    if (!obj) throw new NotFoundError(`revision ${revID}`);
    return obj.text();
  }

  // putPage is store.PutPage (Go): the revision object is written
  // FIRST, then the head moves by CAS on the expected version — so a
  // conflict never leaves a dangling head, and an orphaned revision
  // object is harmless.
  async putPage(
    path: string,
    content: Uint8Array,
    expectedVersion: number,
    author: string,
    jti: string,
  ): Promise<{ revID: string; newVersion: number }> {
    const revID = await this.writeRevision(content);
    const rows = this.sql
      .exec("SELECT head_rev, head_version FROM pages WHERE path = ?", path)
      .toArray() as { head_rev: string; head_version: number }[];
    const exists = rows.length > 0;
    const curRev = exists ? rows[0].head_rev : "";
    const curVer = exists ? rows[0].head_version : 0;
    if (curVer !== expectedVersion) throw new ConflictError(curVer);
    const newVersion = curVer + 1;
    if (exists) {
      this.sql.exec(
        "UPDATE pages SET head_rev = ?, head_version = ? WHERE path = ? AND head_version = ?",
        revID,
        newVersion,
        path,
        curVer,
      );
    } else {
      this.sql.exec("INSERT INTO pages(path, head_rev, head_version) VALUES(?, ?, ?)", path, revID, newVersion);
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO revisions(rev_id, page_path, parent_rev, author, token_jti, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
      revID,
      path,
      curRev,
      author,
      jti,
      rfc3339Seconds(),
    );
    // Head mirror: pages/<path>.md in the bucket, the analogue of the
    // Go store's data/pages mirror.
    await this.blob.put(`pages/${path}.md`, content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    return { revID, newVersion };
  }

  async getPage(path: string): Promise<Page> {
    const rows = this.sql
      .exec("SELECT head_rev, head_version FROM pages WHERE path = ?", path)
      .toArray() as { head_rev: string; head_version: number }[];
    if (!rows.length) throw new NotFoundError(`page ${path}`);
    const content = await this.readRevision(rows[0].head_rev);
    return { path, content, revID: rows[0].head_rev, version: rows[0].head_version };
  }

  async pageExists(path: string): Promise<boolean> {
    const rows = this.sql.exec("SELECT path FROM pages WHERE path = ?", path).toArray();
    return rows.length > 0;
  }

  listPages(): string[] {
    const rows = this.sql.exec("SELECT path FROM pages ORDER BY path ASC").toArray() as { path: string }[];
    return rows.map((r) => r.path);
  }

  // --- Token registry (internal/store, M3.2) ---

  headVersion(path: string): number {
    const rows = this.sql
      .exec("SELECT head_version FROM pages WHERE path = ?", path)
      .toArray() as { head_version: number }[];
    return rows.length ? rows[0].head_version : 0;
  }

  registerToken(jti: string, scope: string, tier: string, exp: number): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO tokens(jti, scope, tier, exp, revoked) VALUES(?, ?, ?, ?, 0)",
      jti,
      scope,
      tier,
      exp,
    );
  }

  // Revoking an unknown jti still records the revocation (defense in
  // depth), exactly as the Go store does.
  revokeToken(jti: string): void {
    const rows = this.sql.exec("SELECT jti FROM tokens WHERE jti = ?", jti).toArray();
    if (rows.length) {
      this.sql.exec("UPDATE tokens SET revoked = 1 WHERE jti = ?", jti);
    } else {
      this.sql.exec("INSERT INTO tokens(jti, revoked) VALUES(?, 1)", jti);
    }
  }

  isRevoked(jti: string): boolean {
    const rows = this.sql
      .exec("SELECT revoked FROM tokens WHERE jti = ?", jti)
      .toArray() as { revoked: number }[];
    return rows.length > 0 && rows[0].revoked === 1;
  }

  isRegistered(jti: string): boolean {
    const rows = this.sql.exec("SELECT COUNT(*) AS n FROM tokens WHERE jti = ?", jti).toArray() as {
      n: number;
    }[];
    return rows[0].n > 0;
  }

  // --- Proposals ---

  async addProposal(path: string, content: Uint8Array, baseVersion: number, jti: string): Promise<string> {
    const revID = await this.writeRevision(content);
    const cur = this.headVersion(path);
    if (cur !== baseVersion) throw new ConflictError(cur);
    const id = `prop-${revID.slice(0, 8)}-${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    this.sql.exec(
      `INSERT INTO proposals(id, page_path, rev_id, base_version, status, token_jti, created_at)
       VALUES(?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      path,
      revID,
      baseVersion,
      jti,
      rfc3339Seconds(),
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO revisions(rev_id, page_path, parent_rev, author, token_jti, created_at)
       VALUES(?, ?, '', '', ?, ?)`,
      revID,
      path,
      jti,
      rfc3339Seconds(),
    );
    return id;
  }

  async getProposal(id: string): Promise<Proposal> {
    const rows = this.sql
      .exec(
        "SELECT id, page_path, rev_id, base_version, status, token_jti, created_at FROM proposals WHERE id = ?",
        id,
      )
      .toArray() as unknown as ProposalRow[];
    if (!rows.length) throw new NotFoundError(`proposal ${id}`);
    const r = rows[0];
    const content = await this.readRevision(r.rev_id);
    return {
      id: r.id,
      pagePath: r.page_path,
      revID: r.rev_id,
      baseVersion: r.base_version,
      status: r.status,
      tokenJTI: r.token_jti,
      createdAt: r.created_at,
      content,
    };
  }

  // acceptProposal mirrors store.AcceptProposal (Go): the stored
  // revision is applied at the proposal's base version — so a head
  // that moved since the proposal was made conflicts here, not at
  // propose time only.
  async acceptProposal(id: string, author: string): Promise<{ newVersion: number }> {
    const p = await this.getProposal(id);
    if (p.status !== "pending") throw new Error(`proposal ${id} is ${p.status}`);
    const { newVersion } = await this.putPage(
      p.pagePath,
      new TextEncoder().encode(p.content),
      p.baseVersion,
      author,
      p.tokenJTI,
    );
    this.sql.exec("UPDATE proposals SET status = 'accepted' WHERE id = ?", id);
    return { newVersion };
  }

  // --- Services & the mint-request queue ---

  registerService(
    name: string,
    credHash: string,
    ceilingPaths: string[],
    tiers: string[],
    maxTTLSeconds: number,
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO services(name, cred_hash, ceiling_paths, tiers, max_ttl_seconds, revoked, created_at)
       VALUES(?, ?, ?, ?, ?, 0, ?)`,
      name,
      credHash,
      ceilingPaths.join(","),
      tiers.join(","),
      maxTTLSeconds,
      rfc3339Seconds(),
    );
  }

  getServiceByHash(credHash: string): Service {
    const rows = this.sql
      .exec(
        "SELECT name, cred_hash, ceiling_paths, tiers, max_ttl_seconds, revoked, created_at FROM services WHERE cred_hash = ?",
        credHash,
      )
      .toArray() as unknown as ServiceRow[];
    if (!rows.length) throw new NotFoundError("service");
    const r = rows[0];
    return {
      name: r.name,
      credHash: r.cred_hash,
      ceilingPaths: r.ceiling_paths ? r.ceiling_paths.split(",") : [],
      tiers: r.tiers ? r.tiers.split(",") : [],
      maxTTLSeconds: r.max_ttl_seconds,
      revoked: r.revoked === 1,
      createdAt: r.created_at,
    };
  }

  createMintRequest(
    service: string,
    tool: string,
    paths: string[],
    tier: string,
    ttlSeconds: number,
  ): string {
    const rand = new Uint8Array(6);
    crypto.getRandomValues(rand);
    const suffix = [...rand].map((x) => x.toString(16).padStart(2, "0")).join("");
    const id = `mreq-${Date.now()}${Math.floor(Math.random() * 1e6)}-${suffix}`;
    this.sql.exec(
      `INSERT INTO mint_requests(id, service, tool, paths, tier, ttl_seconds, status, created_at)
       VALUES(?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      service,
      tool,
      paths.join(","),
      tier,
      ttlSeconds,
      rfc3339Seconds(),
    );
    return id;
  }

  findPendingMintRequest(
    service: string,
    tool: string,
    paths: string[],
    tier: string,
    ttlSeconds: number,
  ): MintRequest | null {
    const rows = this.sql
      .exec(
        `SELECT id, service, tool, paths, tier, ttl_seconds, status, created_at, decided_at FROM mint_requests
         WHERE service = ? AND tool = ? AND paths = ? AND tier = ? AND ttl_seconds = ? AND status = 'pending'`,
        service,
        tool,
        paths.join(","),
        tier,
        ttlSeconds,
      )
      .toArray() as unknown as MintRequestRow[];
    return rows.length ? scanMintRequest(rows[0]) : null;
  }

  getMintRequest(id: string): MintRequest {
    const rows = this.sql
      .exec(
        "SELECT id, service, tool, paths, tier, ttl_seconds, status, created_at, decided_at FROM mint_requests WHERE id = ?",
        id,
      )
      .toArray() as unknown as MintRequestRow[];
    if (!rows.length) throw new NotFoundError(`mint request ${id}`);
    return scanMintRequest(rows[0]);
  }

  setMintRequestStatus(id: string, status: string): void {
    this.sql.exec("UPDATE mint_requests SET status = ? WHERE id = ?", status, id);
  }

  // --- Recent changes (M3.3, for the recent_changes tool) ---

  // recentChanges mirrors store.RecentChanges (Go): newest first by
  // creation time, rowid breaking ties — the revisions table is a
  // rowid table here just as in the Go SQLite store.
  recentChanges(limit: number): Revision[] {
    if (limit <= 0) limit = 20;
    const rows = this.sql
      .exec(
        `SELECT rev_id, page_path, parent_rev, author, token_jti, created_at
         FROM revisions ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        limit,
      )
      .toArray() as unknown as RevisionRow[];
    return rows.map((r) => ({
      revID: r.rev_id,
      pagePath: r.page_path,
      parentRev: r.parent_rev,
      author: r.author,
      tokenJTI: r.token_jti,
      createdAt: r.created_at,
    }));
  }

  // --- Policy ---

  // Policy lives in the meta table; absent rows yield the Go defaults
  // (internal/policy: max 3600s, default 1800s), checked at request
  // time — never baked into tokens beyond their claims.
  getPolicy(): { maxTTLSeconds: number; defaultTTLSeconds: number } {
    const read = (key: string, fallback: number): number => {
      const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray() as {
        value: string;
      }[];
      if (!rows.length) return fallback;
      const n = parseInt(rows[0].value, 10);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return {
      maxTTLSeconds: read("max_ttl_seconds", POLICY_CAP_TTL_SECONDS),
      defaultTTLSeconds: read("default_ttl_seconds", POLICY_DEFAULT_TTL_SECONDS),
    };
  }

  checkTTL(ttlSeconds: number): string | null {
    if (ttlSeconds <= 0) return "ttl must be positive";
    if (ttlSeconds > this.getPolicy().maxTTLSeconds) return "ttl exceeds policy maximum";
    return null;
  }
}

interface RevisionRow {
  rev_id: string;
  page_path: string;
  parent_rev: string;
  author: string;
  token_jti: string;
  created_at: string;
}

export interface Revision {
  revID: string;
  pagePath: string;
  parentRev: string;
  author: string;
  tokenJTI: string;
  createdAt: string;
}

interface ProposalRow {
  id: string;
  page_path: string;
  rev_id: string;
  base_version: number;
  status: string;
  token_jti: string;
  created_at: string;
}

export interface Proposal {
  id: string;
  pagePath: string;
  revID: string;
  baseVersion: number;
  status: string;
  tokenJTI: string;
  createdAt: string;
  content: string;
}

interface ServiceRow {
  name: string;
  cred_hash: string;
  ceiling_paths: string;
  tiers: string;
  max_ttl_seconds: number;
  revoked: number;
  created_at: string;
}

export interface Service {
  name: string;
  credHash: string;
  ceilingPaths: string[];
  tiers: string[];
  maxTTLSeconds: number;
  revoked: boolean;
  createdAt: string;
}

interface MintRequestRow {
  id: string;
  service: string;
  tool: string;
  paths: string;
  tier: string;
  ttl_seconds: number;
  status: string;
  created_at: string;
  decided_at: string;
}

export interface MintRequest {
  id: string;
  service: string;
  tool: string;
  paths: string[];
  tier: string;
  ttlSeconds: number;
  status: string;
  createdAt: string;
  decidedAt: string;
}

function scanMintRequest(r: MintRequestRow): MintRequest {
  return {
    id: r.id,
    service: r.service,
    tool: r.tool,
    paths: r.paths ? r.paths.split(",") : [],
    tier: r.tier,
    ttlSeconds: r.ttl_seconds,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}
