// Search orchestration shared by the HTTP API and the MCP tools.
//
// Three modes:
//   - "keyword"  : FTS5 only (the default, zero-dependency path).
//   - "semantic" : embedding cosine only (needs embeddings enabled).
//   - "hybrid"   : fuse keyword + semantic with Reciprocal Rank Fusion.
//
// If embeddings are disabled, the endpoint is down, or the query can't be
// embedded, every mode degrades to keyword search -- a query must never fail
// because an optional embedding server is unavailable.

import { Store, NoteRecord, clampInt } from "./store.js";
import { embed, embeddingsEnabled, embeddingsConfig, noteEmbeddingText } from "./embeddings.js";
import { filterByTimeRange } from "./time-parse.js";

/** The allowed search modes; single source of truth for the API + MCP schema. */
export const SEARCH_MODES = ["keyword", "semantic", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/**
 * Best-effort: when embeddings are on, compute and store a note's vector so it
 * appears in semantic search. Never throws -- the note is already saved in
 * SQLite; the embedding is a bonus, and a down embedding server must not fail
 * a write.
 */
export async function maybeEmbed(store: Store, note: NoteRecord): Promise<void> {
  if (!embeddingsEnabled()) return;
  try {
    const cfg = embeddingsConfig();
    const vec = await embed(noteEmbeddingText(note.title, note.body), cfg);
    if (vec) store.setVector(note.id, vec, cfg.model);
  } catch {
    /* swallow: the write succeeded; the embedding is best-effort */
  }
}

export function parseMode(raw: string | undefined | null): SearchMode {
  const m = (raw || "").trim().toLowerCase();
  if (m === "semantic" || m === "hybrid" || m === "keyword") return m;
  // Default: hybrid when embeddings are on, otherwise plain keyword.
  return embeddingsEnabled() ? "hybrid" : "keyword";
}

/**
 * Reciprocal Rank Fusion. Merges several ranked id lists into one ranking by
 * summing 1/(k + rank). Robust across differently-scaled scorers (FTS rank vs
 * cosine) without normalizing either. k=60 is the common default.
 */
export function rrfMerge(lists: number[][], k = 60): number[] {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export interface SearchOpts {
  namespace?: string;
  limit?: number;
  mode?: SearchMode;
  /**
   * Optional UTC [start, end) window (usually from parseTimePhrase()).
   * Scopes results to notes created inside the window; keywords still rank
   * within it. When the query is blank, behaves like a time-scoped list
   * (newest first).
   */
  timeRange?: { start: Date; end: Date };
}

/**
 * How a time range is applied (documented for operators):
 *
 * - Blank query + timeRange -> store.list() with the range pushed into SQL
 *   (newest-first, same ordering as state_list).
 * - Keyword mode (or embeddings unavailable) -> the range is pushed into the
 *   FTS SQL query via store.search()'s startISO/endISO, so ranking sees only
 *   in-range notes. Correctness over elegance: no post-hoc slicing that
 *   could empty a page of results.
 * - Semantic/hybrid -> embeddings have no SQL range support, so each side
 *   fetches a larger candidate pool (limit*5, capped at the 200 max), the
 *   pool is filtered to the window in JS, then fused (RRF) and sliced to
 *   the limit. A note outside the window can never outrank one inside it
 *   because it never enters the fusion.
 */
export async function runSearch(
  store: Store,
  query: string,
  opts: SearchOpts = {}
): Promise<NoteRecord[]> {
  // Clamp here too: the store methods clamp their own queries, but the hybrid
  // path slices fused ids by this value, so an unclamped 0/negative/NaN would
  // silently return [] or misorder despite real matches.
  const limit = clampInt(opts.limit, 20, 1, 200);
  const mode: SearchMode = opts.mode ?? parseMode(undefined);
  const range = opts.timeRange;
  const rangeOpts =
    range !== undefined
      ? { startISO: range.start.toISOString(), endISO: range.end.toISOString() }
      : {};

  // Time-only query: no keywords to rank by -> time-scoped newest-first list.
  if (range !== undefined && !query.trim()) {
    return store.list({ namespace: opts.namespace, limit, ...rangeOpts }).notes;
  }

  const keyword = (fetchLimit: number): NoteRecord[] =>
    store.search(query, { namespace: opts.namespace, limit: fetchLimit, ...rangeOpts });

  if (mode === "keyword" || !embeddingsEnabled()) return keyword(limit);

  const qv = await embed(query);
  if (!qv) return keyword(limit); // endpoint down / not embeddable -> graceful fallback

  // Oversample, then filter to the window before fusing.
  const poolLimit = clampInt(limit * 5, 100, 1, 200);
  const semHits = store.semanticSearch(qv, { namespace: opts.namespace, limit: poolLimit });

  if (mode === "semantic") {
    const notes = semHits.map((h) => h.note);
    const inRange = range !== undefined ? filterByTimeRange(notes, range) : notes;
    return inRange.slice(0, limit);
  }

  // hybrid: fuse the two rankings, then resolve ids back to records.
  const ftsRecords = keyword(poolLimit);
  const fusedIds = rrfMerge([
    ftsRecords.map((n) => n.id),
    semHits.map((h) => h.note.id),
  ]);

  const byId = new Map<number, NoteRecord>();
  for (const n of ftsRecords) byId.set(n.id, n);
  for (const h of semHits) byId.set(h.note.id, h.note);
  let fused = fusedIds.map((id) => byId.get(id)!).filter(Boolean);
  if (range !== undefined) fused = filterByTimeRange(fused, range);
  return fused.slice(0, limit);
}
