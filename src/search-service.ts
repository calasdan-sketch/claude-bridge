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
}

/** Run a search, resolving mode and falling back to keyword when needed. */
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

  const keyword = (): NoteRecord[] => store.search(query, { namespace: opts.namespace, limit });

  if (mode === "keyword" || !embeddingsEnabled()) return keyword();

  const qv = await embed(query);
  if (!qv) return keyword(); // endpoint down / not embeddable -> graceful fallback

  const semHits = store.semanticSearch(qv, { namespace: opts.namespace, limit });

  if (mode === "semantic") return semHits.map((h) => h.note);

  // hybrid: fuse the two rankings, then resolve ids back to records.
  const ftsRecords = keyword();
  const fusedIds = rrfMerge([
    ftsRecords.map((n) => n.id),
    semHits.map((h) => h.note.id),
  ]).slice(0, limit);

  const byId = new Map<number, NoteRecord>();
  for (const n of ftsRecords) byId.set(n.id, n);
  for (const h of semHits) byId.set(h.note.id, h.note);
  return fusedIds.map((id) => byId.get(id)!).filter(Boolean);
}
