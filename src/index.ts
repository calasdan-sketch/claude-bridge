// Entry point: boots the HTTP/JSON API on ONEMEMORY_PORT (default 8790).
import { Store } from "./store.js";
import { createApiServer } from "./api.js";
import { DB_PATH, API_PORT, BIND_HOST, resolveTokens, assertSafeExposure } from "./config.js";

assertSafeExposure();
const tokens = resolveTokens();
const store = new Store(DB_PATH);
const server = createApiServer(store, tokens);

server.listen(API_PORT, BIND_HOST, () => {
  // eslint-disable-next-line no-console
  console.error(`[onememory] API listening on http://${BIND_HOST}:${API_PORT}`);
  // eslint-disable-next-line no-console
  console.error(`[onememory] DB: ${DB_PATH}`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
