# OneMemory SessionStart hook

Injects your recent OneMemory notes into the agent's context **before its
first message** — pre-prompt memory, no model opt-in needed.

## What it does

`onememory recall` reads the most recently updated notes from your local
SQLite store and prints them as a Claude Code hook JSON payload:

```json
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
```

`additionalContext` is a compact human-readable summary, e.g.:

```
Recent memory (3 notes):
- [Release cadence]: Ship weekly on Thursdays (decided 2026-10-14)
- [API base URL]: https://api.acme.example/v2
- [Pref]: Keep replies short and concrete.
```

Recency is the recall signal at session start — no embeddings, no query,
one cheap SQL query (`ORDER BY updated_at DESC`). Flags:

- `--budget-ms 800` — soft budget in milliseconds (default 800). If the
  recall work exceeds it, what was fetched is returned anyway; nothing hangs.
- `--limit 10` — max notes included (default 10).

Total output is capped at ~8000 characters so the hook never blows up your
context window.

## Install (Claude Code settings)

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear",
        "hooks": [
          { "type": "command", "command": "onememory recall --budget-ms 800" }
        ]
      }
    ]
  }
}
```

### Why `matcher: "startup|clear"` — NOT on compact

Fire the hook on **startup** (new session) and **clear** (`/clear` wipes
context, so re-injection is useful). Do **not** fire it on `compact`:
after compaction the model already has full context, and re-injecting the
same notes just wastes tokens. Omit the matcher only if you understand that
trade-off.

## Fail-silent by design

This hook **blocks session start**, so it is engineered to never break it:

- Exit code is always `0`, on any failure.
- On failure stdout is still valid hook JSON with empty `additionalContext`
  (`""`) — never a stack trace. Diagnostics go to stderr only.
- A missing or corrupt database, a missing config, a thrown error, or a
  timeout all degrade to the empty-context payload.
- Hard timeout of 5s via `Promise.race` — the hook cannot hang
  indefinitely.

Safe to install and forget: if OneMemory is ever broken or uninstalled,
your sessions start normally, just without injected memory.

## Verifying it works

```bash
onememory recall                       # pretty-prints nothing; it's JSON
onememory recall | python3 -m json.tool
ONEMEMORY_DB_PATH=/nope/db.sqlite onememory recall   # fail-silent check
echo $?                                # 0
```

## Notes for other agents

The same payload works anywhere a SessionStart-style hook is supported.
The namespace is resolved server-side when available
(`src/namespace.ts`, optional); without it the hook recalls across all
namespaces.
