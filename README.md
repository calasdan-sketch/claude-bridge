# claude-bridge

A shared-state MCP bridge that lets **Claude Code, Claude Desktop, Claude
web, and Claude mobile all read and write the same notes store.** Write a
note from Claude Code on your desktop, read it back from Claude on your
phone, in a brand-new conversation, seconds later.

## The gap this fills

There's already a small ecosystem of "AI memory vault" projects on GitHub —
tools that connect Claude Code, terminal agents, and editors like Cursor to
a local filesystem-backed store of notes. They're good at what they do. But
every one of them shares the same limitation: **they're local-only.** They
connect surfaces that run on your machine to a store on your machine.
None of the ones I looked at reach Claude mobile or claude.ai's web app
through a hosted, remote connection.

claude-bridge is built around a transport split specifically to close that
gap:

- **Local surfaces** (Claude Code, Claude Desktop) talk to the bridge over
  **stdio** — a local MCP server process reading/writing the same SQLite
  file.
- **Remote surfaces** (Claude web, Claude mobile) talk to the *same* store
  over a properly hosted **HTTPS/SSE MCP endpoint**, reached through a
  tunnel (Cloudflare Tunnel, in the reference setup) with bearer-token auth
  in front of it.

Same data, same four tools, two transports. That's the whole idea — it's
the memory bridge that actually reaches your phone.

This isn't a claim to be the first memory-vault tool, and it doesn't do
anything fancier than the local-only projects in the space at the storage
layer (SQLite + full-text search). The difference is specifically the
remote transport, and that it's designed in from the start rather than
bolted on.

## Architecture

```
                 local stdio                    Cloudflare Tunnel (HTTPS)
Claude Code  ───────────────┐                  ┌─────────────────────────
Claude Desktop ─────────────┼──> claude-bridge <┤   Claude web
                             │   MCP server(s) +│   Claude mobile
                             │   SQLite store    └─────────────────────────
                             │
                        HTTP JSON API
                     (curl / scripts / debugging)
```

Three processes, one store:

- **`src/store.ts`** — the shared state layer. SQLite via Node's built-in
  `node:sqlite` (no native module build step), with an FTS5 index kept in
  sync by triggers so search never goes stale after a write.
- **`src/api.ts`** / **`src/index.ts`** — a minimal HTTP/JSON API over the
  store (`POST /notes`, `GET /notes/:id`, `PUT /notes/:id`, `GET /notes`,
  `GET /search`). Built on plain `node:http`, no framework — five routes
  don't need a router library, and this thing is meant to sit behind a
  public tunnel, so less dependency surface is a feature.
- **`src/mcp-server-core.ts`** — the transport-agnostic MCP server,
  registering four tools (`state_write`, `state_read`, `state_search`,
  `state_list`) against the shared store.
- **`src/mcp-stdio.ts`** — stdio entry point, for local Claude Code /
  Claude Desktop config.
- **`src/mcp-http.ts`** — HTTP/SSE (Streamable HTTP) entry point, for the
  tunnel that Claude web/mobile connect through. Stateless: one shared
  `Store`, a fresh MCP server + transport per request.

All entry points read the same `CLAUDE_BRIDGE_DB_PATH`, so a note written
through any one of them is immediately visible through the others.

Every route except `/health` requires `Authorization: Bearer <token>`. The
token comes from `CLAUDE_BRIDGE_TOKEN` if set, otherwise the server
generates one on first run and persists it to `data/.token`.

## Setup

Requires Node.js >= 22.5.0 (uses `node:sqlite`, which needs a recent Node).

```bash
npm install
npm run build
npm start          # HTTP JSON API on :8790
npm run mcp:stdio  # MCP server over stdio, for local Claude Code/Desktop config
npm run mcp:http   # MCP server over HTTP/SSE on :8791, for the tunnel
```

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_BRIDGE_DB_PATH` | `data/state.db` | SQLite file path |
| `CLAUDE_BRIDGE_TOKEN` | auto-generated, saved to `data/.token` | Bearer token required on every authenticated route |
| `CLAUDE_BRIDGE_PORT` | `8790` | HTTP JSON API port |
| `CLAUDE_BRIDGE_MCP_PORT` | `8791` | MCP-over-HTTP port |

For local-only use (just Claude Code and/or Claude Desktop on one machine),
that's the whole setup — point both at `mcp-stdio.js` in your MCP client
config and you're done, no tunnel needed.

To also reach Claude web/mobile, you need the MCP-over-HTTP server exposed
publicly over HTTPS. See **[INFRA.md](./INFRA.md)** for the full
walkthrough: Cloudflare Tunnel setup, the token-auth verification checklist
you should run before trusting the endpoint, connector configuration for
all four Claude surfaces, and an end-to-end smoke test.

## Status

**What's built and tested:**
- SQLite store with CRUD + FTS5 full-text search, namespaces, pagination —
  covered by 18 unit tests exercising create/read/update/delete, search
  freshness after updates, namespace filtering, and edge cases (empty
  queries, special characters, limit clamping).
- HTTP JSON API — 16 tests covering every route, auth enforcement (missing
  token, wrong token, malformed header), validation errors, and search
  correctness against a live server instance (not mocked).
- MCP tool layer (`state_write`/`state_read`/`state_search`/`state_list`) —
  11 tests using a real MCP `Client` talking to a real `McpServer` over the
  SDK's in-memory transport, asserting against the underlying store
  directly rather than trusting tool responses alone.
- **45/45 tests passing** (`npm test`), 0 failures, run against the
  compiled build.
- `npm audit`: 0 known vulnerabilities in dependencies.

**What's rough / not yet done:**
- The MCP-over-HTTP transport is stateless by design (fresh server per
  request) — this has automated test coverage via the in-memory transport
  but has not yet been load-tested through an actual public tunnel under
  concurrent multi-surface use.
- No automated tests exercise the tunnel or the four Claude-surface
  connector configs end-to-end — that verification is manual, documented
  as a checklist in `INFRA.md` Section 4, and hasn't been run against a
  live deployment as of this writing.
- No rate limiting on the HTTP API beyond a 1MB request body cap — fine for
  a single-operator bridge, worth adding before any multi-user use.
- Delete is implemented in the store (`store.delete()`) but not yet exposed
  through the HTTP API or the MCP tool layer.

## Why SQLite, why no framework, why so few dependencies

Two production dependencies total: `@modelcontextprotocol/sdk` and `zod`.
Storage uses Node's built-in `node:sqlite` rather than `better-sqlite3` or
similar — no native module to compile, ships in the Node binary, and its
bundled SQLite has FTS5 compiled in. The HTTP layer is plain `node:http`
rather than Express or Fastify. Both choices are deliberate: this thing is
designed to be exposed on a public tunnel, so every extra dependency is
extra attack surface for something reachable from the internet.

## License

MIT — see [LICENSE](./LICENSE).
