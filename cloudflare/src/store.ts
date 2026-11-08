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
}
