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
import { extractKeywords } from "./keywords.js";
import {
  isStale,
  stalenessConfig,
  STALE_SCORE_PENALTY,
  type StalenessConfig,
} from "./staleness.js";

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
  const score = rrfScores(lists, k);
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** The fused per-id scores rrfMerge sorts on (exposed for importance weighting). */
export function rrfScores(lists: number[][], k = 60): Map<number, number> {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return score;
}

/**
 * Importance weight from access tracking: memories you actually re-read rank
 * higher. The log dampening keeps a runaway note from swallowing the ranking:
 * 1 read ~= +3%, 10 reads ~= +10%, 100 reads ~= +20%, 1000 reads ~= +30%.
 * Among equally-accessed notes the boost is identical, so the native ranking
 * (FTS relevance, cosine, RRF fusion) is preserved exactly.
 */
export const ACCESS_BOOST_FACTOR = 0.1;

function accessBoost(baseScore: number, accessCount: number): number {
  const c = Math.max(0, Math.floor(accessCount));
  return baseScore * (1 + ACCESS_BOOST_FACTOR * Math.log10(1 + c));
}

/** Multiply each hit's native score by its access boost and re-rank (stable). */
function boostAndRank(
  hits: Array<{ note: NoteRecord; score: number }>
): Array<{ note: NoteRecord; score: number }> {
  return hits
    .map((h) => ({ ...h, score: accessBoost(h.score, h.note.access_count) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Stale-note penalty: a stale note's score is multiplied by
 * STALE_SCORE_PENALTY (0.9), so an equally-relevant fresh note outranks it
 * while the stale note stays findable. Applied after the access boost, before
 * truncation. The config is read once per search, not per hit.
 */
function applyStalePenalty(
  hits: Array<{ note: NoteRecord; score: number }>,
  cfg: StalenessConfig
): Array<{ note: NoteRecord; score: number }> {
  return hits
    .map((h) => (isStale(h.note, cfg).stale ? { ...h, score: h.score * STALE_SCORE_PENALTY } : h))
    .sort((a, b) => b.score - a.score); // stable: ties keep fetch order
}

/**
 * Bump access counters for notes *returned* to the caller (the top N), never
 * for every note the scorer scanned. Importance weighting should reflect
 * actual reads, not index churn.
 */
function bumpAccess(store: Store, notes: NoteRecord[]): void {
  for (const n of notes) store.touch(n.id);
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
 *   in-range notes.
 * - Semantic/hybrid -> the range is pushed into the *vector* SQL via
 *   store.semanticSearch()'s startISO/endISO, so the top-200 cosine ranking
 *   is computed within the window, not globally. The old design fetched the
 *   global top-200 and discarded out-of-window notes in JS, which silently
 *   returned nothing when 200+ out-of-window notes outscored the in-window
 *   ones. The JS-side filterByTimeRange calls below are now a no-op safety
 *   net; a note outside the window can never enter the fusion because it
 *   never leaves SQL.
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
  const staleCfg = stalenessConfig();

  // Time-only query: no keywords to rank by -> time-scoped newest-first list.
  // A newest-first list has no relevance ranking to boost, but the returned
  // notes were still read by the caller, so their access counters bump.
  if (range !== undefined && !query.trim()) {
    const listed = store.list({ namespace: opts.namespace, limit, ...rangeOpts }).notes;
    bumpAccess(store, listed);
    return listed;
  }

  // Keyword hits with their FTS5 bm25 rank as the base score (higher =
  // better match). Identical documents score identically, so the access
  // boost breaks ties toward the note actually read most often.
  const keyword = (fetchLimit: number): Array<{ note: NoteRecord; score: number }> =>
    store.searchRanked(query, {
      namespace: opts.namespace,
      limit: fetchLimit,
      ...rangeOpts,
    });

  /** Boost, stale-penalize, truncate to the result limit, bump access. */
  const finalize = (hits: Array<{ note: NoteRecord; score: number }>): NoteRecord[] => {
    const notes = applyStalePenalty(boostAndRank(hits), staleCfg)
      .slice(0, limit)
      .map((h) => h.note);
    bumpAccess(store, notes);
    return notes;
  };

  if (mode === "keyword" || !embeddingsEnabled()) return finalize(keyword(limit));

  const qv = await embed(query);
  if (!qv) return finalize(keyword(limit)); // endpoint down / not embeddable -> graceful fallback

  // Oversample (limit*5, capped at the 200 max) so hybrid RRF has a rich
  // candidate pool on both sides; the window is pushed into the vector SQL,
  // so the semantic ranking is already computed within the time range.
  const poolLimit = clampInt(limit * 5, 100, 1, 200);
  const semHits = store.semanticSearch(qv, {
    namespace: opts.namespace,
    limit: poolLimit,
    ...rangeOpts,
  });

  if (mode === "semantic") {
    let hits = semHits.map((h) => ({ note: h.note, score: h.score }));
    if (range !== undefined) {
      const inRange = new Set(
        filterByTimeRange(
          hits.map((h) => h.note),
          range
        ).map((n) => n.id)
      );
      hits = hits.filter((h) => inRange.has(h.note.id));
    }
    return finalize(hits);
  }

  // hybrid: fuse the two rankings, then resolve ids back to records.
  const ftsHits = keyword(poolLimit);
  const fusedScores = rrfScores([
    ftsHits.map((h) => h.note.id),
    semHits.map((h) => h.note.id),
  ]);

  const byId = new Map<number, NoteRecord>();
  for (const h of ftsHits) byId.set(h.note.id, h.note);
  for (const h of semHits) byId.set(h.note.id, h.note);
  let hits = [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ note: byId.get(id)!, score }))
    .filter((h) => h.note !== undefined);
  if (range !== undefined) {
    const inRange = new Set(filterByTimeRange(hits.map((h) => h.note), range).map((n) => n.id));
    hits = hits.filter((h) => inRange.has(h.note.id));
  }
  return finalize(hits);
}

export interface RelevantOpts {
  namespace?: string;
  limit?: number;
}

/**
 * "Vague user message -> relevant memories" search, backing the
 * `state_relevant` MCP tool and `POST /relevant`. Extracts keywords from
 * free-form text and runs a permissive keyword search: a note qualifies on
 * ANY single keyword hit (OR semantics), which is a deliberately lower
 * threshold than runSearch/store.search's AND conjunction -- with up to 20
 * keywords, an AND would return almost nothing for a rambling message.
 * Results rank by most keyword hits first, then newest, and the extracted
 * keywords are returned alongside for transparency.
 */
export async function runRelevantSearch(
  store: Store,
  message: string,
  opts: RelevantOpts = {}
): Promise<{ keywords: string[]; results: NoteRecord[] }> {
  const keywords = extractKeywords(message);
  const limit = clampInt(opts.limit, 10, 1, 200);
  if (keywords.length === 0) return { keywords, results: [] };
  // Oversample per keyword (limit*2, floor 50) so the merge has a real
  // candidate pool before the final limit cut.
  const perKeyword = clampInt(Math.ceil(limit * 2), 50, 1, 200);
  const hits = new Map<number, { note: NoteRecord; count: number }>();
  for (const kw of keywords) {
    const found = store.search(kw, { namespace: opts.namespace, limit: perKeyword });
    for (const note of found) {
      const entry = hits.get(note.id);
      if (entry) entry.count += 1;
      else hits.set(note.id, { note, count: 1 });
    }
  }
  const ranked = [...hits.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.note.updated_at.localeCompare(a.note.updated_at) ||
      b.note.id - a.note.id
  );
  return { keywords, results: ranked.slice(0, limit).map((h) => h.note) };
}
