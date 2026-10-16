// Minimal JSON/HTTP API over the shared Store. Deliberately built on plain
// node:http rather than a framework (Express etc.) -- five endpoints don't
// need a router library, and every extra dependency is extra attack
// surface for a service that's about to be exposed over a public tunnel.
//
// Auth: scoped bearer tokens (read/write/admin), checked on every route
// except the open /health and /ready probes and the dashboard page itself.
// Format: `Authorization: Bearer <token>`.

import { createServer, ServerResponse, Server } from "node:http";
import { Store, NoteInput, NotePatch, NoteRecord, ValidationError, clampInt } from "./store.js";
import { originAllowed, RateLimiter, clientKey, authenticate, scopeAllows, LIMITS } from "./security.js";
import { type Scope, type TokenEntry, TIME_ZONE } from "./config.js";
import { PayloadTooLargeError, readBody, normalizeTokens } from "./http-common.js";
import { DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard.js";
import { runSearch, parseMode, maybeEmbed, runRelevantSearch } from "./search-service.js";
import {
  type ServerNamespaceOpts,
  canRead,
  readableNamespaces,
} from "./namespace.js";
import { parseTimePhrase } from "./time-parse.js";
import { annotateStaleness } from "./staleness.js";

// Minimum scope a request needs: deletes, imports and full /export are admin,
// creates/updates are write, everything else (read/search/list) is read.
function requiredScope(method: string | undefined, path: string): Scope {
  if (method === "DELETE") return "admin";
  if (method === "POST" && path === "/import") return "admin";
  // A full-store dump is admin-only; a read token can still page /notes.
  if (method === "GET" && path === "/export") return "admin";
  // /relevant is a read despite the POST method (the message is a JSON body,
  // not a query string, because it can be long) -- same class as /search.
  if (method === "POST" && path === "/relevant") return "read";
  if (method === "POST" || method === "PUT") return "write";
  return "read";
}

// Map a thrown error to an HTTP response: caller-input problems (ValidationError)
// return 400 with the message; anything unexpected logs server-side and returns
// a generic 500 so SQL/internal details never leak to the client.
function sendError(res: ServerResponse, e: unknown): void {
  if (e instanceof ValidationError) {
    sendJson(res, 400, { error: e.message });
  } else {
    console.error("[onememory] write error:", (e as Error).message);
    sendJson(res, 500, { error: "internal error" });
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  opts: { cap?: boolean } = {}
): void {
  // Never write twice / to an already-finished response (e.g. after a client
  // aborted an oversized upload). Guard before touching headers.
  if (res.writableEnded || res.headersSent) return;
  let body = JSON.stringify(payload);
  // Cap response size so a huge store or broad query can't blow up an agent's
  // context window or the process memory. `/export` opts out (cap:false): it is
  // the explicit full-store backup path and must never be truncated.
  if (opts.cap !== false && Buffer.byteLength(body) > LIMITS.responseBytes) {
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

export function createApiServer(
  store: Store,
  token: string | TokenEntry[],
  opts: ServerNamespaceOpts = {}
): Server {
  const tokens = normalizeTokens(token);
  const limiter = new RateLimiter();

  // Server-side namespace resolution, active only when the entry point
  // resolved a namespace at startup (see resolveStartupNamespace). Mirrors
  // the MCP layer: writes are forced into the resolved namespace, reads
  // are limited to it plus its grants, and any client-supplied `namespace`
  // is an untrusted hint.
  const nsActive = typeof opts.namespace === "string" && opts.namespace.length > 0;
  const ownNs = opts.namespace ?? "";
  const grants = opts.readsFrom ?? {};
  const readable = (): string[] => readableNamespaces(ownNs, grants);
  const trustedHint = (hint: string | undefined): string | undefined =>
    hint && canRead(grants, ownNs, hint) ? hint : undefined;
  // 403 helper for a note outside the readable set.
  const denyUnreadable = (
    res: ServerResponse,
    note: NoteRecord | null
  ): note is NoteRecord => {
    if (!note) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    if (!canRead(grants, ownNs, note.namespace)) {
      sendJson(res, 403, { error: "access denied" });
      return false;
    }
    return true;
  };
  // List across every readable namespace, newest-first like store.list,
  // then paginate the merged pool.
  const listReadable = (
    limit?: number,
    offset?: number
  ): { notes: NoteRecord[]; total: number } => {
    const pool: NoteRecord[] = [];
    for (const ns of readable()) {
      pool.push(...store.list({ namespace: ns, limit: 500, offset: 0 }).notes);
    }
    pool.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
    const lim = clampInt(limit, 50, 1, 500);
    const off = clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return { notes: pool.slice(off, off + lim), total: pool.length };
  };

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

      // Everything past liveness goes through the DNS-rebinding Origin check and
      // the rate limiter first -- including /ready (which touches the DB) and
      // the dashboard, so an unauthenticated client can't hammer either.
      if (!originAllowed(req)) {
        sendJson(res, 403, { error: "origin not allowed" });
        return;
      }
      if (!limiter.check(clientKey(req))) {
        sendJson(res, 429, { error: "rate limit exceeded" });
        return;
      }

      // Readiness: unlike /health (liveness), this actually touches the DB so
      // an orchestrator/tunnel can tell a half-broken store from a live one.
      if (req.method === "GET" && path === "/ready") {
        try {
          store.list({ limit: 1 });
          sendJson(res, 200, { status: "ready" });
        } catch {
          sendJson(res, 503, { status: "unavailable" });
        }
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

      const scope = authenticate(req, tokens);
      if (!scope) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      // Enforce the token's scope: a read-only token can't write/delete, etc.
      const need = requiredScope(req.method, path);
      if (!scopeAllows(scope, need)) {
        sendJson(res, 403, { error: `this token lacks the required '${need}' scope` });
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
          // When namespace resolution is active the client-supplied namespace
          // is untrusted: writes always land in the server-resolved namespace.
          if (nsActive) parsed.namespace = ownNs;
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
        if (nsActive) {
          // Read access follows the same rule as the MCP state_read tool.
          if (!denyUnreadable(res, note)) return;
          sendJson(res, 200, { note: annotateStaleness(note) });
          return;
        }
        if (!note) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendJson(res, 200, { note: annotateStaleness(note) });
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
          if (nsActive) {
            // The client-supplied namespace is dropped (the note keeps its
            // existing namespace), and the note must live in a readable
            // namespace -- otherwise a PUT by id could rewrite another
            // project's notes.
            const existing = store.read(id);
            if (!denyUnreadable(res, existing)) return;
            delete parsed.namespace;
          }
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
        if (nsActive) {
          // Same access rule as the MCP state_delete tool.
          if (!denyUnreadable(res, store.read(id))) return;
        }
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
        if (nsActive) {
          // Untrusted hint intersected with the readable set, like the MCP
          // state_list tool.
          const hint = trustedHint(namespace);
          const result = hint
            ? store.list({
                namespace: hint,
                limit: limit ? Number(limit) : undefined,
                offset: offset ? Number(offset) : undefined,
              })
            : listReadable(
                limit ? Number(limit) : undefined,
                offset ? Number(offset) : undefined
              );
          sendJson(res, 200, result);
          return;
        }
        const result = store.list({
          namespace,
          limit: limit ? Number(limit) : undefined,
          offset: offset ? Number(offset) : undefined,
        });
        sendJson(res, 200, result);
        return;
      }

      // GET /search?q=&namespace=&limit=&mode=keyword|semantic|hybrid&when=
      if (req.method === "GET" && path === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const namespace = url.searchParams.get("namespace") ?? undefined;
        const limit = url.searchParams.get("limit");
        const whenRaw = url.searchParams.get("when") ?? undefined;
        // Like the MCP tool, an unrecognized time phrase is ignored rather
        // than an error -- the query still runs unscoped.
        const timePhrase = whenRaw ? parseTimePhrase(whenRaw, { timeZone: TIME_ZONE }) : null;
        if (!q.trim() && !timePhrase) {
          sendJson(res, 400, { error: "q is required" });
          return;
        }
        if (nsActive) {
          // Untrusted hint intersected with the readable set, like the MCP
          // state_search tool: fan out over every readable namespace when
          // the hint is missing or names something unreadable.
          const hint = trustedHint(namespace);
          const searchOpts = {
            limit: limit ? Number(limit) : undefined,
            mode: parseMode(url.searchParams.get("mode")),
            timeRange: timePhrase ? { start: timePhrase.start, end: timePhrase.end } : undefined,
          };
          let results;
          if (hint) {
            results = await runSearch(store, q, { ...searchOpts, namespace: hint });
          } else {
            const seen = new Set<number>();
            const merged: NoteRecord[] = [];
            for (const ns of readable()) {
              const hits = await runSearch(store, q, { ...searchOpts, namespace: ns });
              for (const h of hits) {
                if (!seen.has(h.id)) {
                  seen.add(h.id);
                  merged.push(h);
                }
              }
            }
            const lim = clampInt(searchOpts.limit, 20, 1, 200);
            results = merged.slice(0, lim);
          }
          // Hits carry their staleness fields (stale/ageDays, plus
          // staleWarning when stale) like the MCP state_search tool.
          sendJson(res, 200, { results: results.map((n) => annotateStaleness(n)) });
          return;
        }
        const results = await runSearch(store, q, {
          namespace,
          limit: limit ? Number(limit) : undefined,
          mode: parseMode(url.searchParams.get("mode")),
          timeRange: timePhrase ? { start: timePhrase.start, end: timePhrase.end } : undefined,
        });
        sendJson(res, 200, { results: results.map((n) => annotateStaleness(n)) });
        return;
      }

      // POST /relevant { message, limit?, namespace? } -> { keywords, results }
      // Mirrors the state_relevant MCP tool: keyword extraction from a
      // natural-language message, then a permissive (any-single-keyword-hit)
      // search. Namespace gating matches GET /search exactly.
      if (req.method === "POST" && path === "/relevant") {
        const raw = await readBody(req);
        let parsed: { message?: unknown; limit?: unknown; namespace?: unknown };
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (typeof parsed.message !== "string" || !parsed.message.trim()) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }
        // Same default as the MCP tool: a relevance probe returns a handful
        // of notes, not a page.
        const relLimit = typeof parsed.limit === "number" ? parsed.limit : 5;
        const relNs = typeof parsed.namespace === "string" ? parsed.namespace : undefined;
        if (nsActive) {
          // Untrusted hint intersected with the readable set, like GET
          // /search: fan out over every readable namespace when the hint is
          // missing or names something unreadable.
          const hint = trustedHint(relNs);
          if (hint) {
            sendJson(
              res,
              200,
              await runRelevantSearch(store, parsed.message, {
                namespace: hint,
                limit: relLimit,
              })
            );
            return;
          }
          const seen = new Set<number>();
          const merged: NoteRecord[] = [];
          let keywords: string[] = [];
          for (const ns of readable()) {
            const r = await runRelevantSearch(store, parsed.message, {
              namespace: ns,
              limit: relLimit,
            });
            keywords = r.keywords; // identical per namespace (from the message)
            for (const n of r.results) {
              if (!seen.has(n.id)) {
                seen.add(n.id);
                merged.push(n);
              }
            }
          }
          const lim = clampInt(relLimit, 10, 1, 200);
          sendJson(res, 200, { keywords, results: merged.slice(0, lim) });
          return;
        }
        sendJson(
          res,
          200,
          await runRelevantSearch(store, parsed.message, {
            namespace: relNs,
            limit: relLimit,
          })
        );
        return;
      }

      // GET /export -> all notes, for backup / migration. Exempt from the
      // response-size cap: a backup must dump the whole store, not a truncated
      // slice (there are no narrowing params on /export).
      if (req.method === "GET" && path === "/export") {
        sendJson(res, 200, { notes: store.exportAll() }, { cap: false });
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
          const created = store.importNotes(parsed.notes);
          // Best-effort: index the restored notes for semantic/hybrid search
          // (no-op when embeddings are off). Without this, re-imported notes
          // would be invisible to semantic search until a manual `reindex`.
          for (const note of created) await maybeEmbed(store, note);
          sendJson(res, 200, { imported: created.length });
        } catch (e) {
          sendError(res, e);
        }
        return;
      }

      sendJson(res, 404, { error: "no such route" });
    } catch (e) {
      // A body over the 1MB cap is a client problem -> 413, not a generic 500.
      if (e instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }
      // Log details server-side; never leak internals (SQL errors, paths) out.
      console.error("[onememory] request error:", (e as Error).message);
      sendJson(res, 500, { error: "internal error" });
    }
  });
}
