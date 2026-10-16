// Small helpers shared by the two HTTP front doors (the REST API and the
// MCP-over-HTTP server) so their request handling can't drift: one body-size
// cap, one body reader with one error type, and one token normalizer.

import type { IncomingMessage, Server } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { type TokenEntry } from "./config.js";

// 1MB cap so a bad client can't OOM the process. Shared by both servers.
export const MAX_BODY_BYTES = 1_000_000;

// Thrown by readBody when a request body exceeds MAX_BODY_BYTES, so each
// handler can answer 413 (payload too large) instead of a generic 500.
export class PayloadTooLargeError extends Error {}

/**
 * Read a request body to a string, capped at MAX_BODY_BYTES. Uses StringDecoder
 * so a multi-byte char (emoji / Greek / CJK) split across TCP chunks is decoded
 * correctly rather than corrupted. On overflow it rejects with
 * PayloadTooLargeError and stops buffering (memory stays bounded); it does NOT
 * destroy the socket, so the handler can still deliver a 413 response rather
 * than resetting the connection.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let data = "";
    let bytes = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return; // past the cap: drain remaining chunks without buffering
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        over = true;
        reject(new PayloadTooLargeError("payload too large"));
        return;
      }
      data += decoder.write(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(data + decoder.end());
    });
    req.on("error", reject);
  });
}

// Accept either the historical single admin token (a string) or a scoped list.
export function normalizeTokens(token: string | TokenEntry[]): TokenEntry[] {
  return typeof token === "string" ? [{ token, scope: "admin", label: "primary" }] : token;
}

/**
 * A listen error (port taken, no permission) is an operator problem, not a
 * crash: print what to do and exit 1 instead of an unhandled 'error' stack.
 */
export function exitOnListenError(server: Server, port: number, envVar: string, what: string): Server {
  return server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(
        `[onememory] ${what} port ${port} is already in use -- is OneMemory (or something else) already running? ` +
          `Stop it, or pick another port with ${envVar}=<port>.`
      );
    } else if (e.code === "EACCES") {
      console.error(`[onememory] no permission to listen on ${what} port ${port}; pick another with ${envVar}=<port>.`);
    } else {
      console.error(`[onememory] ${what} server failed to listen on port ${port}: ${e.message}`);
    }
    process.exit(1);
  });
}
