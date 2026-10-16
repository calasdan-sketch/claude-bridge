// Transport-agnostic MCP server: registers the state tools (state_write,
// state_read, state_search, state_relevant, state_list, state_delete), the access-tracking
// memory_stats tool, the consolidation tools
// (memory_consolidation_candidates, memory_consolidate), and the similarity-graph
// memory_rebuild_edges tool, directly against the shared Store. Both the stdio entry point and the
// HTTP/SSE entry point build one of these per connection/process, always
// pointed at the same SQLite file as the HTTP API -- there is exactly one
// state store, not a mock or a second copy.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Store, ValidationError, clampInt, type NoteRecord } from "./store.js";
import { type Scope } from "./config.js";
import { scopeAllows, UNTRUSTED_BANNER } from "./security.js";
import { runSearch, parseMode, maybeEmbed, runRelevantSearch, SEARCH_MODES, type SearchOpts } from "./search-service.js";
import {
  type ServerNamespaceOpts,
  canRead,
  readableNamespaces,
} from "./namespace.js";
import { parseTimePhrase } from "./time-parse.js";
import { TIME_ZONE } from "./config.js";
import { annotateStaleness } from "./staleness.js";
import {
  findCandidatesCooperative,
  resolveConsolidationNotes,
  consolidateNotes,
  buildConsolidationPreview,
  clampThreshold,
} from "./consolidate.js";

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

// Injection-on-read guard: the banner lives in security.ts as the single
// source of truth.
function untrustedResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: UNTRUSTED_BANNER + JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message }),
      },
    ],
    isError: true,
  };
}

// Map a thrown error to a tool result. Mirrors the REST layer's policy: a
// caller-input problem (ValidationError) is echoed back, but any unexpected
// fault (e.g. a raw node:sqlite error) is logged server-side and returned as a
// generic message so SQLite/internal details never leak to the MCP caller.
function errorFor(e: unknown) {
  if (e instanceof ValidationError) return errorResult(e.message);
  // eslint-disable-next-line no-console
  console.error("[onememory] mcp tool error:", (e as Error).message);
  return errorResult("internal error");
}

/**
 * Build the MCP server. `scope` is the caller's access level (from their
 * token on the HTTP transport); it defaults to "admin" for the local stdio
 * transport, which has no token and is trusted as the machine owner.
 *
 * `opts.namespace` activates server-side namespace resolution (see
 * src/namespace.ts): the model-supplied `namespace` parameter becomes an
 * untrusted hint. Writes always land in the resolved namespace, reads are
 * limited to the resolved namespace plus its `readsFrom` grants. When
 * `opts.namespace` is unset, behavior is exactly the legacy one --
 * model-supplied namespaces are honored.
 */
export function createMcpServer(
  store: Store,
  scope: Scope = "admin",
  opts: ServerNamespaceOpts = {}
): McpServer {
  const server = new McpServer({
    name: "onememory",
    version: "1.0.0",
  });

  const denyIfUnder = (need: Scope): string | null =>
    scopeAllows(scope, need) ? null : `this token lacks the required '${need}' scope`;

  // Server-side namespace resolution, active only when the entry point
  // resolved a namespace at startup (see resolveStartupNamespace).
  const nsActive = typeof opts.namespace === "string" && opts.namespace.length > 0;
  const ownNs = opts.namespace ?? "";
  const grants = opts.readsFrom ?? {};
  const readable = (): string[] => readableNamespaces(ownNs, grants);
  // The model-supplied namespace is an UNTRUSTED HINT: usable only when it
  // names a namespace this server may actually read.
  const trustedHint = (hint: string | undefined): string | undefined =>
    hint && canRead(grants, ownNs, hint) ? hint : undefined;

  // Search across every readable namespace (used when the hint is missing
  // or names something unreadable). Fans out per namespace and merges,
  // since the store/search layer only filters a single namespace.
  async function searchReadable(
    query: string,
    o: Omit<SearchOpts, "namespace">
  ): Promise<NoteRecord[]> {
    const limit = clampInt(o.limit, 20, 1, 200);
    const seen = new Set<number>();
    const merged: NoteRecord[] = [];
    for (const ns of readable()) {
      const hits = await runSearch(store, query, { ...o, namespace: ns });
      for (const h of hits) {
        if (!seen.has(h.id)) {
          seen.add(h.id);
          merged.push(h);
        }
      }
    }
    return merged.slice(0, limit);
  }

  // state_relevant across every readable namespace: same fan-out-and-merge
  // as searchReadable, but keywords are identical per namespace (they come
  // from the message, not the data), so only the results merge.
  async function relevantReadable(
    message: string,
    o: { limit?: number }
  ): Promise<{ keywords: string[]; results: NoteRecord[] }> {
    const limit = clampInt(o.limit, 10, 1, 200);
    const seen = new Set<number>();
    const merged: NoteRecord[] = [];
    let keywords: string[] = [];
    for (const ns of readable()) {
      const r = await runRelevantSearch(store, message, { ...o, namespace: ns });
      keywords = r.keywords;
      for (const h of r.results) {
        if (!seen.has(h.id)) {
          seen.add(h.id);
          merged.push(h);
        }
      }
    }
    return { keywords, results: merged.slice(0, limit) };
  }

  // List across every readable namespace, newest-first like store.list
  // (updated_at DESC, id DESC), then paginate the merged pool.
  function listReadable(limit?: number, offset?: number): { notes: NoteRecord[]; total: number } {
    const pool: NoteRecord[] = [];
    for (const ns of readable()) {
      pool.push(...store.list({ namespace: ns, limit: 500, offset: 0 }).notes);
    }
    pool.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
    const lim = clampInt(limit, 50, 1, 500);
    const off = clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return { notes: pool.slice(off, off + lim), total: pool.length };
  }

  server.registerTool(
    "state_write",
    {
      title: "Write shared state",
      description:
        "Create a new note in the shared cross-surface state store, or update an existing one if `id` is given. Returns the resulting note." +
        (nsActive
          ? " SERVER-RESOLVED NAMESPACE: this server writes to its own namespace; no `namespace` parameter is accepted."
          : ""),
      inputSchema: {
        id: z
          .number()
          .int()
          .optional()
          .describe("Id of an existing note to update. Omit to create a new note."),
        // When server-side namespace resolution is active the model-supplied
        // namespace is dropped entirely (writes always land in the resolved
        // namespace), so the parameter is stripped from the schema rather
        // than accepted-and-ignored. Kept when resolution is off, where it
        // is honored (legacy behavior).
        ...(nsActive
          ? {}
          : {
              namespace: z
                .string()
                .optional()
                .describe("Namespace/bucket for the note. Defaults to 'default'."),
            }),
        title: z
          .string()
          .optional()
          .describe("Note title. Required when creating a new note."),
        body: z.string().optional().describe("Note body/content."),
        tags: z.array(z.string()).optional().describe("Tags for the note."),
        source: z
          .string()
          .optional()
          .describe("Provenance: who/what wrote this note (an agent or user label)."),
        if_rev: z
          .number()
          .int()
          .optional()
          .describe(
            "Compare-and-swap: only update if the note is still at this revision (from a prior read). Omit to force."
          ),
      },
    },
    async ({ id, namespace, title, body, tags, source, if_rev }) => {
      try {
        const denied = denyIfUnder("write");
        if (denied) return errorResult(denied);
        if (id !== undefined) {
          // When namespace resolution is active the model-supplied namespace
          // is dropped entirely (the note keeps its existing namespace), and
          // the note being updated must live in THIS server's namespace --
          // a read grant never confers write access, otherwise an
          // update-by-id could rewrite notes from a granted namespace. A
          // missing or foreign note reports the same "no note" so the caller
          // can't probe which ids exist in namespaces it may not write.
          const patch = nsActive ? { title, body, tags, source } : { namespace, title, body, tags, source };
          if (nsActive) {
            const existing = store.read(id);
            if (!existing || existing.namespace !== ownNs) {
              return errorResult(`no note with id ${id}`);
            }
          }
          const updated = store.update(id, patch, { ifRev: if_rev });
          if (!updated) return errorResult(`no note with id ${id}`);
          await maybeEmbed(store, updated);
          // A partial update echoes back the merged note, which can include a
          // pre-existing body planted by someone else -- wrap it as untrusted.
          return untrustedResult({ note: updated });
        }
        if (!title || !title.trim()) {
          return errorResult("title is required when creating a new note");
        }
        // Writes always go to the server-resolved namespace when active; the
        // model-supplied `namespace` is ignored (prompt-injection guard).
        const created = store.create(
          nsActive ? { namespace: ownNs, title, body, tags, source } : { namespace, title, body, tags, source }
        );
        await maybeEmbed(store, created);
        return untrustedResult({ note: created });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "state_read",
    {
      title: "Read shared state",
      description:
        "Read a single note from the shared state store by id. Pass " +
        "`neighbors: true` to also attach up to 10 similar notes (same " +
        "namespace) with their similarity scores -- the note's neighborhood " +
        "in the similarity graph.",
      inputSchema: {
        id: z.number().int().describe("Id of the note to read."),
        neighbors: z
          .boolean()
          .optional()
          .describe(
            "Attach up to 10 similar-note neighbors (same namespace) with similarity scores. Default false."
          ),
      },
    },
    async ({ id, neighbors }) => {
      try {
        // User-facing read: bump the note's access counters.
        const note = store.read(id, { trackAccess: true, withNeighbors: neighbors === true });
        if (!note) return errorResult(`no note with id ${id}`);
        if (nsActive && !canRead(grants, ownNs, note.namespace)) {
          // Uniform "no note": a distinct denial would let the caller probe
          // which ids exist in namespaces it cannot read.
          return errorResult(`no note with id ${id}`);
        }
        // Round edge scores to 3 decimals for readability (stored raw in
        // SQLite), mirroring memory_consolidation_candidates.
        const annotated = annotateStaleness(note);
        const payload = note.neighbors
          ? {
              ...annotated,
              neighbors: note.neighbors.map((n) => ({
                ...n,
                score: Math.round(n.score * 1000) / 1000,
              })),
            }
          : annotated;
        return untrustedResult({ note: payload });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "state_search",
    {
      title: "Search shared state",
      description:
        "Search notes in the shared state store by title/body/tags. Keyword (full-text) by default; set mode to 'semantic' or 'hybrid' for meaning-based search when embeddings are enabled (falls back to keyword otherwise). Always reflects the latest writes." +
        (nsActive
          ? " The `namespace` parameter is an untrusted hint: only namespaces this server may read are searched."
          : ""),
      inputSchema: {
        query: z.string().describe("Search text."),
        namespace: z
          .string()
          .optional()
          .describe(
            nsActive
              ? "Untrusted hint: restrict search to this namespace. Ignored unless this server may read it."
              : "Restrict search to this namespace."
          ),
        limit: z.number().int().optional().describe("Max results (default 20, max 200)."),
        mode: z
          .enum(SEARCH_MODES)
          .optional()
          .describe(
            "keyword = full-text (default when embeddings off); semantic = meaning only; hybrid = fuse both. Falls back to keyword if embeddings are unavailable."
          ),
        when: z
          .string()
          .optional()
          .describe(
            "Natural-language time filter, e.g. 'yesterday evening'. Scopes results to that time range (interpreted in ONEMEMORY_TIMEZONE). Unrecognized values are ignored -- the query still runs unscoped."
          ),
      },
    },
    async ({ query, namespace, limit, mode, when }) => {
      try {
        // A time phrase the parser doesn't recognize is ignored, never an
        // error: the query still runs, just unscoped.
        const timePhrase = when ? parseTimePhrase(when, { timeZone: TIME_ZONE }) : null;
        const timeRange = timePhrase
          ? { start: timePhrase.start, end: timePhrase.end }
          : undefined;
        const resolvedMode = mode ?? parseMode(undefined);
        if (nsActive) {
          // The model-supplied namespace is an UNTRUSTED HINT: intersect it
          // with the readable set. A hint naming an unreadable namespace is
          // ignored (readable namespaces are searched instead); the
          // server-resolved namespace is authoritative.
          const hint = trustedHint(namespace);
          const results = hint
            ? await runSearch(store, query, {
                namespace: hint,
                limit,
                mode: resolvedMode,
                timeRange,
              })
            : await searchReadable(query, { limit, mode: resolvedMode, timeRange });
          // Surface how the `when` phrase was interpreted (null when the
          // query ran unscoped): the caller otherwise can't tell what the
          // time filter meant. Each hit carries its staleness fields
          // (stale/ageDays, plus staleWarning when stale).
          return untrustedResult({
            results: results.map((n) => annotateStaleness(n)),
            timeRange: timePhrase ? timePhrase.label : null,
          });
        }
        const results = await runSearch(store, query, {
          namespace,
          limit,
          mode: resolvedMode,
          timeRange,
        });
        return untrustedResult({
          results: results.map((n) => annotateStaleness(n)),
          timeRange: timePhrase ? timePhrase.label : null,
        });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "state_relevant",
    {
      title: "Find memories relevant to a message",
      description:
        "Given a natural conversational message, extract keywords from it and return notes matching any of them. Permissive on purpose: a note qualifies on a single keyword hit (OR), unlike state_search's AND conjunction -- use this for vague messages where you don't know the exact wording. Returns the extracted keywords alongside the results for transparency." +
        (nsActive
          ? " The `namespace` parameter is an untrusted hint: only namespaces this server may read are searched."
          : ""),
      inputSchema: {
        message: z
          .string()
          .describe("Natural conversational text to find relevant memories for."),
        limit: z.number().int().optional().describe("Max results (default 5, max 200)."),
        namespace: z
          .string()
          .optional()
          .describe(
            nsActive
              ? "Untrusted hint: restrict search to this namespace. Ignored unless this server may read it."
              : "Restrict search to this namespace."
          ),
      },
    },
    async ({ message, limit, namespace }) => {
      try {
        if (!message || !message.trim()) {
          return errorResult("message is required");
        }
        // The tool's own default (5) overrides the service-level default
        // (10): a relevance probe returns a handful of notes, not a page.
        const effLimit = limit ?? 5;
        if (nsActive) {
          // Same gating as state_search: the model-supplied namespace is an
          // UNTRUSTED HINT, intersected with the readable set. A hint naming
          // an unreadable namespace is ignored (readable namespaces are
          // searched instead).
          const hint = trustedHint(namespace);
          const out = hint
            ? await runRelevantSearch(store, message, { namespace: hint, limit: effLimit })
            : await relevantReadable(message, { limit: effLimit });
          return untrustedResult(out);
        }
        const out = await runRelevantSearch(store, message, { namespace, limit: effLimit });
        return untrustedResult(out);
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "state_list",
    {
      title: "List shared state",
      description:
        "List notes in the shared state store, optionally filtered by namespace." +
        (nsActive
          ? " The `namespace` parameter is an untrusted hint: only namespaces this server may read are listed."
          : ""),
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe(
            nsActive
              ? "Untrusted hint: restrict listing to this namespace. Ignored unless this server may read it."
              : "Restrict listing to this namespace."
          ),
        limit: z.number().int().optional().describe("Max results (default 50, max 500)."),
        offset: z.number().int().optional().describe("Pagination offset."),
      },
    },
    async ({ namespace, limit, offset }) => {
      try {
        if (nsActive) {
          // Untrusted hint intersected with the readable set, like search.
          const hint = trustedHint(namespace);
          const result = hint
            ? store.list({ namespace: hint, limit, offset })
            : listReadable(limit, offset);
          return untrustedResult(result);
        }
        const result = store.list({ namespace, limit, offset });
        return untrustedResult(result);
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "state_delete",
    {
      title: "Delete shared state",
      description:
        "Delete a note from the shared state store by id. Returns whether a note was removed.",
      inputSchema: {
        id: z.number().int().describe("Id of the note to delete."),
      },
    },
    async ({ id }) => {
      try {
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        if (nsActive) {
          // Deletes (like updates) require the server's own namespace: a
          // read grant never confers delete access. Missing and foreign
          // notes report the same "no note" to avoid an existence oracle.
          const note = store.read(id);
          if (!note || note.namespace !== ownNs) {
            return errorResult(`no note with id ${id}`);
          }
        }
        const removed = store.delete(id);
        if (!removed) return errorResult(`no note with id ${id}`);
        return textResult({ deleted: id });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_stats",
    {
      title: "Memory access statistics",
      description:
        "Read-only access-tracking stats for the shared state store: total notes, total reads, the most-read notes, how many notes were never read (dead-memory candidates for future cleanup), and how many notes are stale (older than the staleness thresholds -- see staleCount)." +
        (nsActive
          ? " SERVER-RESOLVED NAMESPACE: stats are scoped to the namespaces this server may read."
          : ""),
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe(
            nsActive
              ? "Untrusted hint: restrict stats to this namespace. Ignored unless this server may read it."
              : "Restrict stats to this namespace."
          ),
      },
    },
    async ({ namespace }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        // Namespace-scoped: with server-side resolution, stats count only the
        // readable namespaces (own + grants), never the whole store. Without
        // resolution, an explicit namespace restricts; otherwise the whole
        // store is counted (legacy behavior).
        let namespaces: string[] | undefined;
        if (nsActive) {
          const hint = trustedHint(namespace);
          namespaces = hint ? [hint] : readable();
        } else if (namespace) {
          namespaces = [namespace];
        }
        return textResult(store.accessStats(namespaces));
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_consolidation_candidates",
    {
      title: "Find duplicate note candidates",
      description:
        "Find near-duplicate notes (cosine similarity over title + body) that are candidates for consolidation. Same-namespace only; never suggests cross-namespace merges. Read-only.",
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe("Restrict the scan to this namespace."),
        threshold: z
          .number()
          .optional()
          .describe(
            "Similarity threshold 0.5..1.0 (default 0.95). Out-of-range values are clamped, not rejected."
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe("Max candidate pairs to return (default 50, max 200)."),
      },
    },
    async ({ namespace, threshold, limit }) => {
      try {
        const denied = denyIfUnder("read");
        if (denied) return errorResult(denied);
        // When server-side namespace resolution is active, the model-supplied
        // namespace is an untrusted hint: intersect with the readable set.
        let notes: NoteRecord[];
        if (nsActive) {
          const hint = trustedHint(namespace);
          const allowed = hint ? [hint] : readable();
          const allowedSet = new Set(allowed);
          notes = store.exportAll().filter((n) => allowedSet.has(n.namespace));
        } else {
          notes = store
            .exportAll()
            .filter((n) => !namespace || n.namespace === namespace);
        }
        // Cooperative scan: yields to the event loop so a large candidate
        // sweep doesn't stall concurrent MCP/HTTP traffic.
        const pairs = await findCandidatesCooperative(notes, {
          threshold: clampThreshold(threshold, 0.95),
          limit: clampInt(limit, 50, 1, 200),
        });
        const byId = new Map(notes.map((n) => [n.id, n]));
        return untrustedResult({
          candidates: pairs.map((c) => ({
            idA: c.idA,
            idB: c.idB,
            score: Math.round(c.score * 1000) / 1000,
            titleA: byId.get(c.idA)?.title ?? "",
            titleB: byId.get(c.idB)?.title ?? "",
          })),
          count: pairs.length,
        });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_consolidate",
    {
      title: "Consolidate duplicate notes",
      description:
        "Merge 2+ duplicate notes into one: longest title wins (or merged_title), bodies are deduplicated and joined, tags are unioned. Deletes the source notes unless keep_sources is true, so this requires the admin scope (same policy as state_delete). Pass dry_run: true to preview the merge without writing anything.",
      inputSchema: {
        ids: z
          .array(z.number().int())
          .min(2)
          .describe("Ids of the notes to merge (2 or more, all in one namespace)."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Preview the merge without writing anything (default false)."),
        merged_title: z
          .string()
          .optional()
          .describe("Title for the merged note. Defaults to the longest source title."),
        keep_sources: z
          .boolean()
          .optional()
          .describe("Keep the source notes after merging (default false: they are deleted)."),
      },
    },
    async ({ ids, dry_run, merged_title, keep_sources }) => {
      try {
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        // Same validation as the real merge, so dry_run previews exactly
        // what would (or would not) be allowed to run.
        const notes = resolveConsolidationNotes(store, ids);
        // Namespace isolation: when server-side resolution is active,
        // consolidation may only touch the server's own namespace. Reads-from
        // grants confer read access, never the right to restructure another
        // namespace's notes (writes always stay local).
        if (nsActive) {
          const foreign = notes.filter((n) => n.namespace !== ownNs);
          if (foreign.length > 0) {
            return errorResult(
              `access denied: consolidation is limited to namespace "${ownNs}" ` +
                `(${foreign.length} note(s) are elsewhere)`
            );
          }
        }
        const keep = keep_sources === true;
        if (dry_run) {
          const preview = buildConsolidationPreview(notes, merged_title);
          return untrustedResult({
            dry_run: true,
            would_create: preview,
            would_delete: keep ? [] : ids,
          });
        }
        const merged = consolidateNotes(store, ids, {
          deleteSources: !keep,
          mergedTitle: merged_title,
        });
        // The merge path doesn't embed (store.create is embedding-agnostic);
        // do it here so the merged note is visible to semantic search.
        await maybeEmbed(store, merged);
        return untrustedResult({ merged, deleted: keep ? [] : ids });
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  server.registerTool(
    "memory_rebuild_edges",
    {
      title: "Rebuild similarity edges",
      description:
        "Recalculate the note similarity graph from scratch: every note is " +
        "re-scored against same-namespace notes (cosine similarity over title " +
        "+ body) and pairs at/above `threshold` get bidirectional edges. " +
        "Reports {created, removed} directed-edge counts. O(n^2) -- run as " +
        "maintenance after bulk imports or threshold changes, not interactively." +
        (nsActive
          ? " Rebuilds only this server's own namespace (writes stay local)."
          : ""),
      inputSchema: {
        threshold: z
          .number()
          .optional()
          .describe(
            "Similarity floor for an edge (default 0.35). Must be in (0, 1]."
          ),
        // When server-side namespace resolution is active, writes stay in
        // the resolved namespace (same policy as memory_consolidate), so the
        // model-supplied namespace is stripped from the schema rather than
        // accepted-and-ignored. Kept when resolution is off, where it is
        // honored (legacy behavior).
        ...(nsActive
          ? {}
          : {
              namespace: z
                .string()
                .optional()
                .describe(
                  "Rebuild edges for this namespace only. Omit to rebuild the whole store."
                ),
            }),
      },
    },
    async ({ threshold, namespace }) => {
      try {
        const denied = denyIfUnder("admin");
        if (denied) return errorResult(denied);
        // An invalid threshold surfaces as a ValidationError -> clean tool
        // error (never a 500-style internal fault).
        const result = store.rebuildEdges({
          threshold,
          namespace: nsActive ? ownNs : namespace,
        });
        // Counts only -- no note content -- so no untrusted-data banner.
        return textResult(result);
      } catch (e) {
        return errorFor(e);
      }
    }
  );

  return server;
}
