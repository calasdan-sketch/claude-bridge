// Combined entry: boots BOTH transports in one process, sharing ONE Store.
//   - REST API + dashboard on API_PORT        (default 8790)
//   - MCP over HTTP (the tunnel target)        default 8791 on MCP_HTTP_PORT
//
// One Store means one SQLite connection (WAL + busy_timeout) does all the
// writing, so the two transports never race each other on the same file.
// This is what `claude-bridge start` and `npm start` run, and what the
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
  resolveToken,
  assertSafeExposure,
} from "./config.js";

assertSafeExposure();
const token = resolveToken();
const store = new Store(DB_PATH);

const apiServer = createApiServer(store, token);
const mcpServer = createMcpHttpServer(store, token);

apiServer.listen(API_PORT, BIND_HOST, () => {
  console.error(`[claude-bridge] API + dashboard on http://${BIND_HOST}:${API_PORT}`);
  console.error(`[claude-bridge] DB: ${DB_PATH}`);
});

mcpServer.listen(MCP_HTTP_PORT, BIND_HOST, () => {
  console.error(
    `[claude-bridge] MCP over HTTP on http://${BIND_HOST}:${MCP_HTTP_PORT}/mcp (tunnel this)`
  );
});

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
