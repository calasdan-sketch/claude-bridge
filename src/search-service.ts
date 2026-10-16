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
  stalenessConfig,
  stalePenaltyFactor,
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
 * Importance weight from access tracking, recency-aware (I-HIGH-2).
 * Memories you actually re-read *recently* rank higher. The log dampening
 * keeps a runaway note from swallowing the ranking, and the recency decay
 * keeps old popularity from counting forever:
 *
 *   boost = 1 + 0.1 * log10(1 + c) * exp(-daysSinceLastAccess / 30)
 *
 * A note read 10 times today gets ~+10%; the same 10 reads from a year ago
 * get ~+0%. Never-read notes get no boost at all. Among equally-accessed,
 * equally-recent notes the boost is identical, so the native ranking (FTS
 * relevance, cosine, RRF fusion) is preserved exactly.
 *
 * Why the decay: the old flat boost let a stale note with >= 10 accesses
 * erase the staleness penalty entirely (1.104 * 0.9 = 0.994 ~= a fresh
 * note's 1.0), and finalize()'s bumpAccess made it rich-get-richer --
 * ranking highly today bought tomorrow's boost, unbounded over months.
 * last_accessed was tracked in-schema but never used in ranking; now it
 * is the decay signal.
 */
export const ACCESS_BOOST_FACTOR = 0.1;
/** Recency decay horizon (τ) for the access boost, in days. */
export const ACCESS_BOOST_TAU_DAYS = 30;

/** Whole days since an ISO timestamp; null when missing/unparseable. */
function daysSinceAccess(lastAccessed: string | null | undefined): number | null {
  if (!lastAccessed) return null;
  const t = Date.parse(lastAccessed);
  if (!Number.isFinite(t)) return null;
  // A future last_accessed (clock skew) is 0 days ago, never negative.
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

function accessBoost(
  baseScore: number,
  accessCount: number,
  lastAccessed: string | null
): number {
  const c = Math.max(0, Math.floor(accessCount));
  if (c === 0) return baseScore; // no read signal -> no boost
  const days = daysSinceAccess(lastAccessed);
  // Unparseable last_accessed with a positive count shouldn't happen
  // (touch() always sets both); trust the count rather than zeroing it.
  const decay = days === null ? 1 : Math.exp(-days / ACCESS_BOOST_TAU_DAYS);
  return baseScore * (1 + ACCESS_BOOST_FACTOR * Math.log10(1 + c) * decay);
}

/** Multiply each hit's recency-aware access boost and re-rank (stable). */
function boostAndRank(
  hits: Array<{ note: NoteRecord; score: number }>
): Array<{ note: NoteRecord; score: number }> {
  return hits
    .map((h) => ({ ...h, score: accessBoost(h.score, h.note.access_count, h.note.last_accessed) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Stale-note penalty: graded by age (stalePenaltyFactor(): 0.95 per 90-day
 * band), so an equally-relevant fresh note outranks a stale one while the
 * stale note stays findable. Applied after the access boost, before
 * truncation. The config is read once per search, not per hit.
 *
 * Documented history (I-HIGH-2): the old flat 0.9 penalty was
 * arithmetically erased at >= 10 accesses (1 + 0.1*log10(11) = 1.104;
 * 1.104 * 0.9 = 0.994 ~= fresh 1.0). The graded penalty deepens with age
 * instead of staying constant, and the boost now decays with recency, so
 * only a *recently* re-read stale note can still outrank fresh -- which is
 * the intended recency signal, not a bug.
 */
function applyStalePenalty(
  hits: Array<{ note: NoteRecord; score: number }>,
  cfg: StalenessConfig
): Array<{ note: NoteRecord; score: number }> {
  return hits
    .map((h) => ({ ...h, score: h.score * stalePenaltyFactor(h.note, cfg) }))
    .sort((a, b) => b.score - a.score); // stable: ties keep fetch order
}

/**
 * Bump access counters for notes *returned* to the caller (the top N), never
 * for every note the scorer scanned. Importance weighting should reflect
 * actual reads, not index churn.
 */
function bumpAccess(store: Store, notes: NoteRecord[]): void {
  // One UPDATE for the whole result set (BLOCKER 3): the old per-note loop
  // issued up to 200 autocommit UPDATEs per search -- each a WAL fsync --
  // which is also what made read bursts self-inflict write contention.
  // touchMany is best-effort, like touch().
  if (notes.length === 0) return;
  store.touchMany(notes.map((n) => n.id));
}

/**
 * Boost, stale-penalize, truncate to the result limit, bump access.
 * Shared by runSearch and runRelevantSearch so every search mode honors
 * the same contract: importance-weighted, staleness-aware, and
 * access-counted on what was actually returned.
 */
function finalizeResults(
  store: Store,
  hits: Array<{ note: NoteRecord; score: number }>,
  limit: number,
  staleCfg: StalenessConfig
): NoteRecord[] {
  const notes = applyStalePenalty(boostAndRank(hits), staleCfg)
    .slice(0, limit)
    .map((h) => h.note);
  bumpAccess(store, notes);
  return notes;
}

/**
 * Fair multi-namespace merge: round-robin interleave of per-namespace
 * ranked lists, truncated to `limit`. Concatenating in namespace order
 * starves later namespaces (at limit=5 the second namespace gets zero
 * hits); interleaving guarantees each namespace a fair share while
 * preserving every list's internal relevance order.
 */
export function roundRobin<T>(lists: T[][], limit: number): T[] {
  const out: T[] = [];
  const lim = Math.max(0, Math.floor(limit));
  for (let i = 0; out.length < lim; i++) {
    let advanced = false;
    for (const list of lists) {
      if (i < list.length) {
        out.push(list[i]);
        advanced = true;
        if (out.length >= lim) return out;
      }
    }
    if (!advanced) break;
  }
  return out;
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
  const finalize = (
    hits: Array<{ note: NoteRecord; score: number }>
  ): NoteRecord[] => finalizeResults(store, hits, limit, staleCfg);

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
 *
 * Ranking merges the per-keyword FTS5 bm25 rankings with Reciprocal Rank
 * Fusion, multiplied by the keyword-branch count: a note matching several
 * distinct keywords still outranks a single-keyword hit, but within the
 * same count the bm25 relevance wins -- a central-topic hit outranks a
 * passing mention instead of every branch counting the same and ties
 * breaking by recency.
 *
 * The merged hits run through the same finalize pipeline as runSearch
 * (access boost, staleness penalty, truncation, access bump), so the
 * vague-message path -- the one most likely to act on outdated facts --
 * honors the same staleness contract. Callers annotate results with
 * annotateStaleness for the stale/ageDays/staleWarning fields.
 */
export async function runRelevantSearch(
  store: Store,
  message: string,
  opts: RelevantOpts = {}
): Promise<{ keywords: string[]; results: NoteRecord[] }> {
  const keywords = extractKeywords(message);
  const limit = clampInt(opts.limit, 10, 1, 200);
  if (keywords.length === 0) return { keywords, results: [] };
  // Oversample per keyword (limit*2, clamped to 1..200 -- the 50 here is the
  // clampInt *default* for non-numeric input, not a floor) so the merge has
  // a real candidate pool before the final limit cut.
  const perKeyword = clampInt(Math.ceil(limit * 2), 50, 1, 200);
  const byId = new Map<number, NoteRecord>();
  const counts = new Map<number, number>();
  const lists: number[][] = [];
  for (const kw of keywords) {
    // searchRanked (not search): keep each hit's FTS5 bm25 score for the
    // merge below instead of discarding it.
    const ranked = store.searchRanked(kw, {
      namespace: opts.namespace,
      limit: perKeyword,
    });
    const ids: number[] = [];
    for (const h of ranked) {
      ids.push(h.note.id);
      if (!byId.has(h.note.id)) byId.set(h.note.id, h.note);
      counts.set(h.note.id, (counts.get(h.note.id) ?? 0) + 1);
    }
    lists.push(ids);
  }
  const fused = rrfScores(lists);
  const hits = [...fused.entries()].map(([id, rrf]) => ({
    note: byId.get(id)!,
    score: rrf * (counts.get(id) ?? 1),
  }));
  return {
    keywords,
    results: finalizeResults(store, hits, limit, stalenessConfig()),
  };
}
