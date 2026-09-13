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

export interface NoteInput {
  namespace?: string;
  title: string;
  body?: string;
  tags?: string[];
}

export interface NotePatch {
  namespace?: string;
  title?: string;
  body?: string;
  tags?: string[];
}

export interface NoteRecord {
  id: number;
  namespace: string;
  title: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface NoteRow {
  id: number;
  namespace: string;
  title: string;
  body: string;
  tags: string;
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
    tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function tagsToStorage(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  return tags.map((t) => t.trim()).filter(Boolean).join(",");
}

/** Build an FTS5 MATCH expression: AND of prefix-matched, quote-escaped tokens. */
function buildMatchQuery(q: string): string {
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  if (tokens.length === 0) return '""';
  return tokens.join(" AND ");
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
  }

  create(input: NoteInput): NoteRecord {
    if (!input.title || !input.title.trim()) {
      throw new Error("title is required");
    }
    const now = new Date().toISOString();
    const namespace = input.namespace?.trim() || DEFAULT_NAMESPACE;
    const body = input.body ?? "";
    const tags = tagsToStorage(input.tags);

    const stmt = this.db.prepare(`
      INSERT INTO notes (namespace, title, body, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(namespace, input.title, body, tags, now, now);
    const id = Number(result.lastInsertRowid);
    return this.read(id)!;
  }

  read(id: number): NoteRecord | null {
    const row = this.db
      .prepare("SELECT * FROM notes WHERE id = ?")
      .get(id) as NoteRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  update(id: number, patch: NotePatch): NoteRecord | null {
    const existing = this.read(id);
    if (!existing) return null;

    if (patch.title !== undefined && !patch.title.trim()) {
      throw new Error("title cannot be empty");
    }

    const namespace = patch.namespace?.trim() ?? existing.namespace;
    const title = patch.title ?? existing.title;
    const body = patch.body ?? existing.body;
    const tags = patch.tags !== undefined ? tagsToStorage(patch.tags) : tagsToStorage(existing.tags);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE notes SET namespace = ?, title = ?, body = ?, tags = ?, updated_at = ? WHERE id = ?`
      )
      .run(namespace, title, body, tags, now, id);

    return this.read(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  list(opts: { namespace?: string; limit?: number; offset?: number } = {}): {
    notes: NoteRecord[];
    total: number;
  } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);

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
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const matchQuery = buildMatchQuery(query);

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
  }

  close(): void {
    this.db.close();
  }
}
