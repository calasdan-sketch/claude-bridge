// Minimal JSON/HTTP API over the shared Store. Deliberately built on plain
// node:http rather than a framework (Express etc.) -- five endpoints don't
// need a router library, and every extra dependency is extra attack
// surface for a service that's about to be exposed over a public tunnel.
//
// Auth: single bearer token, checked on every route except /health.
// Format: `Authorization: Bearer <token>`.

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { Store, NoteInput, NotePatch, ValidationError } from "./store.js";
import { originAllowed, RateLimiter, clientKey, bearerMatches, LIMITS } from "./security.js";
import { DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard.js";
import { runSearch, parseMode, maybeEmbed } from "./search-service.js";

// Map a thrown error to an HTTP response: caller-input problems (ValidationError)
// return 400 with the message; anything unexpected logs server-side and returns
// a generic 500 so SQL/internal details never leak to the client.
function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof ValidationError) {
    sendJson(res, 400, { error: e.message });
  } else {
    console.error("[claude-bridge] write error:", (e as Error).message);
    sendJson(res, 500, { error: "internal error" });
  }
}

const MAX_BODY_BYTES = 1_000_000; // 1MB cap so a bad client can't OOM the process

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  let body = JSON.stringify(payload);
  // Cap response size so a huge store or broad query can't blow up an agent's
  // context window or the process memory.
  if (Buffer.byteLength(body) > LIMITS.responseBytes) {
    status = 413;
    body = JSON.stringify({
      error: "response too large; narrow the query or use a smaller limit",
    });
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // StringDecoder so a multi-byte char (emoji / Greek / CJK) split across
    // TCP chunks is decoded correctly instead of corrupted.
    const decoder = new StringDecoder("utf8");
    let data = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      data += decoder.write(chunk);
    });
    req.on("end", () => resolve(data + decoder.end()));
    req.on("error", reject);
  });
}

export function createApiServer(store: Store, token: string): Server {
  const limiter = new RateLimiter();
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // Health check is intentionally unauthenticated so infra (tunnel,
      // uptime monitor) can probe liveness without a credential.
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      // Dashboard UI (no data in the page itself; its fetches carry the token).
      if (req.method === "GET" && (path === "/" || path === "/ui")) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          // Keep the page self-contained: no external loads, no framing. Inline
          // styles/handlers are allowed because the dashboard uses them; this
          // still blocks exfiltration to third-party origins as a backstop to
          // the output escaping in dashboard.ts.
          "Content-Security-Policy":
            "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self' 'unsafe-inline'; connect-src 'self'; " +
            "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.method === "GET" && path === "/dashboard.js") {
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(DASHBOARD_JS);
        return;
      }

      // DNS-rebinding defense: block browser Origins not explicitly allowed.
      if (!originAllowed(req)) {
        sendJson(res, 403, { error: "origin not allowed" });
        return;
      }
      // Rate limit per client so a leaked token can't be hammered/brute-forced.
      if (!limiter.check(clientKey(req))) {
        sendJson(res, 429, { error: "rate limit exceeded" });
        return;
      }

      if (!bearerMatches(req, token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      // POST /notes
      if (req.method === "POST" && path === "/notes") {
        const raw = await readBody(req);
        let parsed: NoteInput;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!parsed.title || typeof parsed.title !== "string") {
          sendJson(res, 400, { error: "title is required" });
          return;
        }
        try {
          const note = store.create(parsed);
          await maybeEmbed(store, note);
          sendJson(res, 201, { note });
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      // GET /notes/:id
      const idMatch = /^\/notes\/(\d+)$/.exec(path);
      if (req.method === "GET" && idMatch) {
        const id = Number(idMatch[1]);
        const note = store.read(id);
        if (!note) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendJson(res, 200, { note });
        return;
      }

      // PUT /notes/:id
      if (req.method === "PUT" && idMatch) {
        const id = Number(idMatch[1]);
        const raw = await readBody(req);
        let parsed: NotePatch;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        try {
          const note = store.update(id, parsed);
          if (!note) {
            sendJson(res, 404, { error: "not found" });
            return;
          }
          await maybeEmbed(store, note);
          sendJson(res, 200, { note });
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      // DELETE /notes/:id
      if (req.method === "DELETE" && idMatch) {
        const id = Number(idMatch[1]);
        const removed = store.delete(id);
        if (!removed) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendJson(res, 200, { deleted: id });
        return;
      }

      // GET /notes?namespace=&limit=&offset=
      if (req.method === "GET" && path === "/notes") {
        const namespace = url.searchParams.get("namespace") ?? undefined;
        const limit = url.searchParams.get("limit");
        const offset = url.searchParams.get("offset");
        const result = store.list({
          namespace,
          limit: limit ? Number(limit) : undefined,
          offset: offset ? Number(offset) : undefined,
        });
        sendJson(res, 200, result);
        return;
      }

      // GET /search?q=&namespace=&limit=&mode=keyword|semantic|hybrid
      if (req.method === "GET" && path === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const namespace = url.searchParams.get("namespace") ?? undefined;
        const limit = url.searchParams.get("limit");
        if (!q.trim()) {
          sendJson(res, 400, { error: "q is required" });
          return;
        }
        const results = await runSearch(store, q, {
          namespace,
          limit: limit ? Number(limit) : undefined,
          mode: parseMode(url.searchParams.get("mode")),
        });
        sendJson(res, 200, { results });
        return;
      }

      // GET /export -> all notes, for backup / migration
      if (req.method === "GET" && path === "/export") {
        sendJson(res, 200, { notes: store.exportAll() });
        return;
      }

      // POST /import -> restore/seed from a backup: { notes: [...] }
      if (req.method === "POST" && path === "/import") {
        const raw = await readBody(req);
        let parsed: { notes?: NoteInput[] };
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!Array.isArray(parsed.notes)) {
          sendJson(res, 400, { error: "expected { notes: [...] }" });
          return;
        }
        try {
          const imported = store.importNotes(parsed.notes);
          sendJson(res, 200, { imported });
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      sendJson(res, 404, { error: "no such route" });
    } catch (e) {
      // Log details server-side; never leak internals (SQL errors, paths) out.
      console.error("[claude-bridge] request error:", (e as Error).message);
      sendJson(res, 500, { error: "internal error" });
    }
  });
}
