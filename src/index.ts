// Entry point: boots the HTTP/JSON API on CLAUDE_BRIDGE_PORT (default 8790).
import { Store } from "./store.js";
import { createApiServer } from "./api.js";
import { DB_PATH, API_PORT, resolveToken } from "./config.js";

const token = resolveToken();
const store = new Store(DB_PATH);
const server = createApiServer(store, token);

server.listen(API_PORT, () => {
  // eslint-disable-next-line no-console
  console.error(`[claude-bridge] API listening on http://127.0.0.1:${API_PORT}`);
  // eslint-disable-next-line no-console
  console.error(`[claude-bridge] DB: ${DB_PATH}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
