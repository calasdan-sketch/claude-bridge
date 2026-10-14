#!/usr/bin/env node
// claude-bridge CLI: one command to run, check, or wire up the bridge.
//   claude-bridge [start]   start the HTTP API + dashboard (default)
//   claude-bridge mcp       start the MCP server over stdio (for Claude Code/Cursor/...)
//   claude-bridge doctor    check Node, database, and token
//   claude-bridge init      print the config snippet to wire it into your agent
//   claude-bridge help      show help

function usage(): void {
  console.log(
    [
      "claude-bridge <command>",
      "",
      "  start     Start the HTTP API + dashboard (default)",
      "  mcp       Start the MCP server over stdio (Claude Code / Cursor / Copilot / ...)",
      "  doctor    Check Node version, database, and token",
      "  init      Print the config to wire it into your agent",
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
  console.log("claude-bridge doctor\n");

  const parts = process.versions.node.split(".").map(Number);
  if (parts[0] > 22 || (parts[0] === 22 && parts[1] >= 5)) {
    ok("Node " + process.versions.node);
  } else {
    warn("Node " + process.versions.node + " — need >= 22.5 (for the built-in SQLite)");
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
    ok("bearer token present (data/.token or CLAUDE_BRIDGE_TOKEN)");
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

  console.log("Wire claude-bridge into your agent (local, over stdio):\n");
  console.log("Claude Code:");
  console.log(`  claude mcp add claude-bridge -- node ${stdioPath}\n`);
  console.log("Claude Desktop / Cursor / Copilot — add to the MCP config:");
  console.log(
    JSON.stringify(
      { mcpServers: { "claude-bridge": { command: "node", args: [stdioPath] } } },
      null,
      2
    )
  );
  console.log("\nSee INSTALL.md for every client, and INFRA.md to reach your phone.");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || "start";
  switch (cmd) {
    case "start":
    case "serve":
      await import("./index.js");
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
