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

interface VectorRow {
  note_id: number;
  dim: number;
  model: string;
  vec: Uint8Array;
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
  }

  create(input: NoteInput): NoteRecord {
    if (!input.title || !input.title.trim()) {
      throw new ValidationError("title is required");
    }
    validateContent(input);
    const now = new Date().toISOString();
    const namespace = input.namespace?.trim() || DEFAULT_NAMESPACE;
    const body = input.body ?? "";
    const tags = tagsToStorage(input.tags);
    const source = (input.source ?? "").slice(0, 200);

    const stmt = this.db.prepare(`
      INSERT INTO notes (namespace, title, body, tags, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(namespace, input.title, body, tags, source, now, now);
    const id = Number(result.lastInsertRowid);
    audit({ op: "create", id, namespace, bytes: body.length });
    return this.read(id)!;
  }

  read(id: number): NoteRecord | null {
    const row = this.db
      .prepare("SELECT * FROM notes WHERE id = ?")
      .get(id) as NoteRow | undefined;
    return row ? rowToRecord(row) : null;
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

  list(opts: { namespace?: string; limit?: number; offset?: number } = {}): {
    notes: NoteRecord[];
    total: number;
  } {
    const limit = clampInt(opts.limit, 50, 1, 500);
    const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    let rows: NoteRow[];
    let total: number;

    if (opts.namespace) {
      rows = this.db
        .prepare(
          "SELECT * FROM notes WHERE namespace = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?"
        )
        .all(opts.namespace, limit, offset) as unknown as NoteRow[];
      total = (
        this.db
          .prepare("SELECT COUNT(*) as c FROM notes WHERE namespace = ?")
          .get(opts.namespace) as { c: number }
      ).c;
    } else {
      rows = this.db
        .prepare("SELECT * FROM notes ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?")
        .all(limit, offset) as unknown as NoteRow[];
      total = (this.db.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number }).c;
    }

    return { notes: rows.map(rowToRecord), total };
  }

  search(
    query: string,
    opts: { namespace?: string; limit?: number } = {}
  ): NoteRecord[] {
    if (!query || !query.trim()) return [];
    const limit = clampInt(opts.limit, 20, 1, 200);
    const matchQuery = buildMatchQuery(query);
    if (!matchQuery) return []; // query was all punctuation/stopwords

    try {
      let rows: NoteRow[];
      if (opts.namespace) {
        rows = this.db
          .prepare(
            `SELECT notes.* FROM notes_fts
             JOIN notes ON notes.id = notes_fts.rowid
             WHERE notes_fts MATCH ? AND notes.namespace = ?
             ORDER BY rank
             LIMIT ?`
          )
          .all(matchQuery, opts.namespace, limit) as unknown as NoteRow[];
      } else {
        rows = this.db
          .prepare(
            `SELECT notes.* FROM notes_fts
             JOIN notes ON notes.id = notes_fts.rowid
             WHERE notes_fts MATCH ?
             ORDER BY rank
             LIMIT ?`
          )
          .all(matchQuery, limit) as unknown as NoteRow[];
      }
      return rows.map(rowToRecord);
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
   */
  semanticSearch(
    queryVec: Float32Array,
    opts: { namespace?: string; limit?: number } = {}
  ): SemanticHit[] {
    if (!queryVec || queryVec.length === 0) return [];
    const limit = clampInt(opts.limit, 20, 1, 200);

    const rows = (
      opts.namespace
        ? this.db
            .prepare(
              `SELECT v.note_id, v.dim, v.model, v.vec FROM note_vectors v
               JOIN notes n ON n.id = v.note_id
               WHERE n.namespace = ?`
            )
            .all(opts.namespace)
        : this.db.prepare("SELECT note_id, dim, model, vec FROM note_vectors").all()
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

  close(): void {
    this.db.close();
  }
}
