# Change feed — "what changed while I was away"

Ask the store what happened since a point in time: which notes were
**created**, **updated** or **deleted**, by which source (client/agent), with
counts. Useful at the start of a session on a second device, or for an agent
that wants to catch up before acting.

```
memory_since({ since: "24h" })
memory_since({ since: "last", consumer: "phone" })
GET  /changes?since=2026-10-15T09:00:00Z&namespace=work&limit=50
onememory changes --since last --consumer laptop
```

The dashboard has a **Changes** button (last 24 hours).

## Parameters

| Param | Meaning |
|---|---|
| `since` | An ISO time (`2026-10-15T09:00:00Z`, `2026-10-15`), a duration back from now (`90s`, `30m`, `24h`, `7d`, `2w`), or `last`. Anything else is a 400 / tool error — never a silent full dump. |
| `cursor` | `nextCursor` from the previous page (then `since` is not needed). |
| `namespace` | Restrict to one namespace. Under server-side namespace resolution it is an untrusted hint, intersected with the readable set, exactly like `/search`. |
| `source` | Only notes with this provenance `source`. |
| `limit` | Page size, default 100, max 500. |
| `consumer` | Label for the `last` marker (`phone`, `claude-code`, …; default `default`). 1–64 chars of `A-Za-z0-9._@-`. |

Scope: **read** (REST and MCP).

## Response

```json
{
  "since": "2026-10-15T21:00:00.000Z",
  "until": "2026-10-16T21:00:00.000Z",
  "counts": { "created": 2, "updated": 1, "deleted": 1, "total": 4 },
  "bySource": {
    "phone":       { "created": 1, "updated": 1, "deleted": 0 },
    "claude-code": { "created": 1, "updated": 0, "deleted": 1 }
  },
  "quarantined": 0,
  "changes": [
    { "kind": "created", "id": 41, "namespace": "work", "title": "Release cadence",
      "source": "claude-code", "at": "2026-10-16T09:12:03.120Z", "rev": 1 },
    { "kind": "deleted", "id": 17, "namespace": "work", "title": "Old staging URL",
      "source": "claude-code", "at": "2026-10-16T10:01:44.500Z" }
  ],
  "nextCursor": null,
  "consumer": "phone",
  "searchedNamespaces": []
}
```

- **Titles only, never bodies** — read a note (`state_read`) for its content.
  Over MCP the payload carries the untrusted-data banner (titles are
  attacker-writable).
- Entries are oldest first. A note created *and* edited in the window shows
  once, as `created`, with its current title; created-then-deleted shows only
  the delete. Consolidation shows as one `created` plus the deleted sources.
- `counts` / `bySource` cover the **whole window**, not just the page.
  `quarantined` counts linter-held writes queued in the window (they are not
  notes; see [memory-linter.md](./memory-linter.md)).
- The window `[since, until)` is frozen when the first page is requested and
  travels inside the cursor, so writes that land while you page never shift
  or duplicate entries.

## How `last` works

One marker per `(consumer, namespace scope, source filter)`, stored in the
`_meta` table as `changes_seen:<consumer>|<scope>`. A consumer with no marker
gets the last 24 hours. The marker moves to the window's `until` **only when
the final page has been served**, so a reader that stops half-way sees the
rest next time; consecutive windows tile exactly (no gap, no overlap).

Why a caller-chosen label instead of "per token": OneMemory tokens are bare
secrets with a scope, not identities, and several devices often share one
token. A label also lets one device keep separate markers for separate jobs.
Anyone who can read the feed can move a label's marker; that only affects
what *that label* sees next as "new" — it never hides or deletes data.

## Deletes (tombstones)

Deletes are recorded in `note_tombstones` (schema v7): note id, namespace,
title, source and time — no body. Tombstones older than 90 days are pruned
on the next delete. Deletes made before upgrading to 1.1.0 are not in the
feed.

## Limits

- The feed is keyed on `updated_at`. A restore via `/import` keeps the
  backup's `updated_at`, so restored notes appear at their original time,
  not as fresh changes.
- Access-count bumps (reads) are not changes.
