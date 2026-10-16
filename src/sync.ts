// Plain-file sync: export the store as one Markdown file per note, and merge
// a directory of such files back in. Built for git / Syncthing / Dropbox:
//
//   <dir>/<namespace>/<slug>--<origin8>-<id>.md
//
//   ---
//   id: 12
//   origin: "5f0c...-uuid"          # store that first wrote the note
//   namespace: "work"
//   title: "Release cadence"
//   tags: ["decision"]
//   source: "claude-code"
//   created_at: "2026-10-14T09:00:00.000Z"
//   updated_at: "2026-10-15T10:30:00.000Z"
//   rev: 3
//   hash: "9b1f0c2a7d3e4f51"         # content hash at export = the merge base
//   ---
//   Ship weekly on Thursdays.
//
// Export is deterministic: fixed key order, JSON-encoded scalars (valid
// YAML), LF endings, one trailing newline, files written only when their
// bytes change, notes in id order. Filenames do not depend on which machine
// exported, so two machines exporting into one git repo converge.
//
// Identity across machines: every store has a uuid (_meta store_uuid). A
// note's identity is (origin, id) where origin is the store that first
// wrote it. Importing another store's file creates a local note and records
// the mapping (sync_map), so the next import updates that note instead of
// duplicating it, and this store's own export keeps the original identity.
//
// Merge (import) is three-way. The base is the content hash this store last
// exported or merged for the note (sync_base), falling back to the `hash`
// in the file's front-matter for a note this store has never synced:
//   file unchanged since export, store unchanged -> nothing to do
//   file edited, store unchanged                 -> file wins (update)
//   file unchanged, store edited                 -> store wins (skip)
//   both edited, same content                    -> nothing to do
//   both edited, different content (conflict)    -> the newer side wins
//     (file: max(front-matter updated_at, file mtime); store: updated_at)
//     and the losing version is written to <dir>/.conflicts/ -- never lost.
// Every import write goes through the store's write path, so the memory
// linter runs on it (blocked / quarantined files are reported). Import
// never deletes notes; a file for a note deleted in this store is skipped
// unless it was edited, in which case the note is restored.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  Store,
  ValidationError,
  QuarantinedError,
  type NoteRecord,
} from "./store.js";
import { maybeEmbed } from "./search-service.js";

/** Front-matter keys, in the order export writes them. */
const KEYS = [
  "id",
  "origin",
  "namespace",
  "title",
  "tags",
  "source",
  "created_at",
  "updated_at",
  "rev",
  "hash",
] as const;

export interface NoteContent {
  namespace: string;
  title: string;
  body: string;
  tags: string[];
}

/** Same normalization the store applies to tags (trim, dedupe, drop empty). */
function normTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map((t) => String(t).trim()).filter(Boolean)));
}

/** Content hash used as the three-way merge base (16 hex chars). */
export function contentHash(c: NoteContent): string {
  return createHash("sha256")
    .update(JSON.stringify([c.namespace, c.title, c.body, normTags(c.tags)]))
    .digest("hex")
    .slice(0, 16);
}

function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "note";
}

/** A filesystem-safe folder for a namespace (cosmetic: front-matter wins). */
export function namespaceFolder(ns: string): string {
  const f = ns.replace(/[^A-Za-z0-9._-]/g, "_");
  return f === "" || f === "." || f === ".." ? "_" : f;
}

export function noteFileName(title: string, origin: string, id: number): string {
  return `${slugify(title)}--${origin.replace(/-/g, "").slice(0, 8)}-${id}.md`;
}

/** Render one note as Markdown with YAML front-matter. */
export function renderNoteFile(
  note: NoteRecord,
  identity: { origin: string; id: number }
): string {
  const fm: Record<(typeof KEYS)[number], unknown> = {
    id: identity.id,
    origin: identity.origin,
    namespace: note.namespace,
    title: note.title,
    tags: note.tags,
    source: note.source,
    created_at: note.created_at,
    updated_at: note.updated_at,
    rev: note.rev,
    hash: contentHash(note),
  };
  const lines = KEYS.map((k) => `${k}: ${JSON.stringify(fm[k])}`);
  return `---\n${lines.join("\n")}\n---\n${note.body}\n`;
}

/** Parse one YAML-ish scalar / flow sequence written by us or by a human. */
function parseValue(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (/^["[{]|^-?\d|^(true|false|null)$/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      /* hand-written YAML: fall through */
    }
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

export interface ParsedFile {
  fm: Record<string, unknown>;
  body: string;
  hasFrontMatter: boolean;
}

/** Parse a note file: front-matter (if any) + body. CRLF is normalized. */
export function parseNoteFile(text: string): ParsedFile {
  const t = text.replace(/\r\n/g, "\n");
  const stripOne = (b: string): string => (b.endsWith("\n") ? b.slice(0, -1) : b);
  if (!t.startsWith("---\n")) return { fm: {}, body: stripOne(t), hasFrontMatter: false };
  const end = t.indexOf("\n---\n", 3);
  const endAtEof = end < 0 && t.endsWith("\n---") ? t.length - 4 : -1;
  const close = end >= 0 ? end : endAtEof;
  if (close < 0) return { fm: {}, body: stripOne(t), hasFrontMatter: false };
  const fm: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of t.slice(4, close).split("\n")) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (fm[listKey] as unknown[]).push(parseValue(item[1]));
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    if (m[2].trim() === "") {
      fm[m[1]] = [];
      listKey = m[1];
    } else {
      fm[m[1]] = parseValue(m[2]);
      listKey = null;
    }
  }
  const body = end >= 0 ? t.slice(end + 5) : "";
  return { fm, body: stripOne(body), hasFrontMatter: true };
}

/** All .md files one or two levels deep, skipping dot-directories. */
function listNoteFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(p);
    }
  };
  walk(dir, 1);
  return out.sort();
}

function isOurFile(p: ParsedFile): boolean {
  return p.hasFrontMatter && typeof p.fm.origin === "string" && typeof p.fm.id === "number";
}

export interface ExportResult {
  dir: string;
  notes: number;
  written: number;
  unchanged: number;
  removed: number;
}

/**
 * Write one Markdown file per note under `dir`. With `prune` (default) a
 * OneMemory-format file whose note is gone, or that was renamed by a title
 * change, is removed; other files are never touched.
 */
export function exportMarkdown(
  store: Store,
  dir: string,
  opts: { namespace?: string; prune?: boolean } = {}
): ExportResult {
  const self = store.storeId();
  const origins = store.syncOrigins();
  mkdirSync(dir, { recursive: true });
  const notes = store.exportAll().filter((n) => !opts.namespace || n.namespace === opts.namespace);
  const keep = new Set<string>();
  let written = 0;
  let unchanged = 0;
  for (const note of notes) {
    const o = origins.get(note.id);
    const identity = o ? { origin: o.origin, id: o.originId } : { origin: self, id: note.id };
    const path = join(dir, namespaceFolder(note.namespace), noteFileName(note.title, identity.origin, identity.id));
    keep.add(path);
    const text = renderNoteFile(note, identity);
    store.setSyncBase(note.id, contentHash(note));
    let current: string | null = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      /* new file */
    }
    if (current === text) {
      unchanged++;
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    written++;
  }
  let removed = 0;
  if (opts.prune !== false) {
    for (const p of listNoteFiles(dir)) {
      if (keep.has(p)) continue;
      let parsed: ParsedFile;
      try {
        parsed = parseNoteFile(readFileSync(p, "utf8"));
      } catch {
        continue;
      }
      if (!isOurFile(parsed)) continue; // never delete a file we didn't write
      if (opts.namespace && parsed.fm.namespace !== opts.namespace) continue;
      rmSync(p);
      removed++;
    }
  }
  return { dir, notes: notes.length, written, unchanged, removed };
}

export type ImportAction =
  | "created"
  | "updated"
  | "restored"
  | "unchanged"
  | "skipped"
  | "conflict"
  | "quarantined"
  | "rejected";

export interface ImportEntry {
  file: string;
  action: ImportAction;
  id?: number;
  detail?: string;
}

export interface ImportResult {
  dir: string;
  entries: ImportEntry[];
  counts: Record<ImportAction, number>;
}

/**
 * Merge a directory of note files into the store (see the header for the
 * rules). `dryRun` reports what would happen without writing anything.
 */
export async function importMarkdown(
  store: Store,
  dir: string,
  opts: { dryRun?: boolean } = {}
): Promise<ImportResult> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ValidationError(`not a directory: ${dir}`);
  }
  const self = store.storeId();
  const dry = opts.dryRun === true;
  const entries: ImportEntry[] = [];
  const conflictsDir = join(dir, ".conflicts");
  const saveConflict = (name: string, text: string): string => {
    const p = join(conflictsDir, name);
    if (!dry) {
      mkdirSync(conflictsDir, { recursive: true });
      writeFileSync(p, text);
    }
    return relative(dir, p);
  };

  for (const file of listNoteFiles(dir)) {
    const rel = relative(dir, file);
    const push = (action: ImportAction, extra: Omit<ImportEntry, "file" | "action"> = {}): void => {
      entries.push({ file: rel, action, ...extra });
    };
    let parsed: ParsedFile;
    let mtime: number;
    try {
      parsed = parseNoteFile(readFileSync(file, "utf8"));
      mtime = statSync(file).mtimeMs;
    } catch (e) {
      push("rejected", { detail: `unreadable: ${(e as Error).message}` });
      continue;
    }
    const { fm } = parsed;

    // Title: front-matter, else a leading "# Heading", else the filename.
    let body = parsed.body;
    let title = typeof fm.title === "string" ? fm.title : "";
    if (!title.trim()) {
      const h = /^#\s+(.+)\n?/.exec(body);
      if (h) {
        title = h[1].trim();
        body = body.slice(h[0].length).replace(/^\n/, "");
      } else {
        title = basename(file, ".md");
      }
    }
    const parentIsNsFolder = dirname(file) !== dir;
    const namespace =
      typeof fm.namespace === "string" && fm.namespace.trim()
        ? fm.namespace.trim()
        : parentIsNsFolder
          ? basename(dirname(file))
          : "default";
    const content: NoteContent = { namespace, title, body, tags: normTags(fm.tags) };
    const fileHash = contentHash(content);
    const fmHash = typeof fm.hash === "string" ? fm.hash : null;
    const origin = typeof fm.origin === "string" ? fm.origin : null;
    const originId = typeof fm.id === "number" && Number.isInteger(fm.id) ? fm.id : null;
    const hasIdentity = origin !== null && originId !== null;

    let localId: number | null = null;
    if (hasIdentity) localId = origin === self ? originId : store.syncLookup(origin!, originId!);
    const local = localId !== null ? store.read(localId) : null;
    // Merge base: what THIS store last synced for the note; the file's own
    // front-matter hash only when this store has never synced it (another
    // machine's export carries that machine's base, not ours).
    const baseHash = (local ? store.syncBase(local.id) : null) ?? fmHash;
    const fileChanged = baseHash === null || fileHash !== baseHash;
    const remember = (id: number, hash: string): void => {
      if (!dry) store.setSyncBase(id, hash);
    };

    // Run a store write, mapping linter / validation outcomes to entries.
    const attempt = async (
      fn: () => NoteRecord | null,
      ok: ImportAction,
      detail?: string
    ): Promise<void> => {
      if (dry) {
        push(ok, { ...(local ? { id: local.id } : {}), detail: detail ? `${detail} (dry run)` : "dry run" });
        return;
      }
      try {
        const n = fn();
        if (!n) {
          push("skipped", { detail: "note vanished during import" });
          return;
        }
        await maybeEmbed(store, n);
        remember(n.id, contentHash(n));
        push(ok, { id: n.id, ...(detail ? { detail } : {}) });
      } catch (e) {
        if (e instanceof QuarantinedError) {
          push("quarantined", { detail: `quarantine #${e.quarantineId}: ${e.message}` });
        } else if (e instanceof ValidationError) {
          push("rejected", { detail: e.message });
        } else {
          throw e;
        }
      }
    };
    const createFrom = (): NoteRecord => {
      const n = store.create(
        {
          namespace,
          title,
          body,
          tags: content.tags,
          source: typeof fm.source === "string" ? fm.source : undefined,
          created_at: typeof fm.created_at === "string" ? fm.created_at : undefined,
        },
        { updatedAt: typeof fm.updated_at === "string" ? fm.updated_at : undefined }
      );
      if (hasIdentity && origin !== self) store.syncLink(origin!, originId!, n.id);
      // A hand-written file gets its identity written back, so the next
      // import updates this note instead of creating it again.
      if (!hasIdentity) writeFileSync(file, renderNoteFile(n, { origin: self, id: n.id }));
      return n;
    };

    if (!local) {
      if (hasIdentity && origin === self) {
        // Deleted in this store after the export.
        if (fileChanged) await attempt(createFrom, "restored", "note was deleted here but the file was edited");
        else push("skipped", { detail: "note was deleted in this store" });
      } else {
        await attempt(createFrom, "created");
      }
      continue;
    }

    const localHash = contentHash(local);
    if (localHash === fileHash) {
      remember(local.id, localHash);
      push("unchanged", { id: local.id });
      continue;
    }
    const localChanged = baseHash === null || localHash !== baseHash;
    const applyFile = (): NoteRecord | null =>
      store.update(local.id, { namespace, title, body, tags: content.tags }, { ifRev: local.rev });

    if (!fileChanged) {
      push("skipped", { id: local.id, detail: "store has a newer version" });
      continue;
    }
    if (!localChanged) {
      await attempt(applyFile, "updated");
      continue;
    }
    // Both sides changed: newer wins, the loser is preserved.
    const fileTime = Math.max(
      typeof fm.updated_at === "string" ? Date.parse(fm.updated_at) || 0 : 0,
      mtime
    );
    const localTime = Date.parse(local.updated_at) || 0;
    const stem = basename(file, ".md");
    if (fileTime > localTime) {
      const saved = saveConflict(
        `${stem}.store-rev${local.rev}.md`,
        renderNoteFile(local, hasIdentity ? { origin: origin!, id: originId! } : { origin: self, id: local.id })
      );
      await attempt(applyFile, "conflict", `file was newer and won; store version saved to ${saved}`);
    } else {
      const saved = saveConflict(`${stem}.file.md`, readFileSync(file, "utf8"));
      // The file's version is now preserved and "seen": until the store
      // exports again (or the file is edited again) the store keeps winning.
      remember(local.id, fileHash);
      push("conflict", { id: local.id, detail: `store was newer and won; file version saved to ${saved}` });
    }
  }

  const counts = {
    created: 0,
    updated: 0,
    restored: 0,
    unchanged: 0,
    skipped: 0,
    conflict: 0,
    quarantined: 0,
    rejected: 0,
  } as Record<ImportAction, number>;
  for (const e of entries) counts[e.action]++;
  return { dir, entries, counts };
}
