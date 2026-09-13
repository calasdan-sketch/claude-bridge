// Shared config: DB path + bearer token, used by the HTTP API, the stdio
// MCP server, and the HTTP/SSE MCP server so all three point at the same
// state file and accept the same token.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..", "..");

export const DB_PATH =
  process.env.CLAUDE_BRIDGE_DB_PATH || join(PROJECT_ROOT, "data", "state.db");

const TOKEN_FILE = join(PROJECT_ROOT, "data", ".token");

/**
 * Resolve the bearer token: env var wins; otherwise read/create a token
 * file on disk so the token is stable across restarts without forcing the
 * operator to set an env var every time.
 */
export function resolveToken(): string {
  if (process.env.CLAUDE_BRIDGE_TOKEN && process.env.CLAUDE_BRIDGE_TOKEN.trim()) {
    return process.env.CLAUDE_BRIDGE_TOKEN.trim();
  }
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  // eslint-disable-next-line no-console
  console.error(
    `[claude-bridge] Generated new bearer token, saved to ${TOKEN_FILE}\n` +
      `[claude-bridge] Token: ${token}`
  );
  return token;
}

export const API_PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 8790);
export const MCP_HTTP_PORT = Number(process.env.CLAUDE_BRIDGE_MCP_PORT || 8791);
