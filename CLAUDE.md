# claude-bridge — CLAUDE.md

Shared-state MCP bridge: one SQLite-backed notes store, exposed over stdio (local) and HTTPS/SSE (remote), so Claude Code, Desktop, web, and mobile all read/write the same state.

## Purpose
Lets all Claude surfaces share memory/state in real time. Dan uses this to keep context consistent across Claude Code (local), Claude Desktop, and mobile sessions.

## Stack
- TypeScript
- SQLite for persistence
- stdio transport (local) + HTTPS/SSE (remote, port 8787 Headroom proxy)

## Setup
- Local: run via stdio MCP config in Claude Desktop / Claude Code
- Remote: proxied through Headroom on port 8787

## Rules
- Never store secrets or API keys in the SQLite store
- Keep the store small — it's for shared state/notes, not large blobs

## Owner
Dan Calas / Calas Automations Inc., Winnipeg MB, Canada.
