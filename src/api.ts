// Minimal JSON/HTTP API over the shared Store. Deliberately built on plain
// node:http rather than a framework (Express etc.) -- five endpoints don't
// need a router library, and every extra dependency is extra attack
// surface for a service that's about to be exposed over a public tunnel.
//
// Auth: scoped bearer tokens (read/write/admin), checked on every route
// except the open /health and /ready probes and the dashboard page itself.
// Format: `Authorization: Bearer <token>`.

import { createServer, ServerResponse, Server } from "node:http";
import {
  Store,
  NoteInput,
  NotePatch,
  NoteRecord,
  ValidationError,
  RebuildBusyError,
  clampInt,
  resolveEdgeThreshold,
  REBUILD_CONFIRM_NOTE_COUNT,
} from "./store.js";
import { originAllowed, RateLimiter, clientKey, authenticate, scopeAllows, LIMITS } from "./security.js";
import { type Scope, type TokenEntry, TIME_ZONE, PROJECT_ROOT } from "./config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The phone command page (docs/sign.html + docs/signer.js) is served from the
// API's own origin so a phone browser can POST /notes without a cross-origin
// request. Read once and cached; missing files simply 404.
// Off by default: the runner ships separately from the memory package, so a
// plain memory install exposes nothing runner-related. Set
// ONEMEMORY_ENABLE_SIGN_PAGE=1 to serve it; otherwise both paths 404.
const SIGN_PAGES: Record<string, { file: string; type: string }> = {
  "/sign": { file: "sign.html", type: "text/html; charset=utf-8" },
  "/signer.js": { file: "signer.js", type: "application/javascript; charset=utf-8" },
};
const signCache = new Map<string, string | null>();
function signAsset(file: string): string | null {
  if (process.env.ONEMEMORY_ENABLE_SIGN_PAGE !== "1") return null;
  if (!signCache.has(file)) {
    try {
      signCache.set(file, readFileSync(join(PROJECT_ROOT, "docs", file), "utf8"));
    } catch {
      signCache.set(file, null);
    }
  }
  return signCache.get(file) ?? null;
}
import { PayloadTooLargeError, readBody, normalizeTokens } from "./http-common.js";
import { DASHBOARD_HTML, DASHBOARD_JS } from "./dashboard.js";
import { runSearch, parseMode, maybeEmbed, runRelevantSearch, roundRobin } from "./search-service.js";
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
  // /rebuild-edges rewrites the similarity graph: admin-only, like delete.
  if (method === "POST" && path === "/rebuild-edges") return "admin";
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
  // 404 helper for a note outside the readable set (or missing): a distinct
  // 403 would let the caller probe which ids exist in other namespaces.
  // When namespace resolution is inactive there is no readable set to
  // enforce -- every note is readable (legacy behavior).
  const denyUnreadable = (
    res: ServerResponse,
    note: NoteRecord | null
  ): note is NoteRecord => {
    if (!note) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    if (nsActive && !canRead(grants, ownNs, note.namespace)) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    return true;
  };
  // Write/delete access never crosses namespaces: the note must live in the
  // server's own namespace (a read grant confers no write access). Uniform
  // 404 again, so cross-namespace writes are no existence oracle either.
  const denyUnwritable = (
    res: ServerResponse,
    note: NoteRecord | null
  ): note is NoteRecord => {
    if (!note || note.namespace !== ownNs) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    return true;
  };
  // List across every readable namespace, newest-first like store.list,
  // paged in SQL so total and deep offsets are exact.
  const listReadable = (
    limit?: number,
    offset?: number
  ): { notes: NoteRecord[]; total: number } =>
    store.list({ namespaces: readable(), limit, offset });

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
      // Phone command signer. No data in it; the secret never leaves the phone,
      // and its POST still needs a bearer token like any other write.
      if (req.method === "GET" && SIGN_PAGES[path]) {
        const asset = SIGN_PAGES[path];
        const body = signAsset(asset.file);
        if (body === null) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": asset.type,
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end(body);
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
        // BLOCKER 4: gate before tracking. The probe is an untracked read
        // (no writes, no neighbor work); only an authorized read bumps the
        // access counters, so a denied cross-namespace read can't pollute
        // importance weighting or search ranking. Without namespace
        // resolution there is no cross-namespace boundary, so the probe is
        // just a 404 check (denyUnreadable's canRead gate would 404 every
        // read when ownNs is "").
        const probe = store.read(id);
        if (nsActive) {
          if (!denyUnreadable(res, probe)) return;
        } else if (!probe) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        // Authorized: re-read with tracking so the returned counters
        // include this read (same response contract as before).
        // ?neighbors=true attaches up to 10 same-namespace similar notes
        // with similarity scores (and their staleness fields), mirroring
        // the MCP state_read neighbors:true option.
        const withNeighbors = url.searchParams.get("neighbors") === "true";
        const note = store.read(id, { trackAccess: true, withNeighbors });
        if (!note) {
          // Unreachable single-threaded (the probe just saw it); the type
          // checker can't know that after the second read.
          sendJson(res, 404, { error: "not found" });
          return;
        }
        // Round edge scores to 3 decimals for readability (stored raw in
        // SQLite), mirroring the MCP state_read tool. Neighbor entries
        // already carry their staleness fields (annotated in Store.read).
        const base = annotateStaleness(note);
        const outNote = note.neighbors
          ? {
              ...base,
              neighbors: note.neighbors.map((n) => ({
                ...n,
                score: Math.round(n.score * 1000) / 1000,
              })),
            }
          : base;
        sendJson(res, 200, { note: outNote });
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
            // existing namespace), and the note must live in the server's
            // own namespace -- otherwise a PUT by id could rewrite a granted
            // namespace's notes (grants are read-only).
            const existing = store.read(id);
            if (!denyUnwritable(res, existing)) return;
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
          // Same own-namespace rule as the MCP state_delete tool: a read
          // grant never confers delete access.
          if (!denyUnwritable(res, store.read(id))) return;
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
          if (hint) {
            const result = store.list({
              namespace: hint,
              limit: limit ? Number(limit) : undefined,
              offset: offset ? Number(offset) : undefined,
            });
            sendJson(res, 200, { ...result, searchedNamespaces: [hint] });
            return;
          }
          sendJson(res, 200, {
            ...listReadable(
              limit ? Number(limit) : undefined,
              offset ? Number(offset) : undefined
            ),
            searchedNamespaces: readable(),
          });
          return;
        }
        const result = store.list({
          namespace,
          limit: limit ? Number(limit) : undefined,
          offset: offset ? Number(offset) : undefined,
        });
        sendJson(res, 200, {
          ...result,
          searchedNamespaces: namespace ? [namespace] : [],
        });
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
          // the hint is missing or names something unreadable. The
          // per-namespace lists merge round-robin so a later namespace is
          // never starved by an earlier one's hits.
          const hint = trustedHint(namespace);
          const searchOpts = {
            limit: limit ? Number(limit) : undefined,
            mode: parseMode(url.searchParams.get("mode")),
            timeRange: timePhrase ? { start: timePhrase.start, end: timePhrase.end } : undefined,
          };
          // timeRange surfaces how `when` was interpreted (null = unscoped).
          // Hits carry their staleness fields (stale/ageDays, plus
          // staleWarning when stale) like the MCP state_search tool.
          // searchedNamespaces echoes which namespaces were actually
          // searched (an unreadable hint silently falls back to the
          // readable set -- the caller should know).
          if (hint) {
            const results = await runSearch(store, q, { ...searchOpts, namespace: hint });
            sendJson(res, 200, {
              results: results.map((n) => annotateStaleness(n)),
              timeRange: timePhrase ? timePhrase.label : null,
              searchedNamespaces: [hint],
            });
            return;
          }
          const lists: NoteRecord[][] = [];
          for (const ns of readable()) {
            lists.push(await runSearch(store, q, { ...searchOpts, namespace: ns }));
          }
          const lim = clampInt(searchOpts.limit, 20, 1, 200);
          sendJson(res, 200, {
            results: roundRobin(lists, lim).map((n) => annotateStaleness(n)),
            timeRange: timePhrase ? timePhrase.label : null,
            searchedNamespaces: readable(),
          });
          return;
        }
        const results = await runSearch(store, q, {
          namespace,
          limit: limit ? Number(limit) : undefined,
          mode: parseMode(url.searchParams.get("mode")),
          timeRange: timePhrase ? { start: timePhrase.start, end: timePhrase.end } : undefined,
        });
        sendJson(res, 200, {
          results: results.map((n) => annotateStaleness(n)),
          timeRange: timePhrase ? timePhrase.label : null,
          searchedNamespaces: namespace ? [namespace] : [],
        });
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
        // The MCP schema requires an integer limit; the REST layer used to
        // accept floats (floored) and strings (defaulted). Reject
        // non-integers with a 400 so both surfaces validate identically.
        if (parsed.limit !== undefined && !Number.isInteger(parsed.limit)) {
          sendJson(res, 400, { error: "limit must be an integer" });
          return;
        }
        // Same default as the MCP tool: a relevance probe returns a handful
        // of notes, not a page.
        const relLimit = typeof parsed.limit === "number" ? parsed.limit : 5;
        const relNs = typeof parsed.namespace === "string" ? parsed.namespace : undefined;
        // Results carry the same staleness fields as /search (the
        // vague-message path is the most likely to act on outdated facts).
        const withStaleness = (r: { keywords: string[]; results: NoteRecord[] }) => ({
          keywords: r.keywords,
          results: r.results.map((n) => annotateStaleness(n)),
        });
        if (nsActive) {
          // Untrusted hint intersected with the readable set, like GET
          // /search: fan out over every readable namespace when the hint is
          // missing or names something unreadable. Round-robin merge so a
          // later namespace is never starved; searchedNamespaces echoes the
          // namespaces actually searched.
          const hint = trustedHint(relNs);
          if (hint) {
            const out = await runRelevantSearch(store, parsed.message, {
              namespace: hint,
              limit: relLimit,
            });
            sendJson(res, 200, {
              ...withStaleness(out),
              searchedNamespaces: [hint],
            });
            return;
          }
          const lists: NoteRecord[][] = [];
          let keywords: string[] = [];
          for (const ns of readable()) {
            const r = await runRelevantSearch(store, parsed.message, {
              namespace: ns,
              limit: relLimit,
            });
            keywords = r.keywords; // identical per namespace (from the message)
            lists.push(r.results);
          }
          const lim = clampInt(relLimit, 10, 1, 200);
          sendJson(res, 200, {
            keywords,
            results: roundRobin(lists, lim).map((n) => annotateStaleness(n)),
            searchedNamespaces: readable(),
          });
          return;
        }
        const out = await runRelevantSearch(store, parsed.message, {
          namespace: relNs,
          limit: relLimit,
        });
        sendJson(res, 200, {
          ...withStaleness(out),
          searchedNamespaces: relNs ? [relNs] : [],
        });
        return;
      }

      // GET /stats?namespace= -> access-tracking stats, mirroring the
      // memory_stats MCP tool. Read scope; namespace gating matches the
      // tool exactly (readable-set counting under server-side resolution,
      // never the whole store).
      if (req.method === "GET" && path === "/stats") {
        const namespace = url.searchParams.get("namespace") ?? undefined;
        let namespaces: string[] | undefined;
        let searchedNamespaces: string[];
        if (nsActive) {
          const hint = trustedHint(namespace);
          namespaces = hint ? [hint] : readable();
          searchedNamespaces = namespaces;
        } else {
          namespaces = namespace ? [namespace] : undefined;
          searchedNamespaces = namespace ? [namespace] : [];
        }
        sendJson(res, 200, {
          ...store.accessStats(namespaces),
          searchedNamespaces,
        });
        return;
      }

      // POST /rebuild-edges { threshold?, namespace?, confirm? } -> { created, removed }
      // Mirrors the memory_rebuild_edges MCP tool: recalculates the note
      // similarity graph from scratch. Admin scope; under server-side
      // namespace resolution the rebuild is confined to the server's own
      // namespace (writes stay local, like memory_consolidate). Runs the
      // cooperative chunked rebuild, so it yields to the event loop and
      // commits per chunk instead of freezing the server in one giant
      // transaction; an interrupted run resumes from its _meta marker.
      // Same confirmation gate as the MCP tool: above
      // REBUILD_CONFIRM_NOTE_COUNT notes in scope it answers 409 with the
      // workload unless the body carries confirm: true. One rebuild at a
      // time: a concurrent request gets 409.
      if (req.method === "POST" && path === "/rebuild-edges") {
        const raw = await readBody(req);
        let parsed: { threshold?: unknown; namespace?: unknown; confirm?: unknown };
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const threshold =
          parsed.threshold === undefined ? undefined : Number(parsed.threshold);
        const relNs =
          typeof parsed.namespace === "string" ? parsed.namespace : undefined;
        try {
          // resolveEdgeThreshold throws ValidationError on out-of-range
          // input -> 400 via sendError, never a 500.
          resolveEdgeThreshold(threshold);
          const scopeNs = nsActive ? ownNs : relNs;
          const plan = store.rebuildPlan(scopeNs ? { namespace: scopeNs } : {});
          const notes = plan.reduce((s, g) => s + g.notes, 0);
          const pairs = plan.reduce((s, g) => s + g.pairs, 0);
          if (notes > REBUILD_CONFIRM_NOTE_COUNT && parsed.confirm !== true) {
            sendJson(res, 409, {
              error:
                `refusing: rebuilding edges would score ~${pairs.toLocaleString("en-US")} pairs ` +
                `across ${notes.toLocaleString("en-US")} notes (over the ` +
                `${REBUILD_CONFIRM_NOTE_COUNT}-note confirmation threshold); ` +
                "re-send with confirm: true to proceed",
              notes,
              pairs,
            });
            return;
          }
          const result = await store.rebuildEdgesCooperative({
            threshold,
            namespace: scopeNs,
          });
          sendJson(res, 200, {
            ...result,
            namespace: scopeNs ?? null,
          });
        } catch (e) {
          if (e instanceof RebuildBusyError) {
            sendJson(res, 409, { error: e.message });
            return;
          }
          sendError(res, e);
        }
        return;
      }

      // GET /export -> all notes, for backup / migration. Exempt from the
      // response-size cap: a backup must dump the whole store, not a truncated
      // slice (there are no narrowing params on /export).
      if (req.method === "GET" && path === "/export") {
        // When namespace resolution is active the dump is filtered to the
        // namespaces this server may read (own + grants): an unrestricted
        // export would let an admin-token holder exfiltrate every namespace,
        // defeating one-directional grants.
        const notes = nsActive
          ? store.exportAll().filter((n) => canRead(grants, ownNs, n.namespace))
          : store.exportAll();
        sendJson(res, 200, { notes }, { cap: false });
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
          // When namespace resolution is active the client-supplied namespace
          // is untrusted: imported notes are forced into the server's own
          // namespace so a backup can't plant notes into another namespace
          // (memory poisoning).
          const notes = nsActive
            ? parsed.notes.map((n) => ({ ...n, namespace: ownNs }))
            : parsed.notes;
          const created = await store.importNotes(notes);
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
