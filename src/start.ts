// Combined entry: boots BOTH transports in one process, sharing ONE Store.
//   - REST API + dashboard on API_PORT        (default 8790)
//   - MCP over HTTP (the tunnel target)        default 8791 on MCP_HTTP_PORT
//
// One Store means one SQLite connection (WAL + busy_timeout) does all the
// writing, so the two transports never race each other on the same file.
// This is what `onememory start` and `npm start` run, and what the
// Docker image launches -- so a self-hoster who tunnels port 8791 actually
// has an MCP endpoint there, not a dead port.

import { Store } from "./store.js";
import { createApiServer } from "./api.js";
import { createMcpHttpServer } from "./mcp-http.js";
import {
  DB_PATH,
  API_PORT,
  MCP_HTTP_PORT,
  BIND_HOST,
  resolveTokens,
  assertSafeExposure,
  AUTO_CONSOLIDATE_INTERVAL_MS,
} from "./config.js";
import { findCandidates, consolidateNotes } from "./consolidate.js";

assertSafeExposure();
const tokens = resolveTokens();
const store = new Store(DB_PATH);

/**
 * Background auto-consolidation (opt-in via ONEMEMORY_AUTO_CONSOLIDATE_INTERVAL).
 * Conservative by design: only pairs scoring >= 0.99 (near-identical notes)
 * are merged automatically; weaker candidates are LOGGED for human review
 * via memory_consolidation_candidates, never merged blindly. Never throws —
 * a background janitor must not take down the server.
 */
const AUTO_MERGE_SCORE = 0.99;

function runAutoConsolidation(): void {
  try {
    const candidates = findCandidates(store.exportAll(), {
      threshold: 0.95,
      limit: 200,
    });
    if (candidates.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[onememory] auto-consolidate: ${candidates.length} duplicate candidate pair(s) ` +
          `>= 0.95 — review with memory_consolidation_candidates`
      );
    }
    const consumed = new Set<number>();
    let merged = 0;
    for (const c of candidates) {
      if (c.score < AUTO_MERGE_SCORE) continue;
      if (consumed.has(c.idA) || consumed.has(c.idB)) continue;
      try {
        const note = consolidateNotes(store, [c.idA, c.idB], { deleteSources: true });
        consumed.add(c.idA);
        consumed.add(c.idB);
        merged += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[onememory] auto-consolidate: merged #${c.idA}+#${c.idB} -> #${note.id}`
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `[onememory] auto-consolidate: skipped pair #${c.idA}/#${c.idB}: ` +
            (e as Error).message
        );
      }
    }
    if (merged > 0) {
      // eslint-disable-next-line no-console
      console.error(`[onememory] auto-consolidate: ${merged} merge(s) done`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[onememory] auto-consolidate failed: ${(e as Error).message}`);
  }
}

const apiServer = createApiServer(store, tokens);
const mcpServer = createMcpHttpServer(store, tokens);

apiServer.listen(API_PORT, BIND_HOST, () => {
  console.error(`[onememory] API + dashboard on http://${BIND_HOST}:${API_PORT}`);
  console.error(`[onememory] DB: ${DB_PATH}`);
});

mcpServer.listen(MCP_HTTP_PORT, BIND_HOST, () => {
  console.error(
    `[onememory] MCP over HTTP on http://${BIND_HOST}:${MCP_HTTP_PORT}/mcp (tunnel this)`
  );
});

if (AUTO_CONSOLIDATE_INTERVAL_MS && AUTO_CONSOLIDATE_INTERVAL_MS > 0) {
  console.error(
    `[onememory] auto-consolidation every ${AUTO_CONSOLIDATE_INTERVAL_MS}ms ` +
      `(auto-merge >= ${AUTO_MERGE_SCORE}; weaker candidates are only logged)`
  );
  runAutoConsolidation();
  const timer = setInterval(runAutoConsolidation, AUTO_CONSOLIDATE_INTERVAL_MS);
  timer.unref(); // never keep the process alive on the scheduler's account
}

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  let pending = 2;
  const done = (): void => {
    pending -= 1;
    if (pending === 0) {
      store.close();
      process.exit(0);
    }
  };
  apiServer.close(done);
  mcpServer.close(done);
  // Safety net: don't hang forever if a socket won't drain.
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
