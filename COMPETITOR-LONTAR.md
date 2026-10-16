# lontar — Competitive Feature Analysis

**Source:** dev.to "One memory across AI agents: what it actually takes" by rymanalu
**Status:** Single-user local tool, Claude Code plugin. Repo private, planned AGPL-3.0.

## Gap analysis vs OneMemory

### Highest-leverage steals
1. **SessionStart hook script** (`onememory recall --budget-ms 800`) with fail-silent semantics; fires on startup/clear, not compact. Verify exact JSON output shape per platform.
2. **Resolve namespace server-side from process cwd at startup** (env override → longest path match → explicit default); treat model-supplied namespace as untrusted. Add overlap→error and `reads_from` directional grants.
3. **Bitemporal fact columns** (`valid_from/valid_to` + `recorded_at`) alongside existing revisions.
4. **`source=` agent tag on every write** (constant per client adapter).
5. **Render budget**: 8,000-char server-side cap, priority ordering, in-budget "N more… call recall" trailer.
6. **Evidence tags** (built/measured/found/documented/designed) on docs claims.

### Key mechanisms
- **Pre-prompt injection**: memory before first user message, no model opt-in needed. Measured 656–799ms, 800ms budget, 5s hard timeout, exit-0-on-any-failure.
- **Server-side space resolution**: No `space` parameter on tools (model-filled = injection vector). Resolved once at startup from cwd.
- **Character-budget engineering**: 10k char cap, priority ordering (workspace → unscoped → newest), truncation notice.
- **One-directional reads**: `reads_from` — A reads B, B never reads A; writes always local.

## OneMemory moats
Scoped tokens/auth, dashboard, backup/export, Docker one-liner, full CLI, hosted/multi-user story.
