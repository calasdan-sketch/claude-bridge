#!/usr/bin/env node
// onememory CLI: one command to run, check, or wire up the bridge.
//   onememory [start]   start the API + dashboard AND MCP-over-HTTP (default)
//   onememory mcp       start the MCP server over stdio (for Claude Code/Cursor/...)
//   onememory doctor    check Node, database, and token
//   onememory init      print the config snippet to wire it into your agent
//   onememory help      show help

function usage(): void {
  console.log(
    [
      "onememory <command>",
      "",
      "  start     Start the API + dashboard AND MCP-over-HTTP (default)",
      "  mcp       Start the MCP server over stdio (Claude Code / Cursor / Copilot / ...)",
      "  doctor    Check Node version, database, and token",
      "  init      Print the config to wire it into your agent",
      "  reindex   Backfill semantic embeddings for notes missing them",
      "  recall    SessionStart hook: print recent memory as hook JSON (fail-silent)",
      "  consolidate [--dry-run] [--yes] [--threshold 0.95] [--namespace ns]",
      "            Find near-duplicate notes and merge them. Without --yes",
      "            (or with --dry-run) this only reports — nothing is merged.",
      "  help      Show this help",
      "",
    ].join("\n")
  );
}

async function doctor(): Promise<void> {
  const { DB_PATH, BIND_HOST, API_PORT, MCP_HTTP_PORT, resolveToken } = await import(
    "./config.js"
  );
  const { Store } = await import("./store.js");
  const ok = (m: string) => console.log("  [ok]   " + m);
  const warn = (m: string) => console.log("  [warn] " + m);
  console.log("onememory doctor\n");

  const parts = process.versions.node.split(".").map(Number);
  if (parts[0] >= 24) {
    ok("Node " + process.versions.node);
  } else {
    warn("Node " + process.versions.node + " — need >= 24 (for the built-in SQLite)");
  }

  try {
    const s = new Store(DB_PATH);
    const r = s.list({ limit: 1 });
    s.close();
    ok(`database OK at ${DB_PATH} (${r.total} notes)`);
  } catch (e) {
    warn("database problem: " + (e as Error).message);
  }

  try {
    resolveToken();
    ok("bearer token present (data/.token or ONEMEMORY_TOKEN)");
  } catch (e) {
    warn("token: " + (e as Error).message);
  }

  console.log(`\n  bind ${BIND_HOST}   api :${API_PORT}   mcp :${MCP_HTTP_PORT}`);
}

async function init(): Promise<void> {
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const stdioPath = join(here, "mcp-stdio.js");

  console.log("Wire onememory into your agent (local, over stdio):\n");
  console.log("Claude Code:");
  console.log(`  claude mcp add onememory -- node ${stdioPath}\n`);
  console.log("Claude Desktop / Cursor / Copilot — add to the MCP config:");
  console.log(
    JSON.stringify(
      { mcpServers: { "onememory": { command: "node", args: [stdioPath] } } },
      null,
      2
    )
  );
  console.log("\nSee INSTALL.md for every client, and INFRA.md to reach your phone.");
}

async function reindex(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { embeddingsEnabled, embeddingsConfig, embed, noteEmbeddingText } = await import(
    "./embeddings.js"
  );

  if (!embeddingsEnabled()) {
    console.error(
      "Embeddings are off. Set ONEMEMORY_EMBEDDINGS=on (and, if needed, " +
        "ONEMEMORY_EMBED_URL / ONEMEMORY_EMBED_MODEL) before reindexing."
    );
    return;
  }

  const cfg = embeddingsConfig();
  const store = new Store(DB_PATH);
  // `reindex all` recomputes every note's vector -- use it after changing the
  // embedding model or its dimension. Plain `reindex` only fills missing ones.
  const all = process.argv[3] === "all";
  const ids = all
    ? store.exportAll().map((n) => n.id)
    : store.noteIdsMissingVectors();
  console.error(
    `onememory reindex${all ? " all" : ""}: ${ids.length} note(s) to embed (model ${cfg.model}).`
  );

  let done = 0;
  let failed = 0;
  for (const id of ids) {
    const note = store.read(id);
    if (!note) continue;
    const vec = await embed(noteEmbeddingText(note.title, note.body), cfg);
    if (vec) {
      store.setVector(id, vec, cfg.model);
      done += 1;
    } else {
      failed += 1;
    }
  }
  store.close();
  console.error(
    `Done. Embedded ${done}, failed ${failed}. Total vectors now: see 'doctor'.`
  );
}

async function recall(): Promise<void> {
  // Claude Code SessionStart hook. FAIL-SILENT by design: always prints a
  // valid hook JSON payload and exits 0, whatever happens.
  const args = process.argv.slice(3);
  const flag = (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(name + "="));
    if (eq) return eq.slice(name.length + 1);
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const toNum = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const { runRecall } = await import("./recall.js");
  console.log(
    await runRecall({
      budgetMs: toNum(flag("--budget-ms"), 800),
      limit: toNum(flag("--limit"), 10),
    })
  );
  process.exit(0);
}

// Find near-duplicate notes and merge them. Safe by default: without --yes
// (or with --dry-run) this only reports candidates and previews merges —
// nothing is written. Pass --yes to actually merge.
async function consolidate(): Promise<void> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const {
    findCandidates,
    consolidateNotes,
    buildConsolidationPreview,
    groupCandidateIds,
    clampThreshold,
  } = await import("./consolidate.js");

  const args = process.argv.slice(3);
  let dryRun = false;
  let yes = false;
  let namespace: string | undefined;
  let thresholdRaw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--namespace" && i + 1 < args.length) namespace = args[++i];
    else if (a.startsWith("--namespace=")) namespace = a.slice("--namespace=".length);
    else if (a === "--threshold" && i + 1 < args.length) thresholdRaw = args[++i];
    else if (a.startsWith("--threshold=")) thresholdRaw = a.slice("--threshold=".length);
    else {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    }
  }
  const threshold = clampThreshold(
    thresholdRaw !== undefined ? Number(thresholdRaw) : undefined,
    0.95
  );

  const store = new Store(DB_PATH);
  try {
    const notes = store
      .exportAll()
      .filter((n) => !namespace || n.namespace === namespace);
    const candidates = findCandidates(notes, { threshold });
    if (candidates.length === 0) {
      console.log("No duplicate candidates found.");
      return;
    }
    const byId = new Map(notes.map((n) => [n.id, n]));
    console.log(
      `Found ${candidates.length} duplicate candidate pair(s) (threshold ${threshold}):`
    );
    for (const c of candidates) {
      console.log(
        `  #${c.idA} "${byId.get(c.idA)?.title}" <-> #${c.idB} "${byId.get(c.idB)?.title}" ` +
          `(score ${c.score.toFixed(3)})`
      );
    }

    // Connected components: an A-B, B-C chain merges as one group so the
    // second pair never trips over the first pair's deleted note.
    const groups = groupCandidateIds(candidates);

    if (dryRun) {
      for (const g of groups) {
        const gnotes = g.map((id) => byId.get(id)!).filter(Boolean);
        const p = buildConsolidationPreview(gnotes);
        console.log(
          `\nWould merge [${g.join(", ")}] -> title "${p.title}" ` +
            `(${p.tags.length} tag(s), body ${p.body.length} chars)`
        );
      }
      return;
    }
    if (!yes) {
      console.log("\nRe-run with --yes to merge these, or --dry-run for a merge preview.");
      return;
    }

    let mergedCount = 0;
    for (const g of groups) {
      try {
        const merged = consolidateNotes(store, g, { deleteSources: true });
        console.log(`Merged [${g.join(", ")}] -> #${merged.id} "${merged.title}"`);
        mergedCount += 1;
      } catch (e) {
        console.error(`Skipped [${g.join(", ")}]: ${(e as Error).message}`);
      }
    }
    console.log(`Done: ${mergedCount} merge(s).`);
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || "start";
  switch (cmd) {
    case "start":
    case "serve":
      await import("./start.js");
      break;
    case "mcp":
    case "mcp:stdio":
      await import("./mcp-stdio.js");
      break;
    case "doctor":
      await doctor();
      break;
    case "init":
      await init();
      break;
    case "reindex":
      await reindex();
      break;
    case "recall":
      await recall();
      break;
    case "consolidate":
      await consolidate();
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
