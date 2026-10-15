# OneMemory — CLAUDE.md

Shared-state MCP memory store: one SQLite-backed notes store, exposed over
stdio (local) and MCP-over-HTTP (remote), so Claude Code, Desktop, web, and
mobile — plus any MCP client (Cursor, Copilot, Cline) — all read/write the
same state.

## Purpose
Lets all your AI surfaces share memory/state. Write a note from Claude Code on
your desktop and read it back from Claude on your phone, in a fresh chat,
seconds later.

## Stack
- TypeScript, Node >= 24
- Node's built-in `node:sqlite` (no native modules) + FTS5 for keyword search
- Transports: stdio (local), MCP-over-HTTP / Streamable HTTP (remote), plus a
  plain REST API + dashboard
- Two runtime deps: the MCP SDK + zod

## Ports
- `8790` — REST API + dashboard (`ONEMEMORY_PORT`)
- `8791` — MCP-over-HTTP, the one you tunnel (`ONEMEMORY_MCP_PORT`)

## Setup
- Local: wire the stdio MCP server into Claude Code / Desktop / Cursor (see
  INSTALL.md).
- Remote: bind localhost and expose port 8791 through an authenticated tunnel
  (Cloudflare Tunnel or Tailscale) — see INFRA.md. Never bind a public
  interface without an explicit `ONEMEMORY_TOKEN`.

## Rules
- Never store secrets or API keys in the store (a secret scanner rejects the
  obvious ones on write).
- Keep the store for shared state/notes, not large blobs.

## Owner
Dan Calas / Calas Automations Inc., Winnipeg MB, Canada.
