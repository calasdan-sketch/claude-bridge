# claude-bridge

**One memory for every AI agent — free, self-hosted, and on every device.**

Write a note from Claude Code on your desktop, and read it back from Claude
on your phone — in a brand-new conversation, seconds later. Same store for
Claude Code, Claude Desktop, claude.ai web, Claude mobile, and any
MCP-capable editor (Cursor, Copilot, Cline, Continue, …).

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D22.5-green)
![Tests](https://img.shields.io/badge/tests-73%2F73-brightgreen)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-2-brightgreen)
![Native modules](https://img.shields.io/badge/native%20modules-0-brightgreen)

---

## The gap it fills

Agent-memory tools split into two camps:

- **Free & local-only** — they connect the agents running *on your machine*
  to a store *on your machine*. Great, but they physically can't reach your
  phone or claude.ai web.
- **Hosted & commercial** — they reach everywhere, but your notes live on a
  vendor's servers and you pay a subscription.

**claude-bridge sits in the empty third spot: free, self-hosted, *and*
reaches your phone/web.** Your notes stay in one SQLite file on your box;
the tunnel is just the pipe the remote surfaces read through. That gap is
the whole product.

### How it compares

| | claude-bridge | Local-only OSS tools | Hosted memory services |
|---|:---:|:---:|:---:|
| Free & open source (MIT) | ✅ | ✅ | partial / no |
| Self-hosted, your data on your box | ✅ | ✅ | no (vendor cloud) |
| Reaches phone **and** claude.ai web | ✅ | ❌ | ✅ |
| No vendor account required | ✅ | ✅ | ❌ |
| No native modules / no vector DB to run | ✅ | varies | n/a |
| Works with any MCP client *and* a plain HTTP API | ✅ | MCP only | varies |
| Semantic (meaning-based) search | ✅ optional, local embeddings | varies | ✅ |

*Capability comparison, not a price sheet — features and pricing of the
other tools change, so check each vendor's own site for current details.
The row that matters: nobody else is free **and** self-hosted **and**
reaches your phone.*

---

## 60-second quickstart

### Option A — Docker (recommended for the always-on / phone setup)

```bash
cp .env.example .env            # then edit .env and set a strong token
#   generate one:  openssl rand -hex 32
docker compose up -d
```

That starts the bridge with your notes on a named Docker volume. Open the
dashboard at **http://localhost:8790**, paste your token, and you're in.
To reach your phone/web, point an authenticated tunnel at port **8791**
(see [INFRA.md](./INFRA.md)).

### Option B — from source (local-only, no Docker)

Requires Node.js **>= 22.5** (for the built-in `node:sqlite`).

```bash
npm install
npm run build
npm start        # API + dashboard on :8790 AND MCP-over-HTTP on :8791
```

Then wire it into your local agents — this prints the exact config:

```bash
node dist/src/cli.js init
```

`node dist/src/cli.js doctor` checks your Node version, database, and token.
See [INSTALL.md](./INSTALL.md) for copy-paste snippets for Claude Code,
Claude Desktop, Cursor, Copilot, Windsurf, Cline, and Continue.

---

## The demo (what it actually feels like)

1. In **Claude Code**: *"remember that we're deploying on Fly.io, not
   Render."* → it calls `state_write`.
2. Later, on your **phone**, in a fresh chat: *"where are we deploying?"* →
   Claude answers "Fly.io" from the same note.
3. Open **Cursor** the next morning and it has the same context.

Three surfaces, one memory — the thing the local-only tools can't do.

---

## Architecture

```mermaid
flowchart LR
  subgraph local["Your machine"]
    CC[Claude Code]
    CD[Claude Desktop]
    IDE[Cursor / Copilot / Cline]
  end
  subgraph bridge["claude-bridge — one Node process"]
    STDIO[MCP over stdio]
    HTTP[MCP over HTTP : 8791]
    API[REST API + dashboard : 8790]
    STORE[(SQLite + FTS5 — state.db)]
  end
  subgraph remote["Away from your desk"]
    WEB[claude.ai web]
    PHONE[Claude mobile]
  end
  CC --> STDIO
  CD --> STDIO
  IDE --> STDIO
  STDIO --> STORE
  API --> STORE
  HTTP --> STORE
  WEB -. HTTPS tunnel + bearer .-> HTTP
  PHONE -. HTTPS tunnel + bearer .-> HTTP
```

One store, reached three ways — all pointing at the same
`CLAUDE_BRIDGE_DB_PATH`, so a note written through any one of them is
immediately visible through the others:

- **`src/store.ts`** — the shared state layer. SQLite via Node's built-in
  `node:sqlite` (no native module to compile), with an FTS5 index kept in
  sync by triggers so search never goes stale after a write. Notes carry a
  `rev` for compare-and-swap, a provenance `source`, tags, and namespaces.
- **`src/api.ts`** — a small HTTP/JSON API + a built-in web dashboard, on
  plain `node:http` (no framework).
- **`src/mcp-server-core.ts`** — the transport-agnostic MCP server with five
  tools, shared by both MCP transports.
- **`src/mcp-stdio.ts`** — stdio entry point for local Claude Code / Desktop
  / editors.
- **`src/mcp-http.ts`** — the MCP-over-HTTP (Streamable HTTP) endpoint the
  tunnel points at. Stateless: one shared store, a fresh server + transport
  per request.
- **`src/start.ts`** — boots the API/dashboard **and** the MCP-over-HTTP
  endpoint in one process on a single store (what `npm start`, the CLI, and
  Docker run).

### Tools (MCP)

`state_write` · `state_read` · `state_search` · `state_list` ·
`state_delete`. `state_write` takes an optional `if_rev` for safe
compare-and-swap updates and a `source` for provenance.

### HTTP API

`POST /notes` · `GET /notes/:id` · `PUT /notes/:id` · `DELETE /notes/:id` ·
`GET /notes` · `GET /search` · `GET /export` · `POST /import`, plus an open
`GET /health` and the dashboard at `/`. Every route except `/health` and the
dashboard requires `Authorization: Bearer <token>`.

This plain REST API is also how non-agent tools plug in. **n8n**, for
example, can read and write the store via an HTTP Request node (or its MCP
Client node) — see [INFRA.md](./INFRA.md) § "Use with n8n".

---

## Semantic search (optional)

Keyword (FTS5) search is the default and needs nothing extra. Turn on
meaning-based search and the bridge will also embed each note so a query like
*"canine companion"* finds a note about your dog that shares no words with it:

```bash
export CLAUDE_BRIDGE_EMBEDDINGS=on
export CLAUDE_BRIDGE_EMBED_URL=http://localhost:11434/v1/embeddings  # Ollama default
export CLAUDE_BRIDGE_EMBED_MODEL=nomic-embed-text
node dist/src/cli.js reindex   # backfill embeddings for existing notes
```

Embeddings come from **your own** OpenAI-compatible endpoint (local Ollama,
or any OpenAI-shaped `/v1/embeddings` API) — still zero native modules, still
nothing sent to a third party you didn't configure. `state_search` /
`GET /search` then accept `mode=keyword | semantic | hybrid` (hybrid fuses
both with Reciprocal Rank Fusion). If the endpoint is unavailable, search and
writes silently fall back to keyword — an optional embedder can never fail a
write or a query.

---

## Security

This can be exposed to the internet, so security is designed in, not bolted
on. **Your notes never leave your machine — the tunnel only carries
requests.**

- **Loopback by default, fail-closed.** Binds `127.0.0.1` unless you set
  `CLAUDE_BRIDGE_BIND`; it refuses to bind a public interface unless you've
  deliberately set `CLAUDE_BRIDGE_TOKEN` (no silent auto-token on a public
  port).
- **Bearer-token auth** on every route (constant-time compare; the token is
  never logged — only the path it's saved to).
- **Origin validation** to block DNS-rebinding from a malicious web page.
- **Per-client rate limiting.** Behind Cloudflare it keys on
  `cf-connecting-ip`; it trusts `x-forwarded-for` only if you opt in with
  `CLAUDE_BRIDGE_TRUST_PROXY=1`.
- **Secret-scan on write** — rejects notes that contain obvious API keys /
  private keys so credentials don't get stored by accident.
- **Untrusted-data framing on read** — retrieved note contents are wrapped
  with a "this is data, not instructions" banner to blunt memory-poisoning
  (an attacker planting instructions in a note for a later agent to obey).
- **Size caps** per note and a response-size cap, plus an append-only audit
  log of mutations (no note contents).

**Reaching your phone without Cloudflare:** Cloudflare Tunnel + Access is the
reference setup, but any authenticated path to port 8791 works — a
**Tailscale** tunnel on your tailnet, or your own reverse proxy with TLS and
auth in front. See [SECURITY.md](./SECURITY.md) for the full posture and
honest known limitations, and [INFRA.md](./INFRA.md) for the tunnel
walkthrough and pre-trust verification checklist.

---

## Configuration

All environment variables are optional:

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_BRIDGE_DB_PATH` | `data/state.db` | SQLite file path |
| `CLAUDE_BRIDGE_TOKEN` | auto-generated → `data/.token` | Bearer token (required to bind a public interface) |
| `CLAUDE_BRIDGE_BIND` | `127.0.0.1` | Interface to bind (`0.0.0.0` inside Docker) |
| `CLAUDE_BRIDGE_PORT` | `8790` | HTTP API + dashboard port |
| `CLAUDE_BRIDGE_MCP_PORT` | `8791` | MCP-over-HTTP port (tunnel this one) |
| `CLAUDE_BRIDGE_TRUST_PROXY` | unset | Set to `1` only behind a trusted proxy that sets `x-forwarded-for` |
| `CLAUDE_BRIDGE_TRUST_CLOUDFLARE` | unset | Set to `1` behind Cloudflare so per-client rate limiting keys on `cf-connecting-ip` |
| `CLAUDE_BRIDGE_EMBEDDINGS` | unset (off) | `on` to enable optional semantic search |
| `CLAUDE_BRIDGE_EMBED_URL` | `http://localhost:11434/v1/embeddings` | OpenAI-compatible embeddings endpoint |
| `CLAUDE_BRIDGE_EMBED_MODEL` | `nomic-embed-text` | Embedding model name |
| `CLAUDE_BRIDGE_EMBED_KEY` | unset | Optional bearer token for the embeddings endpoint |

---

## Status

**Built and tested — 73/73 tests passing (`npm test`), 0 known dependency
vulnerabilities (`npm audit`):**

- SQLite store: CRUD, FTS5 search that reflects updates immediately,
  namespaces, tags, pagination, note revisions + compare-and-swap,
  provenance, export/import.
- HTTP API: every route, auth enforcement, validation, and a response-size
  cap, tested against a live server (not mocked).
- MCP layer: all five tools exercised through a real MCP client over the
  SDK's in-memory transport, asserted against the underlying store.
- Security guards: secret-scan-on-write, size caps, origin check, rate
  limiter.
- Semantic search: vector store, cosine ranking, and RRF fusion unit-tested;
  verified end-to-end against a local Ollama (`nomic-embed-text`) — a
  keyword-free query matched a note by meaning.
- Docker image builds; both ports verified live in a container.

**Not done yet / honest gaps:**

- Semantic search is **optional** and needs your own embeddings endpoint; a
  cold model load can be slow on the first call (raise
  `CLAUDE_BRIDGE_EMBED_TIMEOUT_MS`, or run `reindex`).
- The MCP-over-HTTP path is covered by in-memory transport tests but has
  **not** been load-tested through a live public tunnel under concurrent
  multi-surface use.
- No CI matrix / npm publish yet (so install is from source or Docker, not
  `npx` — that's on the roadmap).

---

## Why SQLite, why no framework, why two dependencies

Two production dependencies total: `@modelcontextprotocol/sdk` and `zod`.
Storage uses Node's built-in `node:sqlite` rather than `better-sqlite3` — no
native module to compile, and its bundled SQLite has FTS5 built in. The HTTP
layer is plain `node:http`. All deliberate: this is meant to sit behind a
public tunnel, so every dependency you don't have is attack surface you
don't have.

## License

MIT — see [LICENSE](./LICENSE).
