# Plain-file sync (Markdown)

Your memory as a folder of Markdown files you can read, grep, edit in any
editor, diff in git, and sync with anything that syncs files.

```bash
onememory export --format md --dir ~/memory     # store -> files
onememory import --dir ~/memory --dry-run       # what would merge back?
onememory import --dir ~/memory                 # files -> store
```

## Layout

```
~/memory/
  work/
    release-cadence--b48d83f6-12.md
  home/
    dentist--b48d83f6-3.md
  .conflicts/            # only after a conflict; never imported
```

One file per note, in a folder per namespace (unsafe characters become
`_`; the folder is cosmetic, the front-matter `namespace` is authoritative).
The filename is `<title-slug>--<origin store, 8 hex>-<id>.md`.

```markdown
---
id: 12
origin: "b48d83f6-2fdc-4df8-899b-98d7bc60bdc5"
namespace: "work"
title: "Release cadence"
tags: ["decision"]
source: "claude-code"
created_at: "2026-10-14T09:00:00.000Z"
updated_at: "2026-10-15T10:30:00.000Z"
rev: 3
hash: "9b1f0c2a7d3e4f51"
---
Ship weekly on Thursdays.
```

Values are JSON-encoded, which is valid YAML. The body is stored verbatim
(one trailing newline is added on export and removed on import; CRLF is
normalized). `hash` is the content hash at export.

**Deterministic:** fixed key order, notes in id order, LF endings, and a file
is only rewritten when its bytes change — re-exporting an unchanged store
produces no diff. Export **prunes** files it wrote earlier for notes that were
deleted or renamed (only files carrying OneMemory front-matter; your own files
in the folder are never touched). `--no-prune` keeps them. `--namespace ns`
exports one namespace.

## Writing new notes as files

Drop any `.md` file into the folder. Front-matter is optional: without
`title`, a leading `# Heading` (or the filename) becomes the title; without
`namespace`, the folder name (or `default`). Plain YAML (`title: My note`,
`tags: [a, b]`, block lists) is accepted. After the import creates the note,
the file is rewritten with full front-matter so the next import updates it
instead of creating it again.

## How import merges

Import is three-way. The **base** is the content hash this store last
exported or merged for the note (kept per store in `sync_base`); for a note
this store never synced, the file's own `hash` is used.

| File vs base | Store vs base | Result |
|---|---|---|
| same | same | `unchanged` |
| changed | same | `updated` — file wins (compare-and-swap on the note's rev) |
| same | changed | `skipped` — store is newer; the next export refreshes the file |
| changed | changed, same content | `unchanged` |
| changed | changed, different | `conflict` — the **newer** side wins; the loser is written to `.conflicts/` |

"Newer" compares the store's `updated_at` with the file's
`max(front-matter updated_at, file mtime)`. Nothing is silently lost: a
conflict always leaves the losing version in `.conflicts/` and is listed in
the report. After a conflict is resolved it is not raised again.

Other outcomes: `created` (new file or another store's note), `restored`
(the note was deleted here but the file was edited afterwards — an
unedited file of a deleted note is `skipped`), `quarantined` / `rejected`
(every import write goes through the [memory linter](./memory-linter.md)).
**Import never deletes notes.** Deleting a file does not delete the note; to
propagate a delete, delete the note in the store and export (prune).

`--json` prints the full per-file report.

## Several machines, one folder

Every store has a UUID (`_meta.store_uuid`). A note's identity is
`(origin store, id)`, so ids that collide between machines never get mixed
up: importing another store's file creates a local note and remembers the
mapping (`sync_map`), the next import updates that same note, and this
store's export writes it back under its **original** identity and filename.
Two machines exporting into one git repo converge on the same files.

### GitHub (private repo)

```bash
# once
mkdir ~/memory && cd ~/memory && git init && git remote add origin git@github.com:you/memory.git

# on each machine, e.g. from cron or a shell alias
cd ~/memory
git pull --rebase
onememory import --dir .          # merge others' edits in
onememory export --format md --dir .
git add -A && git commit -m "memory sync $(hostname) $(date -u +%FT%TZ)" && git push
```

Import before export, so your store absorbs remote edits before it rewrites
the files. Add `.conflicts/` to `.gitignore` if you would rather review
conflicts locally only. Use a **private** repository: notes are plaintext.

### Syncthing / Dropbox / iCloud

Point the sync tool at the folder and run the same two commands on each
machine (import, then export) on a timer. The sync tool's own conflict
copies (`*.sync-conflict-*.md`, Dropbox "conflicted copy") carry the same
note identity as the original, so import **skips** them and reports them —
merge them by hand.

## Limits

- Not a live sync: run the commands (or a timer). The CLI uses full local
  trust and ignores server-side namespace resolution, like the other
  maintenance commands.
- Conflicts are whole-note, not line-level merges.
- Deletes do not propagate through files (see above).
