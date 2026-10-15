// Security helpers shared by the HTTP API and the MCP-over-HTTP server:
// input/size caps, a conservative "don't store secrets" scanner, DNS-rebinding
// (Origin) defense, a simple in-memory rate limiter, and an append-only audit
// log. All dependency-free on purpose -- this code sits in front of a service
// that can be exposed over a public tunnel, so less surface is safer.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";
import { PROJECT_ROOT, type Scope, type TokenEntry } from "./config.js";

// ---- Size caps (reject oversized input before it ever hits SQLite) ----------
export const LIMITS = {
  title: 2_000,
  body: 256_000, // 256KB per note body
  tagCount: 50,
  tagLen: 100,
  responseBytes: 2_000_000, // cap serialized list/search responses at ~2MB
};

export function checkSizes(input: {
  title?: string;
  body?: string;
  tags?: string[];
}): string | null {
  if (input.title !== undefined && input.title.length > LIMITS.title)
    return `title exceeds ${LIMITS.title} chars`;
  if (input.body !== undefined && input.body.length > LIMITS.body)
    return `body exceeds ${LIMITS.body} chars`;
  if (input.tags) {
    if (input.tags.length > LIMITS.tagCount)
      return `too many tags (max ${LIMITS.tagCount})`;
    for (const t of input.tags)
      if (t.length > LIMITS.tagLen) return `a tag exceeds ${LIMITS.tagLen} chars`;
  }
  return null;
}

// ---- Secret scanner: refuse to store high-confidence credentials ------------
// Conservative on purpose (few false positives). A memory store is exactly
// where people accidentally paste keys, and those would then sit in plaintext
// forever, so we reject rather than silently keep them.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["OpenAI/Anthropic key", /\b(?:sk|sk-ant)-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
];

/** Returns the label of a detected secret type, or null if none found. */
export function scanForSecrets(text: string | undefined): string | null {
  if (!text) return null;
  for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) return label;
  return null;
}

// ---- Origin check (DNS-rebinding defense for browser-based callers) ----------
// Non-browser clients (Claude Code, curl, the MCP SDK) send no Origin header --
// those are allowed. A browser sends Origin; we allow it only if explicitly
// listed in ONEMEMORY_ALLOWED_ORIGINS (comma-separated). Default: no
// browser origins allowed, which blocks a malicious web page from reaching a
// localhost/tunnelled server via DNS rebinding.
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers["origin"];
  if (!origin || Array.isArray(origin)) return true; // no Origin = non-browser
  // Same-origin (e.g. the built-in dashboard talking to its own server) is
  // always fine -- that's not a cross-site / DNS-rebinding attack.
  try {
    const host = req.headers["host"];
    if (host && new URL(origin).host === host) return true;
  } catch {
    /* malformed Origin falls through to the allowlist check */
  }
  const allowed = (process.env.ONEMEMORY_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

// ---- Rate limiter: fixed window per client key ------------------------------
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private max = Number(process.env.ONEMEMORY_RATE_MAX || 120),
    private windowMs = Number(process.env.ONEMEMORY_RATE_WINDOW_MS || 10_000)
  ) {}
  /** true = allowed, false = over limit. */
  check(key: string): boolean {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || now >= e.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now); // bound memory
      return true;
    }
    e.count += 1;
    return e.count <= this.max;
  }
  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
  }
}

export function clientKey(req: IncomingMessage): string {
  // Both cf-connecting-ip and x-forwarded-for are just request headers: a
  // client talking straight to the server (e.g. Tailscale or a direct bind)
  // can set either to any value, which would hand each forged value its own
  // rate-limit bucket and defeat the limiter. So trust a forwarded client IP
  // ONLY when the operator has declared they run behind that proxy:
  //   - ONEMEMORY_TRUST_CLOUDFLARE=1 -> trust cf-connecting-ip
  //   - ONEMEMORY_TRUST_PROXY=1      -> trust x-forwarded-for
  // Otherwise key on the real socket address, which cannot be spoofed.
  if (process.env.ONEMEMORY_TRUST_CLOUDFLARE === "1") {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf;
  }
  if (process.env.ONEMEMORY_TRUST_PROXY === "1") {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

// Constant-time string compare (used for bearer tokens).
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const SCOPE_RANK: Record<Scope, number> = { read: 1, write: 2, admin: 3 };

/** True if a principal holding `have` is allowed an action needing `need`. */
export function scopeAllows(have: Scope, need: Scope): boolean {
  return SCOPE_RANK[have] >= SCOPE_RANK[need];
}

/**
 * Authenticate a request against the accepted tokens and return the matched
 * token's scope, or null if the bearer header is missing/unknown. Shared by
 * both HTTP front doors so auth can't drift between them. Checks every token
 * with a constant-time compare.
 */
export function authenticate(req: IncomingMessage, tokens: TokenEntry[]): Scope | null {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const provided = match[1];
  let found: Scope | null = null;
  // Check all tokens (don't early-return) so timing doesn't reveal which
  // token, if any, matched.
  for (const t of tokens) {
    if (constantTimeEqual(provided, t.token)) found = t.scope;
  }
  return found;
}

// ---- Append-only audit log (no note content, no secrets) --------------------
const AUDIT_PATH =
  process.env.ONEMEMORY_AUDIT_LOG || join(PROJECT_ROOT, "data", "audit.log");

export function audit(entry: {
  op: string;
  id?: number;
  namespace?: string;
  bytes?: number;
}): void {
  try {
    mkdirSync(dirname(AUDIT_PATH), { recursive: true });
    appendFileSync(
      AUDIT_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
    );
  } catch {
    // Audit logging must never break a request.
  }
}
