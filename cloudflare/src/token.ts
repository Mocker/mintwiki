// Edit tokens, ported from internal/token (Go): HMAC-SHA256 JWTs
// carrying an enumerated scope (one tool + path patterns), a tier
// (allow | approve), a unique jti for revocation, and a short expiry.
// Exactly one signing secret with exactly one purpose — here the
// SIGNING_SECRET Worker secret, holding the same hex-encoded key the
// Go runtime keeps in its signing.key file, so a token minted by
// either runtime verifies on the other (proven in the test suite).
//
// Verification is signature/expiry only; the registry (minted here?)
// and revocation checks need the store and happen in lane.ts, in the
// same order as the Go server.

import { sha256hex } from "./receipts";

export const ISSUER = "mintwiki";
export const AUDIENCE = "mintwiki";
export const TOOL_EDIT = "edit_page";
export const TIER_ALLOW = "allow";
export const TIER_APPROVE = "approve";

export interface Claims {
  tool: string;
  paths: string[];
  tier: string;
  actor: string;
  jti: string;
  exp: number; // unix seconds
  iat: number;
}

export function scopeString(c: Claims): string {
  return `${c.tool}:${c.paths.join(",")}`;
}

function matchPattern(pattern: string, path: string): boolean {
  pattern = pattern.replace(/^\//, "");
  path = path.replace(/^\//, "");
  if (pattern === "**") return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(prefix + "/");
  }
  return pattern === path;
}

export function coversPath(c: Claims, path: string): boolean {
  return c.paths.some((pat) => matchPattern(pat, path));
}

// coversPattern mirrors token.CoversPattern (Go): whether a ceiling
// pattern covers a requested pattern — the exchange's subset check.
export function coversPattern(ceilingPattern: string, requestedPattern: string): boolean {
  const c = ceilingPattern.replace(/^\//, "");
  const r = requestedPattern.replace(/^\//, "");
  if (c === "**") return true;
  if (c.endsWith("/**")) {
    const prefix = c.slice(0, -3);
    return r === prefix || r === prefix + "/**" || r.startsWith(prefix + "/");
  }
  return c === r;
}

export function withinCeiling(ceiling: string[], requested: string[]): boolean {
  return requested.every((r) => ceiling.some((c) => coversPattern(c, r)));
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function keyBytesFromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("signing secret is not valid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export function newJTI(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// mint creates a signed token. It does not register the jti — the
// caller records it in the store so it can later be revoked (same
// split as the Go minter).
export async function mint(
  keyBytes: Uint8Array,
  actor: string,
  tool: string,
  paths: string[],
  tier: string,
  ttlSeconds: number,
): Promise<{ token: string; claims: Claims }> {
  if (tool !== TOOL_EDIT) throw new Error(`unknown tool ${JSON.stringify(tool)}`);
  if (tier !== TIER_ALLOW && tier !== TIER_APPROVE) throw new Error(`unknown tier ${JSON.stringify(tier)}`);
  if (paths.length === 0) throw new Error("token needs at least one path pattern");
  const now = Math.floor(Date.now() / 1000);
  const claims: Claims = {
    tool,
    paths,
    tier,
    actor,
    jti: newJTI(),
    exp: now + ttlSeconds,
    iat: now,
  };
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        exp: claims.exp,
        iat: claims.iat,
        jti: claims.jti,
        tool: claims.tool,
        paths: claims.paths,
        tier: claims.tier,
        actor: claims.actor,
      }),
    ),
  );
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(keyBytes), new TextEncoder().encode(`${header}.${payload}`));
  return { token: `${header}.${payload}.${b64urlEncode(new Uint8Array(sig))}`, claims };
}

// parse verifies signature, issuer, audience and expiry, in that
// order — mirroring token.Parse (Go). Revocation and scope are the
// caller's checks.
export async function parse(keyBytes: Uint8Array, tokenStr: string): Promise<Claims> {
  const parts = tokenStr.split(".");
  if (parts.length !== 3) throw new Error("token is not a JWT");
  const [h, p, s] = parts;
  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    throw new Error("token is not valid JSON");
  }
  if (header.alg !== "HS256") throw new Error(`unexpected signing method ${header.alg}`);
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(keyBytes),
    b64urlDecode(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("signature invalid");
  if (payload.iss !== ISSUER) throw new Error("invalid issuer");
  const aud = payload.aud;
  const audOK = aud === AUDIENCE || (Array.isArray(aud) && aud.includes(AUDIENCE));
  if (!audOK) throw new Error("invalid audience");
  if (typeof payload.exp !== "number") throw new Error("expiry required");
  if (payload.exp <= Math.floor(Date.now() / 1000)) throw new Error("token expired");
  return {
    tool: String(payload.tool ?? ""),
    paths: Array.isArray(payload.paths) ? payload.paths.map(String) : [],
    tier: String(payload.tier ?? ""),
    actor: String(payload.actor ?? ""),
    jti: String(payload.jti ?? ""),
    exp: payload.exp,
    iat: typeof payload.iat === "number" ? payload.iat : 0,
  };
}

// hashCredential mirrors store.HashCredential (Go): SHA-256 hex of the
// raw service credential. The raw credential is shown once at
// registration and never persisted.
export async function hashCredential(cred: string): Promise<string> {
  return sha256hex(new TextEncoder().encode(cred));
}

// newServiceCredential mirrors the Go CLI's service add: "mwsvc_" +
// hex of 32 random bytes.
export function newServiceCredential(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "mwsvc_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
