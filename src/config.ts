// Shared config: DB path + bearer token, used by the HTTP API, the stdio
// MCP server, and the HTTP/SSE MCP server so all three point at the same
// state file and accept the same token.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTimeZone } from "./time-parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..", "..");

export const DB_PATH =
  process.env.ONEMEMORY_DB_PATH || join(PROJECT_ROOT, "data", "state.db");

const TOKEN_FILE = join(PROJECT_ROOT, "data", ".token");

/**
 * Resolve the bearer token: env var wins; otherwise read/create a token
 * file on disk so the token is stable across restarts without forcing the
 * operator to set an env var every time.
 */
export function resolveToken(): string {
  if (process.env.ONEMEMORY_TOKEN && process.env.ONEMEMORY_TOKEN.trim()) {
    return process.env.ONEMEMORY_TOKEN.trim();
  }
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  // Never print the token value itself -- this line may be captured by a
  // Windows Scheduled Task's redirected output, a service manager's logs, or
  // future log-shipping, and the token is a full-access credential valid
  // over the public tunnel. Reference only the file path it was saved to.
  // eslint-disable-next-line no-console
  console.error(`[onememory] Generated new bearer token, saved to ${TOKEN_FILE}`);
  return token;
}

/**
 * Access scopes, least to most powerful:
 *   read  -> read/search/list
 *   write -> read + create/update
 *   admin -> write + delete + import + full /export  (primary token is admin)
 */
export type Scope = "read" | "write" | "admin";

export interface TokenEntry {
  token: string;
  scope: Scope;
  label: string;
}

function isScope(s: unknown): s is Scope {
  return s === "read" || s === "write" || s === "admin";
}

/**
 * All accepted bearer tokens with their scope. The primary token
 * (ONEMEMORY_TOKEN or data/.token) is always admin, so single-token
 * setups behave exactly as before. Extra scoped tokens are optional and come
 * from ONEMEMORY_TOKENS (a JSON array) and/or a data/tokens.json file,
 * each entry { "token": "...", "scope": "read|write|admin", "label": "..." }.
 * Invalid or duplicate entries are skipped rather than failing startup.
 */
const SCOPE_RANK: Record<Scope, number> = { read: 1, write: 2, admin: 3 };

export function resolveTokens(): TokenEntry[] {
  const byToken = new Map<string, TokenEntry>();
  const locked = new Set<string>(); // the primary admin token's scope is fixed
  const add = (token: unknown, scope: unknown, label: unknown, lock = false): void => {
    if (typeof token !== "string" || !token.trim()) return;
    if (!isScope(scope)) return;
    const t = token.trim();
    const existing = byToken.get(t);
    if (existing) {
      // Never downgrade/change the primary token. For any other token listed
      // more than once, keep the MOST restrictive scope (lowest rank).
      if (!locked.has(t) && SCOPE_RANK[scope] < SCOPE_RANK[existing.scope]) {
        byToken.set(t, { token: t, scope, label: typeof label === "string" ? label : "" });
      }
      return;
    }
    byToken.set(t, { token: t, scope, label: typeof label === "string" ? label : "" });
    if (lock) locked.add(t);
  };

  // Primary token is always admin (keeps single-token setups unchanged).
  try {
    add(resolveToken(), "admin", "primary", true);
  } catch {
    /* no primary token available (e.g. doctor on a fresh box) */
  }

  const parseList = (raw: string, where: string): void => {
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      console.error(`[onememory] ignoring ${where}: not valid JSON`);
      return;
    }
    if (!Array.isArray(arr)) {
      console.error(
        `[onememory] ignoring ${where}: expected a JSON array of { token, scope, label }`
      );
      return;
    }
    for (const e of arr) {
      const o = e as { token?: unknown; scope?: unknown; label?: unknown };
      add(o?.token, o?.scope, o?.label);
    }
  };

  if (process.env.ONEMEMORY_TOKENS && process.env.ONEMEMORY_TOKENS.trim()) {
    parseList(process.env.ONEMEMORY_TOKENS, "ONEMEMORY_TOKENS");
  }
  const tokensFile = join(PROJECT_ROOT, "data", "tokens.json");
  if (existsSync(tokensFile)) {
    parseList(readFileSync(tokensFile, "utf8"), "data/tokens.json");
  }

  return [...byToken.values()];
}

// Parse a port from the environment, falling back (loudly) on anything that
// isn't a valid 1-65535 integer so a typo can't make listen() pick a random port.
function parsePort(envVal: string | undefined, def: number): number {
  if (!envVal) return def;
  const n = Number(envVal);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[onememory] invalid port "${envVal}"; falling back to ${def}`);
    return def;
  }
  return n;
}

export const API_PORT = parsePort(process.env.ONEMEMORY_PORT, 8790);
export const MCP_HTTP_PORT = parsePort(process.env.ONEMEMORY_MCP_PORT, 8791);

// Bind to loopback by default. Public exposure is opt-in and is expected to
// sit behind an authenticated tunnel (e.g. Cloudflare Tunnel + Access).
export const BIND_HOST = process.env.ONEMEMORY_BIND || "127.0.0.1";

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Parse a human interval like "24h", "30m", "90s", or a bare number of
 * seconds ("3600") into milliseconds. Returns null for anything else
 * (empty, garbage, negative). Bare numbers mean seconds — that matches how
 * operators already write timeout-ish env vars.
 */
export function parseIntervalToMs(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(n * mult[m[2] ?? "s"]);
}

/**
 * How often the background auto-consolidation runs (see start.ts). Unset =
 * off. The scheduler only auto-merges near-identical pairs (score >= 0.99);
 * weaker candidates are logged for review, never merged blindly.
 */
export const AUTO_CONSOLIDATE_INTERVAL_MS = parseIntervalToMs(
  process.env.ONEMEMORY_AUTO_CONSOLIDATE_INTERVAL
);

/**
 * Fail closed: never open a non-loopback listener without an explicit token.
 * An auto-generated token is fine for a local-only server, but if the
 * operator binds to a public interface they must set ONEMEMORY_TOKEN
 * deliberately rather than relying on an auto-minted one.
 */
export function assertSafeExposure(): void {
  // Read the bind host from the environment here (not the cached BIND_HOST
  // constant) so this guard reflects the actual configured bind and stays
  // unit-testable. Default matches BIND_HOST.
  const bind = process.env.ONEMEMORY_BIND || "127.0.0.1";
  const hasExplicitToken = !!(
    process.env.ONEMEMORY_TOKEN && process.env.ONEMEMORY_TOKEN.trim()
  );
  if (!isLoopback(bind) && !hasExplicitToken) {
    throw new Error(
      "Refusing to bind to a non-loopback address without ONEMEMORY_TOKEN set. " +
        "Set an explicit token, or keep the default localhost bind and expose it " +
        "through an authenticated tunnel (see INFRA.md)."
    );
  }
}

/**
 * IANA timezone used to interpret natural-language time phrases
 * ("yesterday", "last week") in time-aware search. Set ONEMEMORY_TIMEZONE,
 * e.g. ONEMEMORY_TIMEZONE=America/Winnipeg. Invalid names log to stderr and
 * fall back to "UTC" (never throw at import time).
 */
export const TIME_ZONE = resolveTimeZone(process.env.ONEMEMORY_TIMEZONE);
