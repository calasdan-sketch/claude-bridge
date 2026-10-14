// MCP server over HTTP/SSE (the Streamable HTTP transport from the MCP
// spec), for the remote tunnel a separate agent is wiring up. Runs
// stateless (no session id) -- one Store shared across all requests, a
// fresh McpServer+transport pair per request (the pattern the SDK docs use
// for stateless HTTP), so there is no per-session memory to leak or expire.
//
// Auth: same bearer token as the REST API, checked in front of the MCP
// transport on every request.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Store } from "./store.js";
import { createMcpServer } from "./mcp-server-core.js";
import { DB_PATH, MCP_HTTP_PORT, BIND_HOST, resolveToken, assertSafeExposure } from "./config.js";
import { originAllowed, RateLimiter, clientKey } from "./security.js";

assertSafeExposure();
const token = resolveToken();
const store = new Store(DB_PATH);
const limiter = new RateLimiter();

const MAX_BODY_BYTES = 1_000_000; // 1MB cap so a bad client can't OOM the process

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const provided = match[1];
  if (provided.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= provided.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let data = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      data += decoder.write(chunk);
    });
    req.on("end", () => {
      data += decoder.end();
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (!originAllowed(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "origin not allowed" }));
    return;
  }
  if (!limiter.check(clientKey(req))) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "rate limit exceeded" }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no such route" }));
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  try {
    let parsedBody: unknown;
    if (req.method === "POST") {
      parsedBody = await readJsonBody(req);
    }

    // Stateless: fresh server + transport per request, same underlying Store.
    const server = createMcpServer(store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (e) {
    console.error("[claude-bridge] mcp error:", (e as Error).message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

httpServer.listen(MCP_HTTP_PORT, BIND_HOST, () => {
  // eslint-disable-next-line no-console
  console.error(
    `[claude-bridge] MCP HTTP/SSE server listening on http://${BIND_HOST}:${MCP_HTTP_PORT}/mcp`
  );
});

function shutdown(): void {
  httpServer.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
