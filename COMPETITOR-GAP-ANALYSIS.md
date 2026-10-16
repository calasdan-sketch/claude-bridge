# OneMemory — Consolidated Competitor Gap Analysis

**Date:** 2026-10-16
**Sources:** lontar (dev.to), llmem v1.4.1 (netrixone), lossless-memory (aru-labs)

## OneMemory baseline (verified in repo)
- 5 MCP tools: state_write, state_read, state_search, state_list, state_delete
- SQLite + FTS5 keyword search; optional semantic (Ollama embeddings); hybrid RRF
- Scoped tokens (read/write/admin), namespaces (model-supplied param)
- Injection-on-read guard, Docker, CLI, dashboard, backup/export, revisions

## Tier 1 — Build now (highest leverage)

### 1. SessionStart hook (from lontar)
Pre-prompt memory injection. New CLI: `onememory recall --budget-ms 800`.
- Fail-silent: exit 0 on any failure (DB down, timeout, no config)
- Fires on startup/clear, NOT on compact
- 800ms budget, 5s hard timeout
- Verify exact JSON output shape per platform (Claude Code needs nested `hookSpecificOutput`)

### 2. Server-side namespace resolution (from lontar)
Close the prompt-injection vector: model-supplied `namespace` param is arguable by any text in context.
- Resolve once at startup from process cwd: `ONEMEMORY_SPACE` env → longest path match → explicit default
- Config maps directories → namespaces; overlap = hard error
- `reads_from`: one-directional grants (A reads B, B never reads A; writes always local)
- Treat any model-supplied namespace as untrusted hint or drop param on writes

### 3. Time-phrase query parser (from lossless-memory)
Natural-language time axis: "yesterday evening about the budget" → UTC range → restrict search.
- Parse: yesterday, today, N days ago, last week/month, "in July", morning/evening/night, clock times
- Day boundaries in user's IANA timezone; stored timestamps stay UTC
- Time + keywords: time scopes range, keywords rank within it

### 4. Auto-consolidation / dedup (from llmem)
Fight memory bloat from agents re-storing the same facts.
- Near-duplicate detection (0.95 similarity threshold) with dry-run preview
- `memory_consolidation_candidates` (read-only) + `memory_consolidate` (merge)
- Scheduled runs via env var; type filters; caps

## Tier 2 — Next round
5. Similarity edge graph (llmem) — BM25 doc-doc on write, neighbor edges, return on read
6. Access tracking (llmem) — access_count + last_accessed, importance weighting
7. Staleness detection (llmem) — time-based expiry flags with warnings
8. Keyword extraction (llmem) — `memory_relevant`: extract keywords from conversational text

## Tier 3 — Later
9. Bitemporal columns (lontar) — valid_from/valid_to + recorded_at
10. LLL "where are we now" (lossless-memory) — cheap topic markers every turn
11. Structural hallucination suppression (lossless-memory) — narrow fuzzy, verify exact
12. Per-agent source tagging (lontar) — source= on every write
13. Render budget (lontar) — 8k cap, priority ordering, truncation notice
14. Temporal decay (llmem) — half-life ranking
15. Honest fallback ladder (lossless-memory) — label degraded results

## OneMemory moats (competitors lack these — keep pressing)
Scoped tokens/auth, injection-on-read guard, dashboard, Docker one-liner, full CLI,
backup/export, revisions, MCP packaging, marketplace distribution.
