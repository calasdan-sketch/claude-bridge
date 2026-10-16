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
import { cosineSimilarity, tokenize } from "./consolidate.js";
// No module cycle: staleness.ts imports config.ts at runtime and store.ts
// only as a type (erased at compile), so store -> staleness -> config is
// acyclic.
import { isStale, stalenessConfig } from "./staleness.js";

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

/** Default cosine-similarity floor for creating a similarity edge. */
export const EDGE_SIMILARITY_THRESHOLD = 0.35;

/** Max neighbors attached to a single note read (state_read neighbors:true). */
export const EDGE_NEIGHBOR_LIMIT = 10;

/** One directed similarity edge endpoint: a similar note + the pair's score. */
export interface NeighborEntry {
  id: number;
  title: string;
  score: number;
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

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
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
  }

  create(input: NoteInput): NoteRecord {
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
    // inside consolidateNotes' store.transaction().
    this.recomputeEdgesFor(id, namespace, input.title, body, EDGE_SIMILARITY_THRESHOLD);
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
    return { ...record, neighbors: this.listNeighbors(id, EDGE_NEIGHBOR_LIMIT) };
  }

  /**
   * Record one user-facing read of a note: access_count + 1, last_accessed =
   * now (ISO). Fire-and-forget: a missing id is a silent no-op, never an
   * error. updated_at is deliberately left alone -- a read is not a change,
   * so "newest first" listings don't get churned by popularity.
   */
  touch(id: number): void {
    this.db
      .prepare(
        "UPDATE notes SET access_count = access_count + 1, last_accessed = ? WHERE id = ?"
      )
      .run(new Date().toISOString(), id);
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
      // Same transaction, so text and graph never diverge.
      this.recomputeEdgesFor(id, namespace, title, body, EDGE_SIMILARITY_THRESHOLD);
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
   * scores as the base for importance weighting; identical documents score
   * identically, so among equal-relevance hits the note read most often wins.
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
   */
  importNotes(notes: NoteInput[]): NoteRecord[] {
    const created: NoteRecord[] = [];
    for (const note of notes) {
      if (!note || !note.title || !note.title.trim()) continue;
      try {
        created.push(
          this.create({
            namespace: note.namespace,
            title: note.title,
            body: note.body,
            tags: note.tags,
            source: note.source, // preserve provenance across export -> import
          })
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
    // A namespace change strands edges against the old namespace's notes,
    // so wipe both directions unconditionally before recomputing.
    this.db
      .prepare("DELETE FROM note_edges WHERE note_id = ? OR neighbor_id = ?")
      .run(id, id);
    const text = `${title} ${body}`;
    // Notes with no content tokens carry no similarity signal
    // (cosineSimilarity scores them 0, never 1): skip the scan.
    if (tokenize(text).length === 0) return;
    const others = this.db
      .prepare("SELECT id, title, body FROM notes WHERE namespace = ? AND id != ?")
      .all(namespace, id) as Array<{ id: number; title: string; body: string }>;
    const insert = this.db.prepare(
      "INSERT INTO note_edges (note_id, neighbor_id, score) VALUES (?, ?, ?)"
    );
    for (const o of others) {
      const score = cosineSimilarity(text, `${o.title} ${o.body}`);
      // 1e-9 epsilon mirrors consolidate.ts: a true-at-threshold score must
      // not be dropped by floating-point rounding.
      if (score + 1e-9 >= threshold) {
        insert.run(id, o.id, score);
        insert.run(o.id, id, score);
      }
    }
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
   * Recalculate every similarity edge from scratch: delete all edges in
   * scope, then re-score every pair within each namespace. Pass `namespace`
   * to rebuild one namespace only. Reports directed edge rows created vs
   * removed (a no-op rebuild reports equal counts).
   *
   * O(n^2) cosine comparisons -- fine at personal-store scale, but run it
   * as maintenance (CLI / MCP tool), not on the write path.
   */
  rebuildEdges(opts: { threshold?: number; namespace?: string } = {}): RebuildEdgesResult {
    const threshold = resolveEdgeThreshold(opts.threshold);
    const ns = opts.namespace?.trim() || undefined;
    return this.transaction(() => {
      interface EdgeNote {
        id: number;
        namespace: string;
        title: string;
        body: string;
      }
      const notes = (
        ns
          ? this.db
              .prepare(
                "SELECT id, namespace, title, body FROM notes WHERE namespace = ? ORDER BY id ASC"
              )
              .all(ns)
          : this.db
              .prepare("SELECT id, namespace, title, body FROM notes ORDER BY id ASC")
              .all()
      ) as unknown as EdgeNote[];

      // removed: every directed edge row touching the rebuilt scope.
      const del = ns
        ? this.db
            .prepare(
              `DELETE FROM note_edges
               WHERE note_id IN (SELECT id FROM notes WHERE namespace = ?)
                  OR neighbor_id IN (SELECT id FROM notes WHERE namespace = ?)`
            )
            .run(ns, ns)
        : this.db.prepare("DELETE FROM note_edges").run();
      const removed = Number(del.changes);

      // Score pairs within each namespace group -- never across namespaces,
      // even in a whole-store rebuild.
      const byNs = new Map<string, EdgeNote[]>();
      for (const n of notes) {
        const g = byNs.get(n.namespace);
        if (g) g.push(n);
        else byNs.set(n.namespace, [n]);
      }
      const insert = this.db.prepare(
        "INSERT INTO note_edges (note_id, neighbor_id, score) VALUES (?, ?, ?)"
      );
      let created = 0;
      for (const group of byNs.values()) {
        const texts = group.map((n) => `${n.title} ${n.body}`);
        for (let i = 0; i < group.length; i++) {
          if (tokenize(texts[i]).length === 0) continue;
          for (let j = i + 1; j < group.length; j++) {
            const score = cosineSimilarity(texts[i], texts[j]);
            if (score + 1e-9 >= threshold) {
              insert.run(group[i].id, group[j].id, score);
              insert.run(group[j].id, group[i].id, score);
              created += 2;
            }
          }
        }
      }
      return { created, removed };
    });
  }

  close(): void {
    this.db.close();
  }
}
