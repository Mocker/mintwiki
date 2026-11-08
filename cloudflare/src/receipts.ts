// Hash-chained receipts, ported from internal/receipts (Go). The chain
// rule is identical: an entry's hash is SHA-256 over the entry's
// canonical JSON with the hash field emptied, and each entry names the
// previous entry's hash. Entries live in a table in the wiki Durable
// Object's SQLite storage; the object's single-threaded execution
// serializes appends, replacing the Go log's mutex + re-read discipline.
//
// Canonical JSON must match Go's encoding/json output for the Entry
// struct byte-for-byte so a chain produced by one runtime verifies
// under the other: same field order, same omitempty behavior, and Go's
// HTML escaping of &, <, > inside strings.

export interface ReceiptEntry {
  time: string;
  actor: string;
  token_jti: string;
  scope: string;
  page: string;
  result: string; // applied | proposed | accepted | rejected
  reason?: string;
  rev_id?: string;
  before_version: number;
  after_version: number;
  proposal_id?: string;
  request_id?: string;
  prev_hash: string;
  hash: string;
}

export type ReceiptInput = Omit<ReceiptEntry, "time" | "prev_hash" | "hash">;

export async function sha256hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// rfc3339Seconds mirrors Go's time.RFC3339 formatting in UTC: seconds
// precision, trailing Z, no fractional part.
export function rfc3339Seconds(d = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// canonicalJSON reproduces Go's json.Marshal(Entry): fixed field order,
// omitempty fields dropped when empty, HTML characters escaped.
export function canonicalJSON(e: ReceiptEntry): string {
  const o: Record<string, unknown> = {};
  o.time = e.time;
  o.actor = e.actor;
  o.token_jti = e.token_jti;
  o.scope = e.scope;
  o.page = e.page;
  o.result = e.result;
  if (e.reason) o.reason = e.reason;
  if (e.rev_id) o.rev_id = e.rev_id;
  o.before_version = e.before_version;
  o.after_version = e.after_version;
  if (e.proposal_id) o.proposal_id = e.proposal_id;
  if (e.request_id) o.request_id = e.request_id;
  o.prev_hash = e.prev_hash;
  o.hash = e.hash;
  return JSON.stringify(o)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

export async function hashEntry(e: ReceiptEntry): Promise<string> {
  return sha256hex(canonicalJSON({ ...e, hash: "" }));
}

export class ReceiptLog {
  constructor(private sql: SqlStorage) {}

  private tailHash(): string {
    const rows = this.sql
      .exec("SELECT hash FROM receipts ORDER BY seq DESC LIMIT 1")
      .toArray() as { hash: string }[];
    return rows.length ? rows[0].hash : "";
  }

  async append(input: ReceiptInput): Promise<ReceiptEntry> {
    const entry: ReceiptEntry = {
      ...input,
      time: rfc3339Seconds(),
      prev_hash: this.tailHash(),
      hash: "",
    };
    entry.hash = await hashEntry(entry);
    this.sql.exec("INSERT INTO receipts(hash, body) VALUES(?, ?)", entry.hash, canonicalJSON(entry));
    return entry;
  }

  // verify walks the chain in append order, recomputing every hash and
  // checking each prev_hash link. Returns the entry count.
  async verify(): Promise<number> {
    const rows = this.sql.exec("SELECT body FROM receipts ORDER BY seq ASC").toArray() as {
      body: string;
    }[];
    let prev = "";
    for (const row of rows) {
      const e = JSON.parse(row.body) as ReceiptEntry;
      if (e.prev_hash !== prev) throw new Error(`receipt chain broken at ${e.hash}: prev_hash mismatch`);
      const h = await hashEntry(e);
      if (h !== e.hash) throw new Error(`receipt chain broken: stored hash mismatch at seq entry ${e.hash}`);
      prev = e.hash;
    }
    return rows.length;
  }
}
