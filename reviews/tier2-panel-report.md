# OneMemory Tier 2 — Expert Panel Report

**Branch:** `feat/tier2-v3` · **Commit:** `2abc43e`
**Tests:** 400/400 green (implementers' claim; panel did not re-run the full suite)
**Review date:** 2026-10-16
**Panel:** Security Engineer · Database Engineer · Search/IR Engineer · MCP/Protocol Specialist · Systems Engineer

**Tier 2 scope:** similarity edge graph (`note_edges`, migration v4), access tracking
(`access_count`/`last_accessed`, migration v3), staleness detection (`src/staleness.ts`),
`state_relevant` keyword search (`src/keywords.ts`), new MCP tools
(`memory_rebuild_edges`, `memory_stats`), new CLI commands (`rebuild-edges`, `relevant`).

---

## DO NOT SHIP blockers

Four issues must be fixed before market. Each is independently confirmed by at least
one expert, and two were confirmed empirically against the running code.

### BLOCKER 1 — Rebuild-edges is an O(n²) blocking transaction that freezes the server
**Sources:** Systems (CRITICAL), Database (supporting)
**Refs:** `src/store.ts:1013–1075`, `src/mcp-server-core.ts:733`, `src/cli.ts:480`

`rebuildEdges()` scores every note pair with per-pair re-tokenization (`O(pairs ×
avg_tokens)`), inside a single `BEGIN IMMEDIATE`/`COMMIT` on synchronous
DatabaseSync. The event loop is blocked and the SQLite write lock held for the
entire run. The MCP tool path means **one admin tool call freezes every API +
MCP request**; the CLI second-process path means **all server writes fail with
`SQLITE_BUSY`** for the duration. No input cap, no cooperative yields, no
progress output, not resumable. Estimates: 1k notes → 15–30s stall; 10k notes →
25–45 min; 100k → days.

**Fix:** (a) precompute term-frequency maps once per note before the pair loop;
(b) restructure as async with `setImmediate` yields every ~8k pairs, committing
in per-chunk transactions (chunk boundary = resume point); (c) gate the MCP
tool behind confirmation or refuse above a note-count threshold; (d) CLI prints
pair count and confirms before large rebuilds; stream progress to stderr.

### BLOCKER 2 — `touch()` turns every read into 3 writes via the FTS trigger
**Sources:** Database (CRITICAL C1), Systems (HIGH #2)
**Refs:** `src/store.ts:342–353` (trigger), `src/store.ts:346` (touch),
`src/search-service.ts:114–116`, `142–149` (bumpAccess)

The `notes_au` trigger has no `WHEN` clause, so `touch()`'s metadata-only
`UPDATE` fires a full FTS5 delete + re-insert per call. `bumpAccess` touches
every returned note (up to 200/search) → a single search issues up to ~600
write statements. This multiplies WAL growth, checkpoint cost, and write-lock
hold time ~3× on read-heavy workloads, and sits on the response critical path
(+4–20ms per 20-result search estimated).

**Fix:** gate the trigger on content columns (requires `DROP TRIGGER` +
recreate → migration v5):
```sql
CREATE TRIGGER notes_au AFTER UPDATE ON notes
WHEN (old.title IS NOT new.title OR old.body IS NOT new.body OR old.tags IS NOT new.tags)
BEGIN ... END;
```
Additionally: take touch off the response path (in-memory `Map` flushed
periodically in one transaction), and/or batch `bumpAccess` into a single
`UPDATE ... WHERE id IN (...)`.

### BLOCKER 3 — `touch()` can 500 a plain GET under write contention
**Sources:** Database (CRITICAL C2)
**Refs:** `src/store.ts:420`, `src/api.ts:248`

`read(id, {trackAccess: true})` calls `touch()` (a write) *before* the
`SELECT`. Under contention it blocks to `busy_timeout = 5000ms`, then throws
`SQLITE_BUSY` → HTTP 500 on `GET /notes/:id`. The contention source is real:
`update()`/`consolidateNotes()` hold `BEGIN IMMEDIATE` through O(m·t)
CPU-bound similarity scoring inside the write transaction, starving concurrent
touches; search bursts (each = 1+k writes via `bumpAccess`) make it
self-inflicted. **Reads must never fail because of write contention.**

**Fix:** (a) make `touch()` best-effort — catch `SQLITE_BUSY`/any error and
skip (a lost read-count is acceptable; a failed read is not); (b) move the
O(m·t) score computation outside the write transaction (score against a
snapshot, apply in a short txn); (c) batch/debounce touches.

### BLOCKER 4 — `touch()` fires before the authorization gate: cross-namespace write primitive
**Sources:** Security (MEDIUM, empirically confirmed), Database (M3), Protocol (LOW-2)
**Refs:** `src/mcp-server-core.ts:285→287`, `src/api.ts:248→251`

Both `state_read` (MCP) and `GET /notes/:id` (REST) call
`store.read(id, { trackAccess: true })` **before** the `canRead` /
`denyUnreadable` check. **Empirically confirmed:** 50 denied `state_read`
calls against a foreign-namespace note moved its `access_count` 0 → 50.
Consequences: (a) pollutes importance weighting; (b) `accessBoost()` weights
search ranking by `access_count`, so a read-only attacker can **manipulate
another namespace's search ranking** by blindly sweeping id ranges (missing
ids are silent no-ops); (c) defeats the "never read / dead memory" signal;
(d) performs a write (+FTS churn per Blocker 2) for a request that will be
rejected; (e) timing difference between existing-id and missing-id is a minor
existence oracle.

**Fix:** gate before tracking — lightweight untracked `SELECT namespace`
first, then full `read()` with `trackAccess` only on the authorized path:
```ts
const note = store.read(id, { withNeighbors: neighbors === true });
if (!note) return errorResult(`no note with id ${id}`);
if (nsActive && !canRead(grants, ownNs, note.namespace)) return errorResult(`no note with id ${id}`);
store.touch(id); // authorized read only
```
Same reorder in `api.ts`.

---

## Findings by expert

### Security Engineer

**S-MEDIUM-1 — (consolidated as BLOCKER 4 above)**

**S-LOW-1 — Neighbor computation runs pre-gate: timing oracle for foreign id existence**
`src/mcp-server-core.ts:285`. `withNeighbors: true` triggers `listNeighbors()`
(JOIN + sort) plus the `touch()` write before the uniform "no note" denial —
existing-but-unreadable ids cost measurably more than missing ids. Low
severity (ids are sequential anyway). **Fix:** same reorder as Blocker 4 —
no DB work before the gate passes.

**S-LOW-2 — `memory_consolidate` leaks foreign-namespace id existence via distinguishable errors**
`src/mcp-server-core.ts:653–662`. `resolveConsolidationNotes(store, ids)` runs
before the own-namespace gate → three distinguishable outcomes ("no note with
id 99999" vs "cannot consolidate notes from different namespaces" vs
"access denied"). **Empirically confirmed** the missing-vs-foreign
distinction. Read-scoped attackers can't reach this (`denyIfUnder("admin")`
holds), so defense-in-depth. **Fix:** check own-namespace membership first,
or collapse to one uniform error.

**S-LOW-3 (info) — Unreadable `namespace` hints silently fall back to the full readable set**
`trustedHint()` returns `undefined` for unreadable hints; callers fan out over
all readable namespaces without telling the caller. No cross-boundary leak
(verified empirically), but a prompt-injected `namespace: "agent-b"` hint
yields `agent-a`+`shared` results the model may misattribute. **Fix:** echo
`searchedNamespaces: [...]` in responses.

**S-INFO-1 — No `/memory_stats` or `/rebuild-edges` REST endpoints exist.**
Only `POST /relevant` was added. Absence = no REST attack surface (not a
vuln), but see P-MEDIUM-2 for the parity decision.

**S-INFO-2 — CLI `rebuild-edges` bypasses namespace scoping entirely.**
Consistent with the local machine-owner trust boundary, but document it.

**Verified SECURE:** neighbor leakage via edge graph (same-namespace-only at
all three write sites + read-time re-check; legacy unscoped data cannot
produce cross-ns edges — table created empty at v4; empirically zero
cross-namespace edges); `memory_stats` scoping (read scope, `readable()`-set
counting, no foreign titles/counts leak); `memory_rebuild_edges` (admin-only,
verified; `ownNs` forced under nsActive; threshold validated); `state_relevant`
/ `POST /relevant` (fan-out strictly over readable namespaces; keywords derive
solely from caller message — verified no data-derived keywords; MCP path
bannered); staleness warnings (attached post-gate, no cross-ns content);
uniform denial errors on read/update/delete paths; consolidation write
isolation (own-namespace only; janitor wired with `ownNamespace`;
`/export` filtered by `canRead`, `/import` forced into `ownNs`).

---

### Database Engineer

**D-CRITICAL-1 — (consolidated as BLOCKER 2 above)**

**D-CRITICAL-2 — (consolidated as BLOCKER 3 above)**

**D-HIGH-1 — Write amplification: N autocommit UPDATEs per search**
`src/search-service.ts:142–149`. `bumpAccess` loops `store.touch(n.id)` — one
autocommit `UPDATE` per returned note (up to 200), each forcing a WAL fsync.
**Fix:** batch into one `UPDATE ... WHERE id IN (...)`, or wrap in
`store.transaction()`; best: coalesce-and-flush. (Subsumed by Blocker 2/3
fixes; listed separately for the fsync dimension.)

**D-HIGH-2 — `create()` edge computation is not atomic**
`src/store.ts:453–490`. `update()` runs `recomputeEdgesFor` inside
`BEGIN IMMEDIATE`; `create()` runs it in autocommit after the `INSERT`
commits → crash mid-loop = partial edge set, no incompleteness record.
**Fix:** use `SAVEPOINT`/`RELEASE` in `create()` (nests safely inside
`consolidateNotes`' transaction).

**D-HIGH-3 — Import path is O(N²): `importNotes` triggers per-note edge recompute**
`src/store.ts:715–743` × `872`. Each `create()` runs a full O(m·t)
same-namespace scan → restoring N notes costs O(N²) cosine computations with
fresh tokenization per pair. **Fix:** internal `skipEdges` option on
`create()` for `importNotes`, then one `rebuildEdges()` at the end (with
precomputed token maps).

**D-MEDIUM-1 — Reverse-direction edge DELETE is a full table scan**
`src/store.ts:431–434`, `884–886`. Only `idx_note_edges_note_id` exists;
`DELETE ... WHERE note_id = ? OR neighbor_id = ?` scans O(E) per write.
**Fix:** `CREATE INDEX idx_note_edges_neighbor ON note_edges(neighbor_id)`;
consider composite `(note_id, score DESC)` to cover the neighbor query's
`WHERE + ORDER BY`.

**D-MEDIUM-2 — Rebuild re-tokenizes every pair**
`src/store.ts:991–1007`. **Fix:** precompute term-frequency maps once per
note (also applies to `recomputeEdgesFor`).

**D-MEDIUM-3 — (consolidated as BLOCKER 4 above)**

**D-MEDIUM-4 — Edge threshold is per-call, not stored: mixed-threshold graphs**
`rebuildEdges({threshold})` accepts caller threshold; `create()`/`update()`
hard-code 0.35. After a custom rebuild, the next write silently reverts that
note's edges to default. **Fix:** persist active threshold in a `_meta`
table; `create()`/`update()` read it. Minimum: document the invariant.

**D-MEDIUM-5 — `staleCount()` is an O(n) JS full-projection scan**
`src/store.ts:583–610`. `idx_notes_ns_created` doesn't cover staleness
(computed from `updated_at`+tags in JS). Accept as stats-path cost at
personal scale; no change recommended now.

**D-LOW-1 — No index on `access_count` for `accessStats` ORDER BY** (O(n log n)
sort; fine at scale; optional `(namespace, access_count DESC)`).
**D-LOW-2 — `touch()` on missing id is silent no-op** (acceptable
fire-and-forget contract; counts approximate under races).
**D-LOW-3 — FK enforcement is per-connection** (`PRAGMA foreign_keys = ON`
in constructor only); external tools bypass cascades — document in ops guide.

**Verified SOUND:** migration idempotency + sequential upgrade
(`user_version` guards, txn-wrapped, crash-retry safe); edge table design
(`PRIMARY KEY (note_id, neighbor_id)`, both directions stored deliberately,
no self-edges, same-namespace at write, FK cascade on both columns — note
DELETE cascade-deletes edges); stale-edge invalidation on UPDATE (same txn,
including namespace change); neighbor fetching not N+1; rebuild atomic
(rolls back to old set, honest `created`/`removed` accounting); FTS5 trigger
correctness (new columns not FTS-indexed); `clampInt` arg order;
consolidation edge interplay (merged note's neighborhood correct, sources'
edges vanish atomically).

---

### Search/IR Engineer

**I-HIGH-1 — Edge threshold 0.35 is cargo-culted from llmem's different metric**
`src/store.ts:164`, `src/consolidate.ts:33–50`, `73–81`. OneMemory uses
**cosine over raw TF vectors (no IDF)**; llmem's 0.35 was **BM25 doc-doc
normalized to [0,1)** — a different, IDF-weighted scale. Probe: "Dentist
appointment" vs "see dentist thursday" (one shared token) → **0.408**;
"Deploy checklist" vs "steps to deploy the api server" → **0.354**. TF-cosine
has no rarity weighting — short notes clear 0.35 on a single overlapping
token. No evaluation exists (no labeled pairs, no sweep); `consolidate.ts`
honestly flags 0.95/0.99 as "heuristic, NOT validated" but the edge
threshold lacks even that note.
**Fix:** (a) TF-IDF-weighted cosine (doc frequencies per namespace per
rebuild); (b) threshold sweep 0.15–0.6 on ~150 hand-labeled pairs, pick the
F1 knee (expect ~0.45–0.55). If keeping 0.35: require ≥2 shared content
tokens or minimum token-set size.

**I-HIGH-2 — Access-boost × staleness-penalty: the penalty is arithmetically dead at ≥10 accesses**
`src/search-service.ts:91–96`, `108–116`, `173–179`; `src/staleness.ts:33`.
Composition `base × (1 + 0.1·log10(1+c)) × 0.9`: stale note with 10 accesses
→ 0.994 ≈ fresh 1.0; 100 accesses → 1.08 > 1.0; 10k → 1.26. The penalty's
stated intent ("equally-relevant fresh note outranks it") holds **only for
<10 accesses**. Worse: `finalize()` calls `bumpAccess()` on returned notes →
**rich-get-richer loop** (ranking highly today buys tomorrow's boost),
log-dampened but unbounded over months. `last_accessed` is tracked but
**never used in ranking** — the decay signal exists in-schema and is ignored.
**Fix:** recency-aware boost, e.g. `1 + 0.1·log10(1+c)·exp(−daysSinceLastAccess/τ)`
(τ≈30d), or access velocity (last 30d). Consider graded stale penalty
(`0.95^n` per 90-day band). Minimum: document the 10-access erasure point.

**I-MEDIUM-1 — Staleness penalty/annotation missing on the `state_relevant` path**
`src/search-service.ts:262–287`, `src/mcp-server-core.ts:419–451`. No
`boostAndRank`, no `applyStalePenalty`, no `bumpAccess`, no
`annotateStaleness` — the vague-message path (most likely to act on outdated
facts) neither downranks stale notes nor warns. Two search modes, two
staleness contracts.
**Fix:** run `state_relevant` through the same pipeline + annotation.

**I-MEDIUM-2 — `state_relevant` discards FTS bm25; ties break by recency**
`src/search-service.ts:276–285`. Rank key = keyword-branch count, then
`updated_at`. Per-keyword bm25 thrown away → central-topic vs passing-mention
indistinguishable. Comment claims "floor 50" oversample (266–269) but
`clampInt` passes 50 as fallback default, not min (limit=5 → perKeyword=10)
— comment lies about the bound. High-frequency non-stopword ("project")
→ recency sample, not relevance ranking.
**Fix:** propagate bm25 into merge (sum × count or RRF); rarity-weight
keywords; fix the comment.

**I-MEDIUM-3 — Hashtag "preservation" is cosmetic; double-count inflation**
`src/keywords.ts:68–75`. FTS5 unicode61 strips `#` at index AND query time
(verified identical result sets) → `#status` indistinguishable from prose
"status". Worse: extraction yields both → note tagged `status` matches both
branches → count=2, outranking genuinely distinct keywords. "hey"/"hi"/
"thanks" not stop-words → greetings become keywords.
**Fix:** dedupe hashtag-vs-bare-stem; add conversational filler to
STOP_WORDS; or index tags with `#` intact via separate column.

**I-MEDIUM-4 — Stop-words English-only; three tokenization regimes**
`src/keywords.ts:17–44`. French/German function words survive; CJK
unhandled. `extractKeywords` drops <3 chars; edge `tokenize` keeps ≥2; FTS
keeps everything — "S3"/"Go"/"C#" vanish from relevant but live in
edges/FTS. Numeric hashtags (`#5` → FTS `5*`) match 50/500/5th.
**Fix:** unify tokenizer contract; digit carve-out (`S3`, `EC2`); document
English-only limitation; CJK bigram fallback or documented unsupported.

**I-LOW-1 — Neighbors lack staleness signal and access accounting**
`src/store.ts:985–1000`. 1-hop only, `ORDER BY score DESC`,
same-namespace re-check — transitive drift concern is **moot** (verified).
But neighbors aren't `annotateStaleness`'d and reads don't bump their
counters. **Fix:** annotate staleness (cheap, high-value).

**I-LOW-2 — Multi-namespace fan-out starves later namespaces**
`src/mcp-server-core.ts:119–157`. Per-namespace results concatenated in
`readable()` order, truncated to `limit` → 2nd namespace gets zero at
limit=5. **Fix:** per-namespace limit with global re-rank or round-robin.

**Verified SOUND:** RRF `1/(60+rank)` k=60 applied before boost/penalty
(correct order); time-range pushed into SQL on FTS+vector paths (Tier 1
top-200-filter bug genuinely fixed); graceful degradation; cosine edge
cases (both-empty→0, epsilon, snap at 1.0); boost math accurate (verified
1.0301/1.1041/1.2/1.3 at 1/10/100/1000); bumps only on returned notes;
`touch()` doesn't modify `updated_at` (reads don't un-stale — deliberate,
correct); consolidation honesty (0.95/0.99 labeled heuristic); janitor
auto-merge exact-equality gate; edge namespace isolation (creation + read
re-check + namespace-change wipe); `finalize()` uniform across modes
(except relevant, I-MEDIUM-1).

**Suggested evaluations:** (1) edge-threshold sweep on ~150–200 labeled
pairs; (2) search ablation on relevance gold set (nDCG@10/P@5 across
modes × boost × penalty); (3) feedback-loop simulation (500 sequential
searches, Gini of access counts); (4) staleness distractor test (penalty ×
access-count matrix); (5) `state_relevant` precision probe (count vs
bm25-weighted P@5).

---

### MCP/Protocol Specialist

**P-MEDIUM-1 — `memory_stats` returns note titles without the UNTRUSTED_BANNER**
`src/mcp-server-core.ts:551`. `mostAccessed` includes titles
(attacker-writable, injected pre-prompt). The repo's standing rule
(`security.ts`) requires the banner on every pre-prompt injection surface;
`memory_consolidation_candidates` complies; `memory_stats` and
`memory_rebuild_edges` (:738, counts-only, fine) use bare `textResult`.
**Fix:** return `untrustedResult(store.accessStats(namespaces))`.

**P-MEDIUM-2 — REST parity gap: no `/stats` or `/rebuild-edges` endpoints**
`src/api.ts` (537 lines, confirmed absent). Operators scripting the HTTP API
have no path to either. **Fix:** add both (`/stats` → read scope +
`readable()` gating; `/rebuild-edges` → admin + `ownNs` confinement,
`{error}` shapes consistent), or document as intentionally MCP+CLI-only in
`api.ts`/`SKILL.md`.

**P-LOW-1 — Inconsistent `denyIfUnder("read")`** on the four original read
tools (harmless today — scope floor is `read` — but defense-in-depth drift).
**Fix:** add for uniformity.

**P-LOW-2 — (consolidated as BLOCKER 4 above)**

**P-LOW-3 — CLI `rebuild-edges` ignores namespace resolution**
`src/cli.ts:459–490` rebuilds all namespaces; MCP tool confined to `ownNs`
under nsActive. **Fix:** `resolveStartupNamespace(process.cwd())` in CLI,
pass `namespace` when active.

**P-LOW-4 — `GET /notes/:id` has no `neighbors` equivalent.** **Fix:** accept
`?neighbors=true`, same 10-cap.

**P-LOW-5 — Tool description leaks internal API name** (`memory_stats`
mentions `staleCount`, a `Store` method). **Fix:** rephrase
model-actionable.

**P-LOW-6 — REST `/relevant` limit validation looser than MCP schema**
(floats floored, strings → 5; MCP requires `z.number().int()`).
**Fix:** 400 on non-integer.

**P-LOW-7 — No MCP-spec `annotations`** (`readOnlyHint` on stats/relevant;
`destructiveHint` on delete/consolidate/rebuild-edges; `idempotentHint` on
rebuild-edges).

**P-LOW-8 — Scope tests don't cover Tier 2 tools.** **Fix:** extend
`test/mcp-scope.test.ts` (read→stats/relevant/candidates allowed;
read/write→rebuild-edges/consolidate denied; neighbors under read).

**P-INFO — CLI runs with full local trust (no token).** Acceptable
(machine-owner boundary), but document one line in `SKILL.md`.

**Verified SOUND:** scope assignments (rebuild-edges=admin ✓, stats=read ✓,
relevant=read-floor+namespace gating); `memory_stats` namespace scoping
(`readable()`-set counting, no global leak); `state_relevant` schema
(OR-semantics + keywords-echo accurately described); `neighbors` design
(boolean, default false, depth 1, same-namespace SQL re-check, no cycle
risk); no scope escalation via composition; rebuild-edges schema/threshold
validation clean; transport wiring (per-request scope; stdio admin with
documented rationale; startup-resolved namespaces, no per-request drift);
REST `POST /relevant` (read scope, namespace gating mirrors `/search`,
`{keywords, results}` shape, consistent `{error}` shapes, uniform 404s);
namespace hygiene (model namespace stripped on writes under nsActive;
consolidate confined to `ownNs`).

---

### Systems Engineer

**Y-CRITICAL-1 — (consolidated as BLOCKER 1 above)**

**Y-HIGH-1 — (consolidated as BLOCKER 2 above; quantified +4–20ms per 20-result search, p50 ~2–4× Tier 1 baseline)**

**Y-MEDIUM-1 — Per-query overhead otherwise sound.** `isStale()` O(1) pure
JS; config read once/search; neighbor fetch single indexed query,
request-scoped. `bumpAccess` is the only write-path cost. No Tier-1-vs-Tier-2
latency benchmarks exist.

**Y-HIGH-2 — Janitor hazards: cross-process lock contention + startup stall.**
In-process: no contention (single connection); `consolidateNotes`
transactional with rev CAS — sound. **Hazard A [HIGH]:** CLI `rebuild-edges`
from 2nd process holds `BEGIN IMMEDIATE` for minutes–days → server writes
hit `busy_timeout` → `SQLITE_BUSY` to clients. **Hazard B [MEDIUM]:**
`start.ts:88–98` runs sync `findCandidates` before serving (~1–2s dead air
at 2000-note cap). **Fix:** cooperative janitor (`findCandidatesCooperative`
— byte-identical results); defer first pass with `setImmediate` after
serving; document "don't run CLI rebuild-edges while server is up" or make
CLI detect server lock and refuse.

**Y-LOW-1 — Memory footprint sound.** Edges disk-indexed, never materialized.
Transient: `rebuildEdges` SELECTs all notes into memory (~200MB at 100k).
`recomputeEdgesFor` per-create is O(namespace) CPU — document; fine at
target scale.

**Y-LOW-2 — Cold start sound.** Zero eager edge work; keywords stop-words are
a module constant. Only wart: Y-HIGH-2 Hazard B.

**Y-HIGH-3 — CLI `rebuild-edges`: no progress, not resumable, unsafe mid-mutation.**
No progress output (45-min rebuild looks hung); single txn → SIGINT loses all
work; notes created mid-rebuild get no edges (silent); notes deleted
mid-rebuild → FK abort → full rollback, zero progress kept. Threshold
validation is the one thing done right.
**Fix:** progress streaming; chunk txns with resume; re-verify existence
pre-insert (or `INSERT OR IGNORE` + verification pass); warn/refuse on
server lock.

**Verified SOUND:** namespace isolation in edge graph (creation + read
re-check + rebuild grouping — defense-in-depth real); consolidation
atomicity with rev CAS; auto-merge gate (exact title+body equality); `touch()`
never corrupts `updated_at`; scoring additions O(1)/O(n log n ≤ 200);
neighbor lookup indexed + bounded; keyword extraction no init cost; CLI
rebuild crash-safe (rollback); MCP threshold validation clean.

**Suggested benchmarks:** (1) rebuild wall-clock vs n (1k/2k/5k/10k);
(2) read-path latency A/B (touch on/off at 20/50/100 rps); (3) FTS trigger
cost isolation (before/after trigger narrowing); (4) in-memory touch-buffer
prototype; (5) janitor boot stall timing; (6) cross-process contention
(server + CLI rebuild concurrently); (7) heap snapshot during rebuild.

---

## Recommended fix order

1. **Blockers 1–4** (rebuild-edges redesign; FTS trigger gating + touch off
   response path; touch best-effort + scoring outside txn; auth-gate before
   touch). These are correctness/availability — everything else is tuning.
2. **D-HIGH-2, D-HIGH-3** (create() savepoints; import skipEdges + terminal
   rebuild). Data-integrity adjacent to the blockers.
3. **I-HIGH-1, I-HIGH-2** (TF-IDF edges + threshold sweep; recency-aware
   boost). These change ranking behavior — do before any evaluation baseline
   is cut.
4. **P-MEDIUM-1, P-MEDIUM-2** (stats banner; REST parity decision). Cheap,
   security-relevant.
5. **Y-HIGH-2, Y-HIGH-3, D-MEDIUM-1, D-MEDIUM-2** (janitor cooperation;
   CLI rebuild UX; neighbor index; tokenize-once). Performance hardening.
6. **I-MEDIUM-1…4, S-LOW-1…3, P-LOW-1…8** (relevant-pipeline parity; hashtag
   dedupe; stop-words; uniform errors; annotations; scope tests). Polish.
7. **D-MEDIUM-4, I-LOW-1, I-LOW-2, D-LOW-1** (threshold persistence;
   neighbor staleness flags; fan-out fairness; access_count index). Deferred
   to the hardening pass.

## What cleared the panel

Across all five experts, the following were verified sound with no action
needed: migration idempotency and sequential upgrade machinery; edge-table
design (PK, bidirectional storage, FK cascades, no self-edges);
stale-edge invalidation on UPDATE; neighbor fetching (not N+1, indexed,
bounded, depth-1); rebuild atomicity (rollback to old set); FTS5 trigger
*correctness*; consolidation atomicity with rev CAS; auto-merge exact-equality
gate; RRF ordering; time-range SQL pushdown; graceful degradation paths;
cosine edge cases; scope assignments on all new tools; `memory_stats`
namespace scoping; `state_relevant` schema accuracy; transport wiring;
REST `POST /relevant` parity; namespace hygiene on write paths; uniform
denial errors; consolidation write isolation; `/export`/`/import` scoping.

## Method note

Each expert read the Tier 2 source in full. The security engineer ran two
adversarial probes end-to-end (read-scoped `agent-a` token attacking
`agent-b`'s namespace): three issues confirmed empirically (cross-namespace
touch pollution with access_count 0→50; missing-vs-foreign id distinction in
consolidate errors; zero cross-namespace data exfiltration through any tool).
The IR engineer ran measurement probes (cosine sensitivity pairs, boost
arithmetic verification, FTS5 `#` handling). No expert re-ran the 400-test
suite; the green claim is the implementers', not the panel's.
