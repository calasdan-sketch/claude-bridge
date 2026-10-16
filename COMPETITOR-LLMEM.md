# llmem (netrixone/llmem) — Competitive Feature Analysis

**Basics:** v1.4.1 · Go 1.24 · MIT · ~10k lines Go · single binary · SQLite · MCP over Streamable HTTP + REST on :9980. No auth — localhost-only.

## Gap analysis vs OneMemory (ranked by implementability + value)

1. **Auto-consolidation / dedup** — near-duplicate detection (0.95 default) with dry-run preview, type filters, caps, scheduled runs. Attacks memory bloat.
2. **Similarity edge graph** — every memory carries neighbor edges (BM25 doc-doc similarity > 0.35); `memory_get` returns neighbors. Navigable knowledge graph.
3. **Access tracking → importance weighting** — `access_count` + `last_accessed` per memory, bumped on read. "Hot memories rank higher."
4. **Staleness detection** — 30-day `#status` expiry with `stale` flag + warning text telling agent to verify.
5. **Temporal decay in ranking** — configurable half-life; fresher memories win ties.
6. **Session protocol (context/relevant split)** — `memory_context` for startup restore + `memory_relevant` (permissive threshold) for mid-conversation. A designed agent loop.
7. **Keyword extraction from natural language** — strips conversational stop-words, keeps hashtags, feeds lower-threshold search.
8. **Project scopes with global fallback** — `scopes[]` per memory; empty = matches every query.
9. **Lossless import** — preserves original IDs + timestamps on re-import (`skipExisting`).
10. **BM25 lexical retrieval** — k1=1.2, b=0.75, Porter stemmer, WordNet synonym expansion (0.3 weight), hashtags preserved unstemmed. Zero-cost, offline, deterministic.

## Retrieval details
- BM25: k1=1.2, b=0.75; IDF clamped ≥ 0
- Tokenization: lowercase → stop-word removal → punctuation strip → Porter stem → drop <2 chars → hashtags preserved
- Doc-doc similarity: symmetric max(BM25(a→b), BM25(b→a)), normalized to [0,1)
- Measured: stemming MRR 0.56→0.61, R@3 0.56→0.62

## The 15 MCP tools
memory_add, memory_get, memory_search, memory_relevant, memory_context, memory_update, memory_delete, memory_list, memory_stats, memory_export, memory_import, memory_consolidation_candidates, memory_consolidate, memory_auto_consolidate, memory_rebuild_edges

## OneMemory moats
llmem has no auth, no injection defense, no dashboard/UI, no version history (only updated_at), no Docker packaging.
