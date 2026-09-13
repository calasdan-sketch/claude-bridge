// MCP server over stdio, for local Claude Code / Claude Desktop config.
// Points at the same SQLite file the HTTP API uses (CLAUDE_BRIDGE_DB_PATH
// or the default data/state.db) so state written here is immediately
// visible to the API and vice versa.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./store.js";
import { createMcpServer } from "./mcp-server-core.js";
import { DB_PATH } from "./config.js";

const store = new Store(DB_PATH);
const server = createMcpServer(store);
const transport = new StdioServerTransport();

await server.connect(transport);

// eslint-disable-next-line no-console
console.error(`[claude-bridge] MCP stdio server connected. DB: ${DB_PATH}`);

function shutdown(): void {
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
