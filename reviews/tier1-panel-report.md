# Expert Panel Review — OneMemory Tier 1 Competitor-Gap Implementations

**Date:** 2026-10-16
**Scope:** 4 features from COMPETITOR-GAP-ANALYSIS.md — SessionStart hook, server-side namespace resolution, time-phrase parser, auto-consolidation/dedup
**Integration commit reviewed:** `fcc3589`
**Panel:** Security Engineer · Systems/Database Engineer · MCP/Protocol Specialist · Search/IR Engineer · DX/CLI Designer
**Tests at review time:** 272/272 green (passing tests do not imply correctness — see below)

---

## ⛔ DO NOT SHIP — Blockers

These must be fixed before Tier 1 reaches users. Three are silent data-loss or cross-namespace confidentiality failures.

### 1. [CRITICAL] Time-scoped semantic/hybrid search silently returns nothing
**Found by:** Search/IR Engineer (also noted by Systems/DB)
**Location:** `src/search-service.ts:119-122`, `src/store.ts:558-585`
`store.semanticSearch()` accepts no time range. The semantic branch fetches the global top-200 cosine hits, then discards out-of-window notes in JS. Reproduced: 10 "yesterday" notes about "budget" + 290 older notes → 0 results despite 10 true positives. Hybrid degrades to keyword-only.
**Fix:** Push the range into the vector SQL (`AND n.created_at >= ? AND n.created_at < ?`).

### 2. [HIGH] SessionStart hook leaks all namespaces — silent cross-project exposure
**Found by:** Security Engineer, DX/CLI Designer, Systems/DB Engineer (same root cause)
**Location:** `src/recall.ts:57-80`
`tryResolveNamespace()` calls `resolveNamespace()` with zero arguments; the real signature is `resolveNamespace(cwd, cfg)`. The TypeError is swallowed by `catch {}`, so the hook always falls back to unscoped recall. Any deployment with namespace isolation gets other projects' notes injected pre-prompt, with zero signal. The hook also performs no token/scope check, and omits the injection-on-read UNTRUSTED_BANNER at the highest-leverage injection position.
**Fix:** Call `resolveStartupNamespace(process.cwd())`; prepend the untrusted-data banner; log loudly on stderr when configured-but-unresolvable instead of failing silently into unscoped mode.

### 3. [HIGH] `reads_from` grants confer WRITE access (update-by-id and DELETE)
**Found by:** Security Engineer
**Location:** `src/mcp-server-core.ts:209,389`; `src/api.ts:101,262,283`
Update and delete paths gate on `canRead()`, which returns true for `reads_from`-granted namespaces. An agent with a read grant to `shared` can overwrite or delete `shared`'s notes. The module's own documented invariant ("grants never confer write access") is violated; `memory_consolidate` got this right, update/delete did not.
**Fix:** Write/delete paths must check `note.namespace === ownNs`, not `canRead`.

### 4. [HIGH] Background auto-consolidation ignores namespace isolation — deletes other namespaces' notes
**Found by:** Security Engineer, Systems/DB Engineer (same root cause)
**Location:** `src/start.ts:48-113`
The janitor runs `findCandidates(store.exportAll())` across all namespaces and merges with `deleteSources: true`, never consulting `nsOpts`. With the product's own multi-server deployment model, server A silently restructures and deletes server B's notes on a timer. No token scope is checked.
**Fix:** Restrict the candidate pool to `ownNs` when resolution is active (same rule as the MCP tool).

### 5. [HIGH] REST `/export` and `/import` bypass namespace resolution
**Found by:** Security Engineer
**Location:** `src/api.ts:383` (export), `src/api.ts:402` (import)
`/export` dumps every namespace with no filter; `/import` preserves client-supplied namespaces. An admin token holder exfiltrates all namespaces (defeating one-directional grants) or plants notes into a victim namespace (memory poisoning).
**Fix:** Filter export to `readable()` when `nsActive`; force imported notes into `ownNs`.

### 6. [HIGH] Auto-merge at 0.99 deletes distinct notes (tokenizer drops single-char tokens)
**Found by:** Search/IR Engineer
**Location:** `src/consolidate.ts:34`, `src/start.ts:46`
`tokenize()` drops tokens < 2 chars. Two terse notes differing only in single-letter codes both reduce to the same token set → cosine 1.0 → scheduler auto-merges and deletes both sources. Silent data loss through the path documented as "conservative."
**Fix:** Require minimum content-token count (e.g. ≥4) before auto-merge eligibility, or require exact string equality for the 0.99 band.

### 7. [HIGH] Merge is not atomic — crash leaves partial state
**Found by:** Systems/DB Engineer
**Location:** `src/consolidate.ts:228-248`
Create + N deletes run as separate implicit transactions (unlike `Store.update()` which uses `BEGIN IMMEDIATE`/`COMMIT`). Crash mid-merge → merged note plus surviving sources, no record of in-flight merge.
**Fix:** Wrap in a single transaction (add `Store.transaction(fn)` helper).

### 8. [HIGH] Read-then-delete TOCTOU in consolidation
**Found by:** Systems/DB Engineer
**Location:** `src/consolidate.ts:202-248`
Notes are read, then deleted by bare id with no rev guard. A concurrent update between read and delete is silently destroyed; a concurrent delete is resurrected into the merged note. The background janitor makes this a standing race, not a narrow window.
**Fix:** Re-read `rev` inside the merge transaction; abort on change/vanish; use guarded deletes.

---

## HIGH (non-blocking but urgent)

- **"The day before yesterday" parses as yesterday** (Search/IR; `src/time-parse.ts:377`) — add explicit branch before the bare `yesterday` check.
- **Invalid dates roll into wrong month with lying label** (Search/IR, Systems/DB; `src/time-parse.ts` ~289/299/315) — "Feb 30" → March 2 labeled "2026-02-30". Apply the YYYY-MM-DD branch's round-trip guard to all date branches.
- **Hook install doc assumes `onememory` on PATH** (DX/CLI; `docs/sessionstart-hook.md`) — most install paths don't provide it; fail-silent makes the failure invisible. Add per-path prerequisites + verification.
- **`--dry-run` preview hides the merged note** (DX/CLI; `src/cli.ts:227-235`) — title/tag-count/body-length only; user approves a destructive merge blind. Print the merged body.
- **O(n²) candidate scan blocks the event loop** (Systems/DB; `src/consolidate.ts:107-165`) — ~1.2s stall per 2000 notes; freezes all HTTP/MCP traffic on scheduler ticks and `memory_consolidation_candidates` calls. Move to worker thread or paginate.

## MEDIUM

- **5s "hard timeout" isn't hard** (MCP, Systems/DB; `src/recall.ts:73-81`) — `Promise.race` can't preempt synchronous SQLite. Use a worker thread with terminate, or document honestly.
- **"Namespace param removed" premise is inaccurate** (MCP; `src/mcp-server-core.ts`) — `namespace` remains in 4 tool schemas as optional; only neutralized when `nsActive`. Strip from schemas at server-build time when active.
- **Merged notes lose date and embedding** (Search/IR, Systems/DB; `src/consolidate.ts`) — `created_at = now` breaks time search; no `maybeEmbed` call makes them invisible to semantic search. Preserve `min(sources).created_at`; call `maybeEmbed` after merge.
- **Coarse time patterns shadow clock times** (Search/IR; `src/time-parse.ts:226-234`) — "last night at 9pm" → whole night window. Intersect daypart + clock time.
- **"around 12:15am" truncated at midnight** (Search/IR; `src/time-parse.ts:259`) — drops 23:45–00:00. Mirror the end-of-day spill logic.
- **Time interpretation invisible to caller** (Search/IR, DX/CLI) — parsed range label discarded; unparseable `when` silently unscoped. Return `{timeRange}` in responses.
- **No index on `created_at`** (Search/IR, Systems/DB; `src/store.ts`) — time-scoped queries scan. Add `idx_notes_ns_created`.
- **0.95/0.99 thresholds unvalidated** (Search/IR) — round-number guesses; 0.95 band noisy on short notes. Validate against labeled real notes.
- **False-positive time extraction** (Systems/DB; `src/time-parse.ts:313-320`) — "1/2 cup flour" → Jan 2; "login july" matches "in". Tighten regex boundaries.
- **`recall` swallows unknown flags** (DX/CLI; `src/cli.ts:158-180`) — `--limt` typo silently degrades. Warn on stderr.
- **`doctor` doesn't test the hook** (DX/CLI) — no recall smoke test, no budget check, no settings.json check. Add all three.
- **Help text says WHAT not WHEN** (DX/CLI) — add one-line purpose + doc pointer per command.
- **README badge stale** (DX/CLI) — `tests-182/182` vs 272/272 in Status section.
- **Hook doc gaps** (DX/CLI) — no min Claude Code version, no merge-don't-clobber guidance, no "did it fire" check.
- **`--threshold` silently clamped** (DX/CLI; `src/consolidate.ts:93-96`) — warn when rewriting user input.
- **`reads_from` revocation needs restart** (Security) — stale grants persist. Document or add SIGHUP reload.
- **Recall hook omits injection guard** (Security; counted in blocker #2's fix) — prepend UNTRUSTED_BANNER.

## LOW

- CLI `recall` exits 1 on module-load failure (MCP) — wrap import, exit 0 with empty JSON.
- `ids` min-2 surfaces as -32602 not tool error (MCP) — document or relax schema.
- Candidates description omits hint-fallback (MCP) — one clause addition.
- 403-vs-404 oracle across namespaces (Security) — uniform "not found".
- Overlap error narrower than documented (Security) — document actual guarantee.
- Doctor missing-path warning not actionable (DX/CLI); `consolidate --namespace` nonexistent ambiguous (DX/CLI); `--budget-ms 0` → 800 silently (DX/CLI); hook doc Windows path + python3 assumption (DX/CLI); default vs --dry-run overlap (DX/CLI).
- `resolveTimeZone` "logs once" actually logs always (Search/IR, Systems/DB) — memoize.
- "am" missing from stopwords (Search/IR); "noon"/"midnight"/"tomorrow" unsupported (Search/IR); both-empty token sets score 1.0 (Search/IR).
- Merged note no embedding until reindex (Systems/DB — counted in MEDIUM fix above).
- Two instances, same DB, different namespaces (Systems/DB) — warn on divergence.
- Symlinked cwd defeats matching (Systems/DB) — realpath before match.
- `buildConsolidationPreview` trusts non-empty input (Systems/DB) — guard.

---

## What the panel cleared (no issues)

- **Hook output shape** is exactly the Claude Code `hookSpecificOutput` nesting; 8000-char cap is under the 10k silent-drop threshold. (MCP)
- **Scope gating** on both new tools enforced on both transports; `SCOPE_RANK` ordering correct. (MCP)
- **`when` param** present, documented, never errors on garbage. (MCP)
- **Model namespace manipulation closed** on all 7 tools when `nsActive`. (MCP, Security)
- **Secret re-scan** happens on merged notes via `store.create → validateContent`. (Security)
- **Create-before-delete** ordering correct; FTS triggers keep index in lockstep. (Security, Systems/DB)
- **Time parser ReDoS-safe**; overlap error never reaches clients; path traversal safe; SQL parameterized. (Security)
- **No schema migration needed** — Tier 1 is code-only. (Systems/DB)
- **DST, Monday-weeks, bare-month, MM/DD, end-exclusive ranges** all correct. (Search/IR, Systems/DB)
- **WAL + busy_timeout** set; namespace overlap detection correct; threshold clamping sound. (Systems/DB)
- **Consolidate safety UX** (`--dry-run`/`--yes`), flag naming, overlap error message, doctor path validation, config docs, SKILL.md accuracy. (DX/CLI)

---

## Recommended fix order

1. Semantic time-range pushdown (CRITICAL — search correctness)
2. Hook namespace resolution + banner + loud misconfiguration (blockers #2)
3. `reads_from` write-escalation on update/delete (blocker #3)
4. Export/import namespace bypass (blocker #5)
5. Auto-consolidation namespace gate (blocker #4)
6. Merge atomicity + TOCTOU guards (blockers #7, #8)
7. Tokenizer single-char fix + auto-merge token gate (blocker #6)
8. Time parser: day-before-yesterday, date round-trip guards, clock shadowing, midnight spill (HIGHs)
9. `created_at` index + preserve date/embed on merge (MEDIUMs)
10. DX: hook PATH prerequisites, dry-run preview body, doctor hook check, threshold warnings (HIGH/MEDIUM DX)
11. Remaining MEDIUMs and LOWs in a hardening pass

---

*Panel reports retained in full as delivered; this document deduplicates overlapping findings (same root cause reported by multiple experts is listed once with all attributions).*
