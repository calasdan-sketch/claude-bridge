// MCP server over HTTP/SSE (the Streamable HTTP transport from the MCP
// spec), for the remote tunnel that reaches your phone/web. Runs stateless
// (no session id) -- one Store shared across all requests, a fresh
// McpServer+transport pair per request (the pattern the SDK docs use for
// stateless HTTP), so there is no per-session memory to leak or expire.
//
// Auth: same bearer token as the REST API, checked in front of the MCP
// transport on every request.
//
// This module exports a factory (createMcpHttpServer) so the combined
// `start` command can run it alongside the REST API sharing ONE Store.
// It also runs standalone when invoked directly (node dist/src/mcp-http.js).

import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Store } from "./store.js";
import { createMcpServer } from "./mcp-server-core.js";
import { originAllowed, RateLimiter, clientKey, bearerMatches } from "./security.js";

const MAX_BODY_BYTES = 1_000_000; // 1MB cap so a bad client can't OOM the process

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

/**
 * Build the MCP-over-HTTP server around an existing Store. Does not listen --
 * the caller decides host/port. The same `store` can be shared with the REST
 * API so both transports read and write one SQLite file in one process.
 */
export function createMcpHttpServer(store: Store, token: string): Server {
  const limiter = new RateLimiter();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

    if (!bearerMatches(req, token)) {
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
        // Runs in an event callback outside the try/catch below; a throw here
        // (e.g. client vanished mid-connect) would be an uncaught exception.
        try {
          transport.close();
          server.close();
        } catch {
          /* already closing / not fully connected -- nothing to do */
        }
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
}

// --- standalone entry (node dist/src/mcp-http.js) ---------------------------
async function runStandalone(): Promise<void> {
  const { DB_PATH, MCP_HTTP_PORT, BIND_HOST, resolveToken, assertSafeExposure } = await import(
    "./config.js"
  );
  assertSafeExposure();
  const token = resolveToken();
  const store = new Store(DB_PATH);
  const httpServer = createMcpHttpServer(store, token);

  httpServer.listen(MCP_HTTP_PORT, BIND_HOST, () => {
    console.error(
      `[claude-bridge] MCP HTTP/SSE server listening on http://${BIND_HOST}:${MCP_HTTP_PORT}/mcp`
    );
  });

  const shutdown = (): void => {
    httpServer.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only boot on its own when run directly, not when imported by start.ts.
// Compare real (symlink-resolved) paths, case-insensitively on Windows, so a
// drive-letter-case or bin-shim difference doesn't make the standalone entry
// silently fail to start.
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    const norm = (p: string): string => {
      let r: string;
      try {
        r = realpathSync(p);
      } catch {
        r = resolve(p);
      }
      return process.platform === "win32" ? r.toLowerCase() : r;
    };
    return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  void runStandalone();
}
