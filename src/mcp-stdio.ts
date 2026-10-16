// MCP server over stdio, for local Claude Code / Claude Desktop config.
// Points at the same SQLite file the HTTP API uses (ONEMEMORY_DB_PATH
// or the default <data dir>/state.db, see config.ts) so state written here is immediately
// visible to the API and vice versa.
import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./store.js";
import { createMcpServer } from "./mcp-server-core.js";
import { DB_PATH, prepareDataDir } from "./config.js";
import { resolveStartupNamespace } from "./namespace.js";

prepareDataDir();
const store = new Store(DB_PATH);
// Server-side namespace resolution: resolved ONCE at startup from the
// process working directory. Null when unconfigured (legacy behavior).
const nsOpts = resolveStartupNamespace(process.cwd());
const server = createMcpServer(store, "admin", nsOpts ?? undefined);
const transport = new StdioServerTransport();

await server.connect(transport);

// eslint-disable-next-line no-console
console.error(`[onememory] MCP stdio server connected. DB: ${DB_PATH}`);
if (nsOpts) {
  // eslint-disable-next-line no-console
  console.error(`[onememory] namespace resolution ACTIVE: namespace="${nsOpts.namespace}"`);
}

function shutdown(): void {
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
