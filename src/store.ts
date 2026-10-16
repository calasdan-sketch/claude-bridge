// SQLite-backed note store shared by the HTTP API and the MCP server.
//
// Uses Node's built-in node:sqlite (DatabaseSync) -- no native module build
// step, ships in the Node binary, and its bundled SQLite has FTS5 compiled
// in (verified at build time on this machine). Keeping the dependency
// footprint at zero for the storage layer is deliberate: fewer deps, fewer
// CVEs, one less thing to break on a different machine.
//
// FTS sync strategy: the notes_fts table is an external-content FTS5 index
// over `notes`, kept in lockstep by SQL triggers (AFTER INSERT/UPDATE/DELETE).
// This means search can never go stale after a write -- there is no
// app-level "remember to reindex" step to forget.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { checkSizes, scanForSecrets, audit } from "./security.js";
// Reuses consolidate.ts's zero-dependency text similarity for the note
// similarity graph. This is a module cycle (consolidate.ts imports Store
// from here), but a safe one: both modules only touch the other's bindings
// inside function bodies at runtime, never during module evaluation.
import {
  precomputeTfMaps,
  computeDocFreqs,
  cosineTfIdf,
  sharedTokenCount,
  MIN_SHARED_TOKENS_FOR_EDGE,
} from "./consolidate.js";
// No module cycle: staleness.ts imports config.ts at runtime and store.ts
// only as a type (erased at compile), so store -> staleness -> config is
// acyclic.
import { isStale, stalenessConfig, annotateStaleness } from "./staleness.js";

/**
 * A caller-input error (bad/oversized/secret-bearing data, empty title, stale
 * write). The HTTP layer maps these to 400 with the message shown; anything
 * else is an unexpected fault mapped to a generic 500, so internals never leak.
 */
export class ValidationError extends Error {}

/** Reject oversized input and anything that looks like a stored secret. */
function validateContent(input: {
  title?: string;
  body?: string;
  tags?: string[];
  source?: string;
}): void {
  const sizeErr = checkSizes(input);
  if (sizeErr) throw new ValidationError(sizeErr);
  // Scan title, body, AND source: a credential can land in any free-text field.
  const secret =
    scanForSecrets(input.title) || scanForSecrets(input.body) || scanForSecrets(input.source);
  if (secret) {
    throw new ValidationError(
      `refusing to store what looks like a ${secret}; remove the secret or store a reference to it instead`
    );
  }
}

export interface NoteInput {
  namespace?: string;
  title: string;
  body?: string;
  tags?: string[];
  source?: string;
  /**
   * Optional backdate for created_at (ISO-8601 string). Used internally by
   * consolidation so a merged note keeps its oldest source's date, and by
   * /import so a backup restore preserves original dates. Unparsable values
   * are ignored (created_at falls back to now).
   */
  created_at?: string;
}

export interface NotePatch {
  namespace?: string;
  title?: string;
  body?: string;
  tags?: string[];
  source?: string;
}

export interface NoteRecord {
  id: number;
  namespace: string;
  title: string;
  body: string;
  tags: string[];
  rev: number;
  source: string;
  created_at: string;
  updated_at: string;
  /** Read-importance tracking: total user-facing reads of this note. */
  access_count: number;
  /** ISO-8601 timestamp of the most recent read; null = never read. */
  last_accessed: string | null;
}

interface NoteRow {
  id: number;
  namespace: string;
  title: string;
  body: string;
  tags: string;
  rev: number;
  source: string;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string | null;
}

const DEFAULT_NAMESPACE = "default";

function rowToRecord(row: NoteRow): NoteRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    title: row.title,
    body: row.body,
    tags: parseTags(row.tags),
    rev: row.rev ?? 1,
    source: row.source ?? "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    access_count: row.access_count ?? 0,
    last_accessed: row.last_accessed ?? null,
  };
}

function tagsToStorage(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  // Store as a JSON array so tags can contain commas/spaces; dedupe + trim.
  const cleaned = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
  return cleaned.length ? JSON.stringify(cleaned) : "";
}

function parseTags(raw: string): string[] {
  if (!raw) return [];
  if (raw[0] === "[") {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a.filter((x) => typeof x === "string");
    } catch {
      /* fall through to legacy comma parse */
    }
  }
  return raw.split(",").map((t) => t.trim()).filter(Boolean); // legacy rows
}

/** Build an FTS5 MATCH expression: AND of prefix-matched, quote-escaped tokens. */
function buildMatchQuery(q: string): string {
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)) // keep only tokens with a letter/number
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return tokens.join(" AND "); // "" when nothing usable; caller returns []
}

/** Coerce a possibly-NaN/undefined value to a bounded integer with a default. */
export function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, min), max);
}

// --- Similarity edge graph (v4) -------------------------------------------

/**
 * Default cosine-similarity floor for creating a similarity edge.
 *
 * Was 0.35, cargo-culted from llmem's BM25-based metric (a different scale).
 * Re-tuned 2026-10-16 (I-HIGH-1) by sweeping 0.15–0.60 on 150 hand-labeled
 * note pairs (75 similar / 75 not, incl. shared-token traps) scored with
 * TF-IDF cosine + a minimum-support floor of MIN_SHARED_TOKENS_FOR_EDGE
 * shared content tokens: F1 peaks at 0.851 on the 0.15–0.25 plateau
 * (P 0.863, R 0.840); 0.25 is the top of the plateau, chosen to favor
 * precision (a junk edge pollutes the neighbor list; a missed edge is just
 * one less suggestion — FTS still finds the note). Dataset + script:
 * reviews/tier2-threshold-sweep/. 12/75 positives are unreachable by any
 * token metric (no shared content tokens) — the documented recall ceiling.
 *
 * This is the *default*: the active threshold is persisted per-database in
 * the _meta table (see getEdgeThreshold/setEdgeThreshold) so operators can
 * retune without a code change, and every write path reads it — no
 * mixed-threshold graphs.
 */
export const EDGE_SIMILARITY_THRESHOLD = 0.25;

/** Max neighbors attached to a single note read (state_read neighbors:true). */
export const EDGE_NEIGHBOR_LIMIT = 10;

/**
 * Cooperative rebuild cadence: rebuildEdgesCooperative yields to the event
 * loop this often (pair checks) so a large rebuild never freezes concurrent
 * API/MCP traffic. Mirrors CANDIDATE_YIELD_EVERY in consolidate.ts.
 */
export const REBUILD_YIELD_EVERY = 8192;

/**
 * Rebuild chunk size: outer-loop notes per committed chunk transaction.
 * Each chunk = score this band's pairs (no lock held, yields every
 * REBUILD_YIELD_EVERY pairs), then commit that band's edge inserts in one
 * short transaction. Chunk boundaries are the resume points: progress is
 * recorded in the _meta table per chunk, so an interrupted rebuild resumes
 * instead of restarting from scratch.
 */
export const REBUILD_BAND_NOTES = 256;

/**
 * MCP memory_rebuild_edges confirmation gate: above this many notes in
 * scope the tool refuses unless the caller passes confirm: true (the
 * rebuild is O(n^2) CPU even though it no longer freezes the server).
 */
export const REBUILD_CONFIRM_NOTE_COUNT = 2000;

/**
 * CLI rebuild-edges confirmation gate: above this many pairs the CLI asks
 * for confirmation (or requires --yes) before scoring.
 */
export const REBUILD_CONFIRM_PAIR_COUNT = 500_000;

/** Resume-progress row for an interrupted rebuildEdgesCooperative run. */
const REBUILD_PROGRESS_KEY = "rebuild_edges_progress";

/** One directed similarity edge endpoint: a similar note + the pair's score. */
export interface NeighborEntry {
  id: number;
  title: string;
  score: number;
  /** Staleness of the neighbor, annotated at read time (I-LOW-1): a stale
   * neighbor is still a valid suggestion, but the caller should verify it
   * before acting on it. Optional because listNeighbors() returns the raw
   * graph shape; read() attaches these via annotatedNeighbors(). */
  stale?: boolean;
  /** Whole days since the neighbor's updated_at (floored; never negative). */
  ageDays?: number;
  /** Human-readable warning, present only when the neighbor is stale. */
  staleWarning?: string;
}

export interface ReadOpts {
  /**
   * Marks a *user-facing* read (HTTP GET /notes/:id, MCP state_read):
   * bumps access_count / last_accessed. Internal reads leave counters
   * alone so system churn never inflates importance.
   */
  trackAccess?: boolean;
  /** When true, attach up to EDGE_NEIGHBOR_LIMIT same-namespace neighbors. */
  withNeighbors?: boolean;
}

export interface RebuildEdgesResult {
  /** Directed edge rows inserted by the rebuild. */
  created: number;
  /** Directed edge rows deleted by the rebuild. */
  removed: number;
}

/** One namespace's share of a rebuild: note count + pair count (n·(n−1)/2). */
export interface RebuildPlanEntry {
  namespace: string;
  notes: number;
  pairs: number;
}

export interface RebuildEdgesOptions {
  threshold?: number;
  namespace?: string;
  /**
   * Progress callback, fired every REBUILD_YIELD_EVERY pair checks, at each
   * chunk boundary, and on completion: (pairsDone, pairsTotal).
   */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Validate a caller-supplied edge similarity threshold. Undefined means the
 * default; anything outside (0, 1] (or non-numeric) is a caller error, not
 * something to silently clamp -- a rewritten threshold changes which edges
 * exist, so the caller should know its value was wrong.
 */
export function resolveEdgeThreshold(v: number | undefined): number {
  const t = v === undefined ? EDGE_SIMILARITY_THRESHOLD : v;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 1) {
    throw new ValidationError(`threshold must be a number in (0, 1] (got ${v})`);
  }
  return t;
}

/** Pack a Float32Array into bytes for a SQLite BLOB. */
function vecToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Rebuild a Float32Array from BLOB bytes, copying to a fresh, aligned buffer. */
function blobToVec(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.length);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.length / 4));
}

/** Cosine similarity of two equal-length vectors; 0 if degenerate. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SemanticHit {
  note: NoteRecord;
  score: number;
}

/** Aggregate access-tracking numbers for the memory_stats surface. */
export interface AccessStats {
  /** Notes counted (within the requested namespaces, if any). */
  totalNotes: number;
  /** Sum of access_count over those notes. */
  totalAccesses: number;
  /** Up to 10 hottest notes: id, title, access_count (no bodies leaked). */
  mostAccessed: Array<{ id: number; title: string; access_count: number }>;
  /** Notes with last_accessed NULL -- never read; the dead-memory candidates. */
  neverAccessed: number;
  /** Notes older than the staleness thresholds (see staleness.ts). */
  staleCount: number;
}

/** One keyword hit with its FTS5 bm25 rank exposed as a positive score. */
export interface RankedHit {
  note: NoteRecord;
  /** Higher = better match. FTS5's `rank` is negative (lower = better), so
   *  this is -rank: identical documents score identically, which is exactly
   *  the tie the access-count boost is meant to break. */
  score: number;
}

interface VectorRow {
  note_id: number;
  dim: number;
  model: string;
  vec: Uint8Array;
}

export interface RangeOpts {
  /**
   * ISO-8601 bounds scoping results to notes created in [startISO, endISO).
   * Scopes on created_at ("when it was written"), not updated_at: an edit
   * tomorrow doesn't move a note out of "yesterday". End is exclusive so
   * adjacent day ranges tile without overlap.
   */
  startISO?: string;
  endISO?: string;
}

function rangeClause(opts: RangeOpts): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (opts.startISO) {
    clauses.push("notes.created_at >= ?");
    params.push(opts.startISO);
  }
  if (opts.endISO) {
    clauses.push("notes.created_at < ?");
    params.push(opts.endISO);
  }
  return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", params };
}

export class Store {
  private db: DatabaseSync;
  private readonly dbPath: string;

  /**
   * How long a statement waits on a contended SQLite lock before giving up
   * with SQLITE_BUSY. Reads (touch/touchMany) run best-effort with a zero
   * timeout instead (see bestEffortWrite): a lost read-count is acceptable,
   * a failed or stalled read is not.
   */
  private static readonly BUSY_TIMEOUT_MS = 5000;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`PRAGMA busy_timeout = ${Store.BUSY_TIMEOUT_MS};`);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL DEFAULT '${DEFAULT_NAMESPACE}',
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notes_namespace ON notes(namespace);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notes_ns_created ON notes(namespace, created_at);
    `);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, body, tags,
        content='notes', content_rowid='id'
      );
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, new.tags);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
        VALUES('delete', old.id, old.title, old.body, old.tags);
      END;
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
        VALUES('delete', old.id, old.title, old.body, old.tags);
        INSERT INTO notes_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, new.tags);
      END;
    `);
    this.migrate();
  }

  /** Idempotent schema migrations, versioned via PRAGMA user_version. */
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    const v = row?.user_version ?? 0;
    if (v < 1) {
      // v1: add note revision (for compare-and-swap) + provenance source.
      this.db.exec("BEGIN");
      try {
        this.db.exec("ALTER TABLE notes ADD COLUMN rev INTEGER NOT NULL DEFAULT 1");
        this.db.exec("ALTER TABLE notes ADD COLUMN source TEXT NOT NULL DEFAULT ''");
        this.db.exec("PRAGMA user_version = 1");
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    if (v < 2) {
      // v2: optional semantic search. One embedding per note, stored as a
      // raw Float32 BLOB. FOREIGN KEY ... ON DELETE CASCADE (foreign_keys is
      // ON) retires a note's vector automatically when the note is deleted.
      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS note_vectors (
            note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
            dim INTEGER NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            vec BLOB NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
        this.db.exec("PRAGMA user_version = 2");
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    if (v < 3) {
      // v3: access tracking for importance weighting. access_count counts
      // every user-facing read of a note; last_accessed holds the most recent
      // read's ISO timestamp (NULL = never read, the "dead memory" signal).
      // Neither is touched by writes: updated_at keeps meaning "content
      // changed", last_accessed means "someone actually looked at it".
      this.db.exec("BEGIN");
      try {
        this.db.exec(
          "ALTER TABLE notes ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0"
        );
        this.db.exec("ALTER TABLE notes ADD COLUMN last_accessed TEXT");
        this.db.exec("PRAGMA user_version = 3");
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    if (v < 4) {
      // v4: similarity edge graph. Each row is one directed edge
      // (note -> neighbor) carrying the pair's cosine similarity score; both
      // directions are stored so neighbor lookup is a single indexed query.
      // Edges are same-namespace ONLY (never created across namespaces).
      // FOREIGN KEY ... ON DELETE CASCADE (foreign_keys is ON) retires a
      // note's edges automatically when the note is deleted.
      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS note_edges (
            note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            neighbor_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            score REAL NOT NULL,
            PRIMARY KEY (note_id, neighbor_id)
          );
        `);
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS idx_note_edges_note_id ON note_edges(note_id)"
        );
        this.db.exec("PRAGMA user_version = 4");
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    if (v < 5) {
      // v5: gate the FTS UPDATE trigger on content columns + add the _meta
      // key/value table (rebuild resume progress). The old notes_au fired on
      // EVERY update -- including touch()/touchMany()'s metadata-only
      // access-counter bump -- costing a full FTS5 delete + re-insert per
      // read (BLOCKER 2: a search's bumpAccess issued ~3 write statements
      // per returned note). The gated trigger only re-indexes when title,
      // body, or tags actually change; access_count/last_accessed bumps no
      // longer touch the FTS index at all.
      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS _meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `);
        this.db.exec("DROP TRIGGER IF EXISTS notes_au");
        this.db.exec(`
          CREATE TRIGGER notes_au AFTER UPDATE ON notes
          WHEN (old.title IS NOT new.title OR old.body IS NOT new.body OR old.tags IS NOT new.tags)
          BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
            VALUES('delete', old.id, old.title, old.body, old.tags);
            INSERT INTO notes_fts(rowid, title, body, tags)
            VALUES (new.id, new.title, new.body, new.tags);
          END;
        `);
        this.db.exec("PRAGMA user_version = 5");
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    if (v < 6) {
      // v6: edge-graph hardening (Tier 2 review D-MEDIUM-1). The
      // reverse-direction edge DELETE (WHERE note_id = ? OR neighbor_id = ?)
      // had only idx_note_edges_note_id and scanned O(E) per write; the
      // neighbor-direction index fixes that. The composite (note_id, score
      // DESC) covers listNeighbors' WHERE note_id = ? + ORDER BY score DESC.
      // (_meta itself was added in v5; see getEdgeThreshold for the
      // threshold-persistence contract.)
      this.db.exec("BEGIN");
      try {
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS idx_note_edges_neighbor ON note_edges(neighbor_id)"
        );
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS idx_note_edges_note_score ON note_edges(note_id, score DESC)"
        );
        this.db.exec("PRAGMA user_version = 6");
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  create(input: NoteInput, opts: { skipEdges?: boolean } = {}): NoteRecord {
    if (!input.title || !input.title.trim()) {
      throw new ValidationError("title is required");
    }
    validateContent(input);
    const now = new Date().toISOString();
    // Backdate support (consolidation + import/restore): honor an explicit
    // created_at when it parses, otherwise the note was just written.
    const createdAt =
      input.created_at && !Number.isNaN(Date.parse(input.created_at))
        ? new Date(input.created_at).toISOString()
        : now;
    const namespace = input.namespace?.trim() || DEFAULT_NAMESPACE;
    const body = input.body ?? "";
    const tags = tagsToStorage(input.tags);
    const source = (input.source ?? "").slice(0, 200);

    const stmt = this.db.prepare(`
      INSERT INTO notes (namespace, title, body, tags, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(namespace, input.title, body, tags, source, createdAt, now);
    const id = Number(result.lastInsertRowid);
    audit({ op: "create", id, namespace, bytes: body.length });
    // Link the new note into the similarity graph: O(n) cosine comparisons
    // against same-namespace notes (never cross-namespace). Pure CPU plus
    // the edge inserts -- acceptable on the write path at personal-store
    // scale. Must not open its own transaction: create() is also called
    // inside consolidateNotes' store.transaction(). skipEdges lets a caller
    // that pre-scored the edges (consolidateNotes) apply them itself instead.
    //
    // D-HIGH-2: the edge loop is all-or-nothing. The INSERT above is already
    // committed (autocommit), but a crash mid-loop used to leave a partial
    // edge set with no incompleteness record. A SAVEPOINT makes the DELETE +
    // inserts atomic -- and nests safely inside consolidateNotes'
    // store.transaction() (savepoints nest; ROLLBACK TO / RELEASE only touch
    // the savepoint level, never the outer transaction).
    if (!opts.skipEdges) {
      this.db.exec("SAVEPOINT onememory_create_edges");
      try {
        this.recomputeEdgesFor(id, namespace, input.title, body, this.getEdgeThreshold());
        this.db.exec("RELEASE onememory_create_edges");
      } catch (e) {
        try {
          this.db.exec("ROLLBACK TO onememory_create_edges");
        } catch {
          /* savepoint already gone -- rethrow the original */
        }
        try {
          this.db.exec("RELEASE onememory_create_edges");
        } catch {
          /* savepoint already gone -- rethrow the original */
        }
        throw e;
      }
    }
    return this.read(id)!;
  }

  read(id: number, opts: ReadOpts = {}): (NoteRecord & { neighbors?: NeighborEntry[] }) | null {
    // trackAccess marks a *user-facing* read (HTTP GET /notes/:id, MCP
    // state_read). Internal reads (update()'s re-read, consolidation, export)
    // pass nothing and leave the counters alone, so system churn never
    // inflates importance. Touch first so the returned record already
    // reflects the bumped count.
    if (opts.trackAccess) this.touch(id);
    const row = this.db
      .prepare("SELECT * FROM notes WHERE id = ?")
      .get(id) as NoteRow | undefined;
    if (!row) return null;
    const record = rowToRecord(row);
    if (!opts.withNeighbors) return record;
    // The `neighbors` key is only present when requested: existing callers
    // (and their deepEqual assertions) see a byte-identical shape otherwise.
    return { ...record, neighbors: this.annotatedNeighbors(id) };
  }

  /**
   * This note's similar neighbors with staleness fields attached (I-LOW-1).
   * The neighbor records are read untracked (internal reads never bump
   * access counters); only the staleness annotation is kept, so the payload
   * stays the small NeighborEntry shape.
   */
  private annotatedNeighbors(id: number): NeighborEntry[] {
    return this.listNeighbors(id, EDGE_NEIGHBOR_LIMIT).map((n) => {
      const full = this.read(n.id);
      const ann = full ? annotateStaleness(full) : null;
      return {
        ...n,
        stale: ann?.stale ?? false,
        ageDays: ann?.ageDays ?? 0,
        ...(ann?.staleWarning ? { staleWarning: ann.staleWarning } : {}),
      };
    });
  }

  /**
   * Run an access-tracking write best-effort (BLOCKER 3): with a zero busy
   * timeout so lock contention fails fast instead of stalling the caller
   * for BUSY_TIMEOUT_MS, and swallowing any error. Access counters are
   * telemetry, not data -- a lost read-count is acceptable, a failed or
   * stalled read is not. Never call this inside a write transaction: it is
   * only for fire-and-forget autocommit counter bumps.
   */
  private bestEffortWrite(fn: () => void): void {
    try {
      this.db.exec("PRAGMA busy_timeout = 0;");
      try {
        fn();
      } finally {
        this.db.exec(`PRAGMA busy_timeout = ${Store.BUSY_TIMEOUT_MS};`);
      }
    } catch {
      /* best-effort: skip silently */
    }
  }

  /**
   * Record one user-facing read of a note: access_count + 1, last_accessed =
   * now (ISO). Fire-and-forget: a missing id is a silent no-op, never an
   * error, and write contention is skipped rather than thrown, so a plain
   * GET can never 500 because of a contended counter bump. updated_at is
   * deliberately left alone -- a read is not a change, so "newest first"
   * listings don't get churned by popularity.
   */
  touch(id: number): void {
    this.bestEffortWrite(() => {
      this.db
        .prepare(
          "UPDATE notes SET access_count = access_count + 1, last_accessed = ? WHERE id = ?"
        )
        .run(new Date().toISOString(), id);
    });
  }

  /**
   * Batched touch(): one UPDATE bumps every id (BLOCKER 3 -- the old
   * per-note loop in search-service's bumpAccess issued up to 200 autocommit
   * UPDATEs per search, each an fsync). Same best-effort contract as
   * touch(): contention or a missing id never throws.
   */
  touchMany(ids: number[]): void {
    const unique = [...new Set(ids)].filter((n) => Number.isInteger(n));
    if (unique.length === 0) return;
    this.bestEffortWrite(() => {
      this.db
        .prepare(
          `UPDATE notes SET access_count = access_count + 1, last_accessed = ?
           WHERE id IN (${unique.map(() => "?").join(",")})`
        )
        .run(new Date().toISOString(), ...unique);
    });
  }

  /**
   * Access-tracking aggregates for the memory_stats surface. When
   * `namespaces` is given, only those namespaces are counted (namespace
   * resolution passes the readable set; an MCP hint passes one). Omit it to
   * count the whole store (legacy no-resolution mode).
   */
  accessStats(namespaces?: string[]): AccessStats {
    const where =
      namespaces && namespaces.length > 0
        ? `WHERE namespace IN (${namespaces.map(() => "?").join(",")})`
        : "";
    const params: string[] = namespaces && namespaces.length > 0 ? [...namespaces] : [];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(access_count), 0) AS accesses,
                COALESCE(SUM(CASE WHEN last_accessed IS NULL THEN 1 ELSE 0 END), 0) AS never
         FROM notes ${where}`
      )
      .get(...params) as { n: number; accesses: number; never: number };
    const top = this.db
      .prepare(
        `SELECT id, title, access_count FROM notes ${where}
         ORDER BY access_count DESC, id ASC LIMIT 10`
      )
      .all(...params) as Array<{ id: number; title: string; access_count: number }>;
    return {
      totalNotes: Number(totals.n),
      totalAccesses: Number(totals.accesses),
      mostAccessed: top.map((r) => ({
        id: Number(r.id),
        title: r.title,
        access_count: Number(r.access_count),
      })),
      neverAccessed: Number(totals.never),
      staleCount: this.staleCount(namespaces),
    };
  }

  /**
   * How many notes are stale under the current staleness config (see
   * staleness.ts). Staleness needs only tags + updated_at, so this scans a
   * narrow projection rather than full records; bodies never leave the DB.
   */
  staleCount(namespaces?: string[]): number {
    const where =
      namespaces && namespaces.length > 0
        ? `WHERE namespace IN (${namespaces.map(() => "?").join(",")})`
        : "";
    const params: string[] = namespaces && namespaces.length > 0 ? [...namespaces] : [];
    const rows = this.db
      .prepare(`SELECT tags, updated_at FROM notes ${where}`)
      .all(...params) as Array<{ tags: string; updated_at: string }>;
    const cfg = stalenessConfig();
    let n = 0;
    for (const r of rows) {
      // isStale only reads tags and updated_at; the rest is filler.
      const probe: NoteRecord = {
        id: 0,
        namespace: "",
        title: "",
        body: "",
        tags: parseTags(r.tags),
        rev: 1,
        source: "",
        created_at: r.updated_at,
        updated_at: r.updated_at,
        access_count: 0,
        last_accessed: null,
      };
      if (isStale(probe, cfg).stale) n++;
    }
    return n;
  }

  update(id: number, patch: NotePatch, opts: { ifRev?: number } = {}): NoteRecord | null {
    const existing = this.read(id);
    if (!existing) return null;

    if (patch.title !== undefined && !patch.title.trim()) {
      throw new ValidationError("title cannot be empty");
    }

    const nsTrim = patch.namespace?.trim();
    const namespace = nsTrim ? nsTrim : existing.namespace;
    const title = patch.title ?? existing.title;
    const body = patch.body ?? existing.body;
    const tags = patch.tags !== undefined ? tagsToStorage(patch.tags) : tagsToStorage(existing.tags);
    const source = patch.source !== undefined ? patch.source.slice(0, 200) : existing.source;
    const rev = existing.rev + 1;
    validateContent({ title, body, tags: patch.tags ?? existing.tags, source });
    const now = new Date().toISOString();

    // BLOCKER 3: score the new text against a pre-transaction snapshot.
    // Cosine scoring is O(namespace-size) CPU; holding BEGIN IMMEDIATE
    // through it starves concurrent readers (their touch() busy-waits) and
    // writers alike. The write transaction below is then short: row update,
    // vector invalidation, edge apply.
    const selfExcl = new Set([id]);
    const edgePlan = this.planEdges(namespace, title, body, this.getEdgeThreshold(), selfExcl);
    // Compare-and-swap as a single atomic statement. The `ifRev` guard lives in
    // the WHERE clause (not a separate read-then-check) so two writers on
    // different connections/processes -- the exact cross-surface case this
    // feature exists for (phone + desktop sharing one state.db) -- can't both
    // pass the check and then clobber each other. `ifRev = null` means "force".
    // The vector-invalidation runs in the same transaction so a note's text and
    // its (now dropped) stale embedding never diverge.
    const want = opts.ifRev ?? null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const res = this.db
        .prepare(
          `UPDATE notes SET namespace = ?, title = ?, body = ?, tags = ?, source = ?, rev = ?, updated_at = ?
           WHERE id = ? AND (? IS NULL OR rev = ?)`
        )
        .run(namespace, title, body, tags, source, rev, now, id, want, want);

      if (Number(res.changes) === 0) {
        // The row either vanished or its rev moved since we read it.
        this.db.exec("ROLLBACK");
        const current = this.read(id);
        if (!current) return null; // deleted concurrently -> not found
        throw new ValidationError(
          `stale write: note ${id} is at rev ${current.rev} (you have ${opts.ifRev}); re-read and retry`
        );
      }

      // Invalidate the embedding: the note's text just changed, so the stored
      // vector is now stale. Drop it rather than keep a vector that no longer
      // matches the content -- the note falls back to keyword search, and the
      // write path (maybeEmbed) or `reindex` recomputes it. Without this, a
      // failed re-embed would leave a permanently wrong vector that semantic
      // search would happily return.
      this.db.prepare("DELETE FROM note_vectors WHERE note_id = ?").run(id);
      // Rebuild this note's similarity edges against its (possibly new)
      // namespace: the text changed, so old edges may be wrong, and a
      // namespace change strands edges against the old namespace's notes.
      // Same transaction, so text and graph never diverge. The pairs were
      // scored pre-transaction (see above); re-validate the snapshot under
      // the write lock and rescore in-transaction on mismatch -- a
      // concurrent add/remove/text-change in this namespace would otherwise
      // apply stale edges (the rescore is stable: we hold the lock).
      let edgePairs = edgePlan.pairs;
      if (!this.edgePlanValid(namespace, selfExcl, edgePlan.fingerprint)) {
        edgePairs = this.planEdges(
          namespace,
          title,
          body,
          this.getEdgeThreshold(),
          selfExcl
        ).pairs;
      }
      this.applyEdgePairs(id, edgePairs);
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back or no active transaction */
      }
      throw e;
    }

    audit({ op: "update", id, namespace, bytes: body.length });
    return this.read(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    const ok = Number(result.changes) > 0;
    if (ok) audit({ op: "delete", id });
    return ok;
  }

  /**
   * Guarded delete: only deletes when the note's rev still matches what the
   * caller last read (the delete-side twin of update()'s compare-and-swap).
   * Returns true if a row was deleted. Use it inside a transaction, after a
   * fresh re-read, so a concurrent writer racing the delete can't be
   * silently destroyed.
   */
  deleteIfRev(id: number, rev: number): boolean {
    const result = this.db
      .prepare("DELETE FROM notes WHERE id = ? AND rev = ?")
      .run(id, rev);
    const ok = Number(result.changes) > 0;
    if (ok) audit({ op: "delete", id });
    return ok;
  }

  /**
   * Run fn inside a single SQLite transaction (BEGIN IMMEDIATE / COMMIT;
   * ROLLBACK on any throw, then the error rethrows). This is the
   * multi-statement atomicity primitive: use it whenever a group of writes
   * must land together or not at all (e.g. consolidation's create + N
   * deletes), instead of relying on SQLite's per-statement implicit
   * transactions -- a crash between statements would leave a half-applied
   * operation with no record of the in-flight work.
   *
   * Note: Store.update() predates this helper and manages its own
   * BEGIN/COMMIT inline because it needs to distinguish a stale rev from a
   * vanished row after a failed compare-and-swap; the outcome is identical.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back or no active transaction -- rethrow the original */
      }
      throw e;
    }
  }

  /**
   * True when another connection currently holds the SQLite write lock
   * (e.g. a running server mid-write). Probes with a throwaway connection
   * and a zero busy-timeout, so the probe itself never blocks: a held lock
   * means an in-flight write transaction, not just an open database. The
   * CLI rebuild-edges refuses in that case (unless --force) rather than
   * contending with the server. Best-effort: any probe failure reports
   * false, never throws.
   */
  writeLockHeld(): boolean {
    if (this.dbPath === ":memory:") return false;
    let probe: DatabaseSync | undefined;
    try {
      probe = new DatabaseSync(this.dbPath);
      probe.exec("PRAGMA busy_timeout = 0;");
      try {
        probe.exec("BEGIN IMMEDIATE;");
      } catch (e) {
        // node:sqlite surfaces a contended lock as message "database is
        // locked" (code ERR_SQLITE_ERROR); match that and SQLITE_BUSY.
        return (
          e instanceof Error &&
          /database is locked|SQLITE_BUSY/i.test(e.message)
        );
      }
      try {
        probe.exec("ROLLBACK;");
      } catch {
        /* no transaction was started */
      }
      return false;
    } catch {
      return false;
    } finally {
      try {
        probe?.close();
      } catch {
        /* ignore close errors on a broken probe */
      }
    }
  }

  list(opts: { namespace?: string; limit?: number; offset?: number } & RangeOpts = {}): {
    notes: NoteRecord[];
    total: number;
  } {
    const limit = clampInt(opts.limit, 50, 1, 500);
    const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const range = rangeClause(opts);

    let rows: NoteRow[];
    let total: number;

    if (opts.namespace) {
      rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE namespace = ?${range.sql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(opts.namespace, ...range.params, limit, offset) as unknown as NoteRow[];
      total = (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM notes WHERE namespace = ?${range.sql}`)
          .get(opts.namespace, ...range.params) as { c: number }
      ).c;
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM notes WHERE 1 = 1${range.sql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...range.params, limit, offset) as unknown as NoteRow[];
      total = (
        this.db.prepare(`SELECT COUNT(*) as c FROM notes WHERE 1 = 1${range.sql}`).get(...range.params) as { c: number }
      ).c;
    }

    return { notes: rows.map(rowToRecord), total };
  }

  search(
    query: string,
    opts: { namespace?: string; limit?: number } & RangeOpts = {}
  ): NoteRecord[] {
    return this.searchRanked(query, opts).map((h) => h.note);
  }

  /**
   * Like search(), but returns each hit's FTS5 bm25 rank as a positive score
   * (higher = better match) alongside the note. The search-service uses these
   * scores as the base for ranking adjustments (e.g. the stale-note
   * penalty and access-count importance weighting); identical documents
   * score identically.
   */
  searchRanked(
    query: string,
    opts: { namespace?: string; limit?: number } & RangeOpts = {}
  ): RankedHit[] {
    if (!query || !query.trim()) return [];
    const limit = clampInt(opts.limit, 20, 1, 200);
    const matchQuery = buildMatchQuery(query);
    if (!matchQuery) return []; // query was all punctuation/stopwords
    const range = rangeClause(opts);

    try {
      let rows: Array<NoteRow & { score: number }>;
      if (opts.namespace) {
        rows = this.db
          .prepare(
            `SELECT notes.*, -rank AS score FROM notes_fts
             JOIN notes ON notes.id = notes_fts.rowid
             WHERE notes_fts MATCH ? AND notes.namespace = ?${range.sql}
             ORDER BY rank
             LIMIT ?`
          )
          .all(matchQuery, opts.namespace, ...range.params, limit) as unknown as Array<
          NoteRow & { score: number }
        >;
      } else {
        rows = this.db
          .prepare(
            `SELECT notes.*, -rank AS score FROM notes_fts
             JOIN notes ON notes.id = notes_fts.rowid
             WHERE notes_fts MATCH ?${range.sql}
             ORDER BY rank
             LIMIT ?`
          )
          .all(matchQuery, ...range.params, limit) as unknown as Array<
          NoteRow & { score: number }
        >;
      }
      // FTS5's rank is negative (lower = better), so -rank is a positive
      // higher-is-better score.
      return rows.map((row) => ({ note: rowToRecord(row), score: row.score ?? 0 }));
    } catch {
      // A malformed FTS expression should never 500 the caller.
      return [];
    }
  }

  /** Every note, oldest first — for backup / export / migration. */
  exportAll(): NoteRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM notes ORDER BY id ASC")
      .all() as unknown as NoteRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Insert notes from a backup/export. Each is validated like a normal write.
   * Returns the created records so the caller can (best-effort) embed them --
   * without this, re-imported notes would be invisible to semantic/hybrid
   * search until a manual `reindex`.
   *
   * D-HIGH-3: restoring N notes used to cost O(N^2) -- every create() ran a
   * full O(namespace) edge scan. Creates now skip per-note edge scoring and
   * one terminal rebuildEdgesCooperative() scores every pair once, with TF
   * maps precomputed once per note.
   */
  async importNotes(notes: NoteInput[]): Promise<NoteRecord[]> {
    const created: NoteRecord[] = [];
    for (const note of notes) {
      if (!note || !note.title || !note.title.trim()) continue;
      try {
        created.push(
          this.create(
            {
              namespace: note.namespace,
              title: note.title,
              body: note.body,
              tags: note.tags,
              source: note.source, // preserve provenance across export -> import
            },
            { skipEdges: true }
          )
        );
      } catch (e) {
        // Skip a note that fails validation (oversized / looks like a secret)
        // rather than aborting the whole restore and leaving earlier notes
        // committed-but-unembedded. Unexpected faults (e.g. DB errors) still
        // propagate so a real failure isn't silently swallowed.
        if (e instanceof ValidationError) continue;
        throw e;
      }
    }
    // One terminal rebuild for the whole import (see above). Whole-store:
    // the import may span namespaces, and a rebuild recomputes every edge
    // under the active threshold anyway.
    await this.rebuildEdgesCooperative();
    return created;
  }

  // --- Semantic search (optional; only used when embeddings are enabled) ---

  /** Store or replace a note's embedding. Best-effort: caller guards errors. */
  setVector(noteId: number, vec: Float32Array, model = ""): void {
    this.db
      .prepare(
        `INSERT INTO note_vectors (note_id, dim, model, vec, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET
           dim = excluded.dim, model = excluded.model,
           vec = excluded.vec, updated_at = excluded.updated_at`
      )
      .run(noteId, vec.length, model, vecToBlob(vec), new Date().toISOString());
  }

  /** How many notes have an embedding stored. */
  vectorCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM note_vectors").get() as { c: number }).c;
  }

  /** Note ids that have no embedding yet (for reindex/backfill). */
  noteIdsMissingVectors(): number[] {
    const rows = this.db
      .prepare(
        `SELECT n.id AS id FROM notes n
         LEFT JOIN note_vectors v ON v.note_id = n.id
         WHERE v.note_id IS NULL ORDER BY n.id ASC`
      )
      .all() as unknown as { id: number }[];
    return rows.map((r) => r.id);
  }

  /**
   * Rank notes by cosine similarity of their embedding to `queryVec`.
   * Pure + synchronous: no network -- the embedding is produced by the
   * caller. Brute-force over stored vectors, which is plenty for a personal
   * note store (hundreds–thousands of notes). Vectors whose dimension does
   * not match the query are skipped rather than mis-scored.
   *
   * When `startISO`/`endISO` are given, the window is pushed into the
   * vector SQL (`notes.created_at >= ? AND notes.created_at < ?`), so the
   * top-`limit` ranking is computed *within* the window -- not globally and
   * post-filtered. Post-filtering a global top-200 is what made
   * time-scoped semantic search silently return nothing: 200 out-of-window
   * notes would crowd the real in-window hits out before the filter ran.
   */
  semanticSearch(
    queryVec: Float32Array,
    opts: { namespace?: string; limit?: number } & RangeOpts = {}
  ): SemanticHit[] {
    if (!queryVec || queryVec.length === 0) return [];
    const limit = clampInt(opts.limit, 20, 1, 200);
    const range = rangeClause(opts);

    const rows = (
      opts.namespace
        ? this.db
            .prepare(
              `SELECT v.note_id, v.dim, v.model, v.vec FROM note_vectors v
               JOIN notes ON notes.id = v.note_id
               WHERE notes.namespace = ?${range.sql}`
            )
            .all(opts.namespace, ...range.params)
        : this.db
            .prepare(
              `SELECT v.note_id, v.dim, v.model, v.vec FROM note_vectors v
               JOIN notes ON notes.id = v.note_id
               WHERE 1 = 1${range.sql}`
            )
            .all(...range.params)
    ) as unknown as VectorRow[];

    const scored: { id: number; score: number }[] = [];
    for (const r of rows) {
      if (r.dim !== queryVec.length) continue;
      const score = cosineSim(queryVec, blobToVec(r.vec));
      if (score > 0) scored.push({ id: r.note_id, score });
    }
    scored.sort((a, b) => b.score - a.score);

    const hits: SemanticHit[] = [];
    for (const s of scored.slice(0, limit)) {
      const note = this.read(s.id);
      if (note) hits.push({ note, score: s.score });
    }
    return hits;
  }

  // --- Similarity edge graph (v4) ------------------------------------------

  /**
   * Score one note's text against a same-namespace snapshot: TF-IDF-weighted
   * cosine over title + body (same tokenizer as consolidation) against every
   * other note in the namespace, returning the pairs at/above `threshold`.
   *
   * I-HIGH-1: raw-TF cosine let a single common token clear the old 0.35
   * floor (llmem's threshold was tuned on an IDF-weighted BM25 scale, a
   * different metric). TF-IDF downweights boilerplate; pairs sharing fewer
   * than MIN_SHARED_TOKENS_FOR_EDGE content tokens never earn an edge at
   * all. Both the metric and the 0.25 default were chosen by the sweep in
   * reviews/tier2-threshold-sweep/.
   *
   * This is the O(namespace) CPU-bound half of edge recomputation, and it
   * performs NO writes -- call it BEFORE opening a write transaction
   * (BLOCKER 3: update()/consolidateNotes used to hold BEGIN IMMEDIATE
   * through the whole scoring loop, starving concurrent readers and
   * writers). The returned fingerprint snapshots the namespace's id set;
   * pass it to edgePlanValid() under the write lock and rescore on
   * mismatch, so a concurrent add/remove/change can't apply stale edges.
   *
   * `excludeIds` keeps about-to-vanish notes out of the snapshot (the
   * note's own id on update; the deleted sources on consolidation).
   */
  planEdges(
    namespace: string,
    title: string,
    body: string,
    threshold: number,
    excludeIds: ReadonlySet<number> = new Set()
  ): { pairs: Array<{ neighborId: number; score: number }>; fingerprint: string } {
    const pairs: Array<{ neighborId: number; score: number }> = [];
    const excl = [...excludeIds];
    const notIn = excl.length > 0 ? ` AND id NOT IN (${excl.map(() => "?").join(",")})` : "";
    const others = this.db
      .prepare(`SELECT id, title, body FROM notes WHERE namespace = ?${notIn}`)
      .all(namespace, ...excl) as Array<{ id: number; title: string; body: string }>;
    // Tokenize once per note (D-MEDIUM-2): TF maps are precomputed for the
    // target and every candidate up front, so the tokenizer never runs
    // inside the pair loop. Doc frequencies come from this namespace's own
    // snapshot -- the IDF weights always reflect the corpus being scored.
    const docs = [{ id: -1, title, body }, ...others];
    const tfMaps = precomputeTfMaps(docs);
    const mine = tfMaps.get(-1)!;
    // Notes with no content tokens carry no similarity signal
    // (cosineTfIdf scores them 0, never 1): skip the scan.
    if (mine.size > 0) {
      const df = computeDocFreqs(tfMaps.values());
      const docCount = docs.length;
      for (const o of others) {
        const fo = tfMaps.get(o.id)!;
        if (fo.size === 0) continue;
        if (sharedTokenCount(mine, fo) < MIN_SHARED_TOKENS_FOR_EDGE) continue;
        const score = cosineTfIdf(mine, fo, df, docCount);
        // 1e-9 epsilon mirrors consolidate.ts: a true-at-threshold score must
        // not be dropped by floating-point rounding.
        if (score + 1e-9 >= threshold) {
          pairs.push({ neighborId: o.id, score });
        }
      }
    }
    return { pairs, fingerprint: this.namespaceFingerprint(namespace, excludeIds) };
  }

  /**
   * True when no same-namespace note outside `excludeIds` was added,
   * removed, or had its rev bumped since planEdges() ran -- i.e. the
   * plan's snapshot is still current. Call under the write lock, right
   * before applyEdgePairs(), and rescore via planEdges() on false (the
   * rescore is stable because the lock is held).
   */
  edgePlanValid(
    namespace: string,
    excludeIds: ReadonlySet<number>,
    fingerprint: string
  ): boolean {
    return this.namespaceFingerprint(namespace, excludeIds) === fingerprint;
  }

  /** Cheap change-detector for a namespace's note set: count + max id +
   * sum of revs. A concurrent create/delete/text-update anywhere in the
   * namespace moves at least one component (revs only ever increment). */
  private namespaceFingerprint(namespace: string, excludeIds: ReadonlySet<number>): string {
    const excl = [...excludeIds];
    const notIn = excl.length > 0 ? ` AND id NOT IN (${excl.map(() => "?").join(",")})` : "";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m, COALESCE(SUM(rev), 0) AS r
         FROM notes WHERE namespace = ?${notIn}`
      )
      .get(namespace, ...excl) as { c: number; m: number; r: number };
    return `${row.c}:${row.m}:${row.r}`;
  }

  /**
   * Apply pre-scored edge pairs for one note: delete its existing edges in
   * both directions, then store a bidirectional edge per pair. The caller
   * MUST hold a write transaction -- this is the short write half that
   * pairs with planEdges()'s lock-free scoring half.
   */
  applyEdgePairs(id: number, pairs: Array<{ neighborId: number; score: number }>): void {
    // A namespace change strands edges against the old namespace's notes,
    // so wipe both directions unconditionally before recomputing.
    this.db
      .prepare("DELETE FROM note_edges WHERE note_id = ? OR neighbor_id = ?")
      .run(id, id);
    const insert = this.db.prepare(
      "INSERT INTO note_edges (note_id, neighbor_id, score) VALUES (?, ?, ?)"
    );
    for (const p of pairs) {
      insert.run(id, p.neighborId, p.score);
      insert.run(p.neighborId, id, p.score);
    }
  }

  /**
   * Rebuild one note's edges: delete its existing edges in both directions,
   * then score it (cosine over title + body, same tokenizer as
   * consolidation) against every other note in the SAME namespace and
   * store a bidirectional edge for each pair at/above `threshold`.
   *
   * Same-namespace-only is a hard rule, not an optimization: namespaces
   * are an isolation boundary, and an edge is a navigable link between
   * notes. Called on every create/update; O(n) per note, which is the
   * documented cost of the write path.
   */
  private recomputeEdgesFor(
    id: number,
    namespace: string,
    title: string,
    body: string,
    threshold: number
  ): void {
    const { pairs } = this.planEdges(namespace, title, body, threshold, new Set([id]));
    this.applyEdgePairs(id, pairs);
  }

  /**
   * This note's similar neighbors, top `limit` by score. Same-namespace
   * only: edges are never created across namespaces, and the join
   * re-checks the neighbor's namespace as defense-in-depth (so a note
   * moved between namespaces by a concurrent writer can't leak through a
   * stale edge).
   */
  listNeighbors(id: number, limit = EDGE_NEIGHBOR_LIMIT): NeighborEntry[] {
    const rows = this.db
      .prepare(
        `SELECT e.neighbor_id AS id, n.title AS title, e.score AS score
         FROM note_edges e
         JOIN notes n ON n.id = e.neighbor_id
         WHERE e.note_id = ?
           AND n.namespace = (SELECT namespace FROM notes WHERE id = ?)
         ORDER BY e.score DESC, e.neighbor_id ASC
         LIMIT ?`
      )
      .all(id, id, clampInt(limit, EDGE_NEIGHBOR_LIMIT, 1, 100)) as Array<{
      id: number;
      title: string;
      score: number;
    }>;
    return rows.map((r) => ({ id: r.id, title: r.title, score: r.score }));
  }

  /**
   * The active edge-similarity threshold (D-MEDIUM-4). Persisted in the
   * _meta table (created by migration v5); every write path -- create(),
   * update(), consolidateNotes(), rebuildEdgesCooperative() -- reads it,
   * so a custom rebuild threshold can't be silently reverted by the next
   * write into a mixed-threshold graph. Falls back to
   * EDGE_SIMILARITY_THRESHOLD when unset (fresh database) or corrupt
   * (hand-edited _meta) rather than failing the write.
   */
  getEdgeThreshold(): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM _meta WHERE key = 'edge_threshold'")
        .get() as { value: string } | undefined;
      if (row) {
        const n = Number(row.value);
        if (Number.isFinite(n) && n > 0 && n <= 1) return n;
      }
    } catch {
      /* _meta unreadable: fall back to the default, never fail the write */
    }
    return EDGE_SIMILARITY_THRESHOLD;
  }

  /**
   * Persist the active edge-similarity threshold for all write paths.
   * Validated like any caller-supplied threshold: resolveEdgeThreshold
   * throws on garbage rather than silently clamping, because a rewritten
   * threshold changes which edges exist. rebuildEdgesCooperative() calls
   * this when invoked with an explicit threshold, so the store's write
   * paths follow the rebuild instead of drifting back to the default.
   */
  setEdgeThreshold(v: number): void {
    const t = resolveEdgeThreshold(v);
    this.db
      .prepare(
        "INSERT INTO _meta (key, value) VALUES ('edge_threshold', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(String(t));
  }

  /**
   * Per-namespace rebuild workload estimate: note and pair counts for the
   * similarity-edge rebuild. The MCP confirm gate and the CLI confirmation
   * prompt both read this before running, so the caller sees the O(n^2)
   * cost up front instead of discovering it mid-run.
   */
  rebuildPlan(opts: { namespace?: string } = {}): RebuildPlanEntry[] {
    const ns = opts.namespace?.trim() || undefined;
    const rows = (
      ns
        ? this.db
            .prepare(
              "SELECT namespace, COUNT(*) AS n FROM notes WHERE namespace = ? GROUP BY namespace"
            )
            .all(ns)
        : this.db
            .prepare("SELECT namespace, COUNT(*) AS n FROM notes GROUP BY namespace")
            .all()
    ) as Array<{ namespace: string; n: number }>;
    return rows
      .map((r) => {
        const notes = Number(r.n);
        return {
          namespace: r.namespace,
          notes,
          pairs: (notes * (notes - 1)) / 2,
        };
      })
      .sort((a, b) =>
        a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0
      );
  }

  /**
   * Recalculate every similarity edge from scratch: delete all edges in
   * scope, then re-score every pair within each namespace. Pass `namespace`
   * to rebuild one namespace only. Reports directed edge rows created vs
   * removed (a no-op rebuild reports equal counts).
   *
   * BLOCKER 1 redesign of the old synchronous rebuildEdges() (which scored
   * every pair with per-pair re-tokenization inside one giant BEGIN
   * IMMEDIATE/COMMIT, freezing the server and failing CLI second-process
   * writes with SQLITE_BUSY):
   * - Term-frequency maps are precomputed ONCE per note before the pair
   *   loop (the old code re-tokenized both texts of every pair --
   *   O(pairs x avg_tokens) tokenizer work; also fixes D-MEDIUM-2).
   *   Scoring is TF-IDF-weighted cosine over those maps with per-namespace
   *   doc frequencies, plus a minimum-support floor of
   *   MIN_SHARED_TOKENS_FOR_EDGE shared content tokens (I-HIGH-1: raw-TF
   *   cosine let a single common token clear the old 0.35 floor; both the
   *   metric and the 0.25 default were chosen by the sweep in
   *   reviews/tier2-threshold-sweep/).
   * - Cooperative: yields to the event loop every REBUILD_YIELD_EVERY pair
   *   checks via setImmediate, so a large rebuild never freezes concurrent
   *   API/MCP traffic. Scoring holds NO lock; the write lock is held only
   *   for each chunk's short insert transaction.
   * - Chunked commits: each REBUILD_BAND_NOTES slice of a namespace group
   *   commits its edge inserts in its own transaction. Chunk boundaries
   *   are the resume points -- progress is recorded in the _meta table per
   *   chunk, so an interrupted run (SIGINT, crash) resumes where it left
   *   off instead of restarting from scratch or rolling back a
   *   mega-transaction to zero.
   * - Mid-rebuild mutations (Y-HIGH-3): each chunk re-reads the live id
   *   set under its write lock and skips vanished notes, and inserts are
   *   INSERT OR IGNORE, so a note deleted mid-rebuild can neither abort
   *   the run via an FK violation nor leave dangling edges. Notes created
   *   mid-rebuild get their edges from the normal create() path (they are
   *   not in this run's snapshot, so there is no conflict).
   *
   * O(n^2) cosine comparisons -- run as maintenance (CLI / MCP tool), not
   * on the write path.
   */
  async rebuildEdgesCooperative(
    opts: RebuildEdgesOptions = {}
  ): Promise<RebuildEdgesResult> {
    // D-MEDIUM-4: an explicit threshold becomes the store's active threshold
    // (persisted in _meta via setEdgeThreshold), so later create()/update()
    // calls don't silently revert this rebuild's edges to the default --
    // no mixed-threshold graphs. Omit threshold to reuse the stored one.
    const threshold =
      opts.threshold === undefined ? this.getEdgeThreshold() : resolveEdgeThreshold(opts.threshold);
    if (opts.threshold !== undefined) this.setEdgeThreshold(threshold);
    const ns = opts.namespace?.trim() || undefined;
    const onProgress = opts.onProgress;
    const scopeKey = ns ?? "*";

    // Snapshot the notes in scope and precompute each note's term-frequency
    // map ONCE. Everything below scores pairs against these maps -- the
    // tokenizer never runs inside the pair loop.
    interface EdgeDoc {
      id: number;
      namespace: string;
      freq: Map<string, number>;
    }
    const rows = (
      ns
        ? this.db
            .prepare(
              "SELECT id, namespace, title, body FROM notes WHERE namespace = ? ORDER BY id ASC"
            )
            .all(ns)
        : this.db
            .prepare("SELECT id, namespace, title, body FROM notes ORDER BY id ASC")
            .all()
    ) as Array<{ id: number; namespace: string; title: string; body: string }>;
    // Tokenize once per note via the shared helper (D-MEDIUM-2): one pass
    // over the snapshot, then every pair scores against the maps.
    const snapshotTf = precomputeTfMaps(rows);
    const byNs = new Map<string, EdgeDoc[]>();
    for (const r of rows) {
      const doc: EdgeDoc = {
        id: Number(r.id),
        namespace: r.namespace,
        freq: snapshotTf.get(Number(r.id))!,
      };
      const g = byNs.get(doc.namespace);
      if (g) g.push(doc);
      else byNs.set(doc.namespace, [doc]);
    }
    // Sort groups for a deterministic band/marker order across runs (resume
    // must revisit groups in the same order).
    const groups = [...byNs.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    );
    const pairsIn = (g: EdgeDoc[]): number => (g.length * (g.length - 1)) / 2;
    const totalPairs = groups.reduce((s, [, g]) => s + pairsIn(g), 0);
    // A group's identity for resume validation: note count + first/last id
    // of the id-ordered snapshot. Any create/delete in the group changes it.
    const groupSig = (g: EdgeDoc[]): string =>
      `${g.length}:${g.length > 0 ? g[0].id : 0}:${g.length > 0 ? g[g.length - 1].id : 0}`;

    // Resume: an interrupted run left a progress marker in _meta. It is only
    // honored when threshold + scope match AND the group's snapshot is
    // unchanged; otherwise it is dropped and the rebuild starts fresh.
    interface RebuildMarker {
      threshold: number;
      scope: string;
      ns: string;
      band: number;
      sig: string;
    }
    const clearMarker = (): void => {
      this.db.prepare("DELETE FROM _meta WHERE key = ?").run(REBUILD_PROGRESS_KEY);
    };
    let resume: { groupIdx: number; band: number } | null = null;
    try {
      const mrow = this.db
        .prepare("SELECT value FROM _meta WHERE key = ?")
        .get(REBUILD_PROGRESS_KEY) as { value: string } | undefined;
      if (mrow) {
        const m = JSON.parse(mrow.value) as Partial<RebuildMarker>;
        const gi = groups.findIndex(([name]) => name === m.ns);
        if (
          m.threshold === threshold &&
          m.scope === scopeKey &&
          typeof m.band === "number" &&
          typeof m.sig === "string" &&
          gi >= 0 &&
          groupSig(groups[gi][1]) === m.sig
        ) {
          resume = { groupIdx: gi, band: m.band as number };
        } else {
          clearMarker(); // stale marker: different params or mutated corpus
        }
      }
    } catch {
      resume = null; // _meta unreadable: treat as no marker, rebuild fresh
    }

    const insertEdge = this.db.prepare(
      "INSERT OR IGNORE INTO note_edges (note_id, neighbor_id, score) VALUES (?, ?, ?)"
    );
    const writeMarker = this.db.prepare(
      "INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    const liveIdsStmt = this.db.prepare("SELECT id FROM notes WHERE namespace = ?");
    const deleteGroupEdges = this.db.prepare(
      `DELETE FROM note_edges
       WHERE note_id IN (SELECT id FROM notes WHERE namespace = ?)
          OR neighbor_id IN (SELECT id FROM notes WHERE namespace = ?)`
    );
    // Every edge's endpoints share one namespace (same-namespace-only is a
    // write-time invariant), so deleting per group covers the whole scope
    // even for a whole-store rebuild.

    let created = 0;
    let removed = 0;
    let pairsDone = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const [nsName, group] = groups[gi];
      if (resume && gi < resume.groupIdx) {
        pairsDone += pairsIn(group); // already rebuilt by the interrupted run
        continue;
      }
      const startBand = resume && gi === resume.groupIdx ? resume.band + 1 : 0;
      if (startBand === 0) {
        // Fresh group: wipe its edges in one short transaction before the
        // first band. (On resume the wipe already happened -- never repeat
        // it, or completed bands' edges would be lost.)
        removed += Number(deleteGroupEdges.run(nsName, nsName).changes);
      }
      const sig = groupSig(group);
      // I-HIGH-1: doc frequencies for this namespace group's own snapshot,
      // so the IDF weights reflect the corpus actually being scored.
      const groupDf = computeDocFreqs(group.map((d) => d.freq));
      const groupDocCount = group.length;
      for (
        let b = startBand * REBUILD_BAND_NOTES;
        b < group.length;
        b += REBUILD_BAND_NOTES
      ) {
        const bandIdx = Math.floor(b / REBUILD_BAND_NOTES);
        const end = Math.min(b + REBUILD_BAND_NOTES, group.length);
        // Score this band's pairs with NO lock held, yielding
        // cooperatively so concurrent traffic keeps flowing.
        const edges: Array<{ a: number; b: number; score: number }> = [];
        for (let i = b; i < end; i++) {
          const fi = group[i].freq;
          const aId = group[i].id;
          for (let j = i + 1; j < group.length; j++) {
            pairsDone++;
            if (fi.size !== 0) {
              const fj = group[j].freq;
              // Minimum-support floor (I-HIGH-1): fewer than
              // MIN_SHARED_TOKENS_FOR_EDGE shared content tokens never
              // earns an edge, whatever the cosine says.
              if (
                fj.size !== 0 &&
                sharedTokenCount(fi, fj) >= MIN_SHARED_TOKENS_FOR_EDGE
              ) {
                const score = cosineTfIdf(fi, fj, groupDf, groupDocCount);
                // 1e-9 epsilon mirrors the old rebuild: a true-at-threshold
                // score must not be dropped by floating-point rounding.
                if (score + 1e-9 >= threshold) {
                  edges.push({ a: aId, b: group[j].id, score });
                }
              }
            }
            if (pairsDone % REBUILD_YIELD_EVERY === 0) {
              onProgress?.(pairsDone, totalPairs);
              await new Promise<void>((r) => setImmediate(r));
            }
          }
        }
        onProgress?.(pairsDone, totalPairs);
        // Commit the chunk: one short write transaction. Re-read the live
        // id set under the lock (Y-HIGH-3) and skip vanished notes;
        // INSERT OR IGNORE keeps resume-redo and any residual race from
        // aborting the transaction on PK/FK conflicts.
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const live = new Set(
            (liveIdsStmt.all(nsName) as Array<{ id: number }>).map((r) =>
              Number(r.id)
            )
          );
          for (const e of edges) {
            if (!live.has(e.a) || !live.has(e.b)) continue;
            created += Number(insertEdge.run(e.a, e.b, e.score).changes);
            created += Number(insertEdge.run(e.b, e.a, e.score).changes);
          }
          writeMarker.run(
            REBUILD_PROGRESS_KEY,
            JSON.stringify({ threshold, scope: scopeKey, ns: nsName, band: bandIdx, sig })
          );
          this.db.exec("COMMIT");
        } catch (err) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* already rolled back -- rethrow the original */
          }
          throw err;
        }
      }
    }
    clearMarker();
    onProgress?.(pairsDone, totalPairs);
    return { created, removed };
  }

  close(): void {
    this.db.close();
  }
}
