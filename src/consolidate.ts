// Auto-consolidation / dedup: fights memory bloat from agents re-storing
// the same facts.
//
// Zero-dependency text similarity (cosine over term-frequency vectors as the
// primary metric, Jaccard as a secondary) finds near-duplicate notes, and
// consolidateNotes merges a set of duplicate ids into one note (union of
// tags, deduplicated bodies) with optional deletion of the sources.
//
// Safety notes:
// - Candidates are found same-namespace ONLY. Namespaces are an isolation
//   boundary; merging across them would leak one project's facts into
//   another's.
// - findCandidates is O(n^2). That's fine at personal-store scale, but the
//   input is capped: beyond 2000 notes only the 2000 most recently created
//   are scanned.

import { Store, ValidationError, clampInt } from "./store.js";
import type { NoteRecord } from "./store.js";

/** ~30 common English stopwords dropped before similarity scoring. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for",
  "with", "is", "are", "was", "were", "be", "been", "being", "it", "its",
  "this", "that", "these", "those", "as", "at", "by", "from", "we",
  "you", "i", "he", "she", "they", "not", "no", "do", "does", "did",
  "my", "our", "your", "have", "has", "had",
]);

/** Lowercase, split on non-alphanumeric, drop tokens < 2 chars + stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function cosineOfFreq(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 && b.size === 0) return 1; // identical (both empty)
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  for (const [tok, ca] of a) {
    const cb = b.get(tok);
    if (cb !== undefined) dot += ca * cb;
  }
  let na = 0;
  for (const ca of a.values()) na += ca * ca;
  let nb = 0;
  for (const cb of b.values()) nb += cb * cb;
  if (na === 0 || nb === 0) return 0;
  // Clamp to [0, 1]: term frequencies are non-negative so the true cosine
  // can't leave that range — only floating-point rounding can (e.g.
  // 1.0000000000000002 for identical inputs), which would break exact
  // comparisons like `score === 1` downstream.
  return Math.min(1, Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

/**
 * Cosine similarity of two texts over term-frequency vectors.
 * 1 = identical token multisets, 0 = no shared content tokens.
 */
export function cosineSimilarity(a: string, b: string): number {
  return cosineOfFreq(termFreq(tokenize(a)), termFreq(tokenize(b)));
}

/**
 * Jaccard similarity of two texts over token SETS (|intersection|/|union|).
 * Secondary metric — exported for tests and for callers that want a
 * set-overlap view rather than frequency weighting.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export interface CandidatePair {
  idA: number;
  idB: number;
  score: number;
}

/** Clamp a caller-supplied similarity threshold into a sane band (0.5..1.0). */
export function clampThreshold(v: number | undefined, def = 0.95): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.min(Math.max(n, 0.5), 1.0);
}

/** Personal-store scale cap: scanning is O(n^2), so cap the input. */
export const MAX_CANDIDATE_NOTES = 2000;

/**
 * Find near-duplicate note pairs. Same-namespace only; each pair appears
 * once (idA < idB); sorted by score descending; capped at `limit`.
 * If more than 2000 notes are passed, only the 2000 most recently created
 * are scanned (documented performance guard).
 */
export function findCandidates(
  notes: NoteRecord[],
  opts: { threshold?: number; limit?: number } = {}
): CandidatePair[] {
  const threshold = clampThreshold(opts.threshold, 0.95);
  const limit = clampInt(opts.limit, 50, 1, 500);

  const pool =
    notes.length > MAX_CANDIDATE_NOTES
      ? [...notes]
          .sort(
            (x, y) =>
              y.created_at.localeCompare(x.created_at) || y.id - x.id
          )
          .slice(0, MAX_CANDIDATE_NOTES)
      : notes;

  const docs = pool.map((note) => ({
    note,
    freq: termFreq(tokenize(`${note.title} ${note.body}`)),
  }));

  const pairs: CandidatePair[] = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const na = docs[i].note;
      const nb = docs[j].note;
      if (na.id === nb.id) continue;
      if (na.namespace !== nb.namespace) continue; // never merge across namespaces
      const score = cosineOfFreq(docs[i].freq, docs[j].freq);
      // 1e-9 epsilon: floating-point rounding can put a true-1.0 score a hair
      // below the threshold (e.g. 0.9999999999999999 vs 1.0), which would
      // wrongly exclude exact duplicates at threshold 1.0.
      if (score + 1e-9 >= threshold) {
        // Snap FP noise at the boundary: a score within 1e-9 of 1 is an
        // exact duplicate as far as any consumer is concerned.
        const snapped = score > 1 - 1e-9 ? 1 : score;
        pairs.push({
          idA: Math.min(na.id, nb.id),
          idB: Math.max(na.id, nb.id),
          score: snapped,
        });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.idA - y.idA || x.idB - y.idB);
  return pairs.slice(0, limit);
}

export interface ConsolidationPreview {
  namespace: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
}

/**
 * Compute what a merge of these notes would produce, without writing
 * anything. Shared by consolidateNotes and the dry-run paths.
 */
export function buildConsolidationPreview(
  notes: NoteRecord[],
  mergedTitle?: string
): ConsolidationPreview {
  const title =
    mergedTitle?.trim() ||
    notes.reduce((longest, n) =>
      n.title.length >= longest.title.length ? n : longest
    ).title;

  // Deduplicated concatenation: exact-duplicate bodies appear once.
  const seen = new Set<string>();
  const bodies: string[] = [];
  for (const n of notes) {
    if (!seen.has(n.body)) {
      seen.add(n.body);
      bodies.push(n.body);
    }
  }

  return {
    namespace: notes[0].namespace,
    title,
    body: bodies.join("\n\n---\n\n"),
    tags: [...new Set(notes.flatMap((n) => n.tags))],
    // store.create slices source to 200 chars; union here and let it enforce.
    source: [...new Set(notes.map((n) => n.source).filter(Boolean))].join(","),
  };
}

/**
 * Resolve + validate the ids for a consolidation: 2+ distinct ids, all
 * exist, all in one namespace. Throws ValidationError otherwise.
 */
export function resolveConsolidationNotes(store: Store, ids: number[]): NoteRecord[] {
  if (!ids || ids.length < 2) {
    throw new ValidationError("consolidation needs at least 2 note ids");
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length < 2) {
    throw new ValidationError("consolidation needs at least 2 distinct note ids");
  }
  const notes = uniqueIds.map((id) => {
    const n = store.read(id);
    if (!n) throw new ValidationError(`no note with id ${id}`);
    return n;
  });
  const namespace = notes[0].namespace;
  if (!notes.every((n) => n.namespace === namespace)) {
    throw new ValidationError("cannot consolidate notes from different namespaces");
  }
  return notes;
}

/**
 * Merge a set of duplicate notes into one. Creates the merged note, then
 * deletes the sources by default (the point is dedup) unless
 * `deleteSources: false` is passed. Throws ValidationError on bad input;
 * callers (MCP/CLI) map that to a clean error.
 */
export function consolidateNotes(
  store: Store,
  ids: number[],
  opts: { deleteSources?: boolean; mergedTitle?: string } = {}
): NoteRecord {
  const notes = resolveConsolidationNotes(store, ids);

  const preview = buildConsolidationPreview(notes, opts.mergedTitle);
  const merged = store.create({
    namespace: preview.namespace,
    title: preview.title,
    body: preview.body,
    tags: preview.tags,
    source: preview.source,
  });

  if (opts.deleteSources !== false) {
    for (const n of notes) store.delete(n.id);
  }
  return merged;
}

/**
 * Group candidate pairs into connected components (union-find) so an
 * A-B, B-C chain merges as one group instead of failing on the second
 * pair's already-deleted note.
 */
export function groupCandidateIds(pairs: CandidatePair[]): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression.
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const p of pairs) {
    const ra = find(p.idA);
    const rb = find(p.idB);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<number, number[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(id);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a - b));
}
