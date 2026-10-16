# lossless-memory (aru-labs) — Competitive Feature Analysis

**Repo:** https://github.com/aru-labs/lossless-memory · **License:** MIT · **Stars:** ~137 · **Language:** Python
**Pitch:** "Never summarize, keep every line, put a timestamp on everything." Single-user, single-machine, no server, no cloud.

## Gap analysis — what lossless-memory does that OneMemory may NOT

1. **Natural-language time axis as the primary query interface.** Time-phrase parser ("yesterday evening, about the budget") → UTC range before ranking. Different retrieval shape from keyword/namespace search.

2. **LLL-style every-turn "where are we now" injection.** Cheap (<0.2s), real-time topic index injected every turn. Cross-session merge (identity-scoped, not session-scoped), rhythm-based chunking, mechanical headline extraction, time-bucket folding, charged-moment surfacing, human-only priority channel.

3. **Structural hallucination suppression.** "Narrow with fuzzy, verify with exact; assert nothing unverified; say unknown." Post-output self-check for fabricated user turns.

4. **Honest fallback ladder.** Each degraded result labeled with which layer produced it; low-confidence hits flagged.

5. **No-summarization invariant.** Raw log is sacred; indexes are disposable and rebuildable.

6. **Identity-scoped (not session-scoped) state.** New instance inherits previous instance's context via cross-session timeline merge.

7. **Memory/persona channel separation.** Facts and affective parameters via separate injection paths with failure isolation.

8. **Bigram FTS for non-segmented languages.** SQLite FTS5 bigram tokenizer for CJK queries.

9. **Charged-moment detection + human-only priority marks.** Decisions/promises always surfaced; priority settable only by human.

10. **Real-time blind-window elimination.** State layer reads raw log tail directly, bypassing periodic index gap.

## OneMemory moats (lossless-memory explicitly lacks these)
Scoped tokens/auth, multi-agent namespaces, dashboard, MCP packaging, marketplace distribution, backup/export.
