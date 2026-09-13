// Minimal JSON/HTTP API over the shared Store. Deliberately built on plain
// node:http rather than a framework (Express etc.) -- five endpoints don't
// need a router library, and every extra dependency is extra attack
// surface for a service that's about to be exposed over a public tunnel.
//
// Auth: single bearer token, checked on every route except /health.
// Format: `Authorization: Bearer <token>`.

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { Store, NoteInput, NotePatch } from "./store.js";

const MAX_BODY_BYTES = 1_000_000; // 1MB cap so a bad client can't OOM the process

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  // Constant-time-ish comparison isn't critical here (token is high-entropy,
  // local service) but cheap to do right.
  const provided = match[1];
  if (provided.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= provided.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

export function createApiServer(store: Store, token: string): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // Health check is intentionally unauthenticated so infra (tunnel,
      // uptime monitor) can probe liveness without a credential.
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      // POST /notes
      if (req.method === "POST" && path === "/notes") {
        const raw = await readBody(req);
        let parsed: NoteInput;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!parsed.title || typeof parsed.title !== "string") {
          sendJson(res, 400, { error: "title is required" });
          return;
        }
        try {
          const note = store.create(parsed);
          sendJson(res, 201, { note });
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
        }
        return;
      }

      // GET /notes/:id
      const idMatch = /^\/notes\/(\d+)$/.exec(path);
      if (req.method === "GET" && idMatch) {
        const id = Number(idMatch[1]);
        const note = store.read(id);
        if (!note) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendJson(res, 200, { note });
        return;
      }

      // PUT /notes/:id
      if (req.method === "PUT" && idMatch) {
        const id = Number(idMatch[1]);
        const raw = await readBody(req);
        let parsed: NotePatch;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        try {
          const note = store.update(id, parsed);
          if (!note) {
            sendJson(res, 404, { error: "not found" });
            return;
          }
          sendJson(res, 200, { note });
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
        }
        return;
      }

      // GET /notes?namespace=&limit=&offset=
      if (req.method === "GET" && path === "/notes") {
        const namespace = url.searchParams.get("namespace") ?? undefined;
        const limit = url.searchParams.get("limit");
        const offset = url.searchParams.get("offset");
        const result = store.list({
          namespace,
          limit: limit ? Number(limit) : undefined,
          offset: offset ? Number(offset) : undefined,
        });
        sendJson(res, 200, result);
        return;
      }

      // GET /search?q=&namespace=&limit=
      if (req.method === "GET" && path === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const namespace = url.searchParams.get("namespace") ?? undefined;
        const limit = url.searchParams.get("limit");
        if (!q.trim()) {
          sendJson(res, 400, { error: "q is required" });
          return;
        }
        const results = store.search(q, {
          namespace,
          limit: limit ? Number(limit) : undefined,
        });
        sendJson(res, 200, { results });
        return;
      }

      sendJson(res, 404, { error: "no such route" });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  });
}
