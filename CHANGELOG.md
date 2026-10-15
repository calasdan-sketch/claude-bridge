# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Scoped tokens: `read` / `write` / `admin`, via `CLAUDE_BRIDGE_TOKENS` (JSON)
  or `data/tokens.json`, enforced identically on the REST API and MCP tools.
- Optional semantic search (keyword / semantic / hybrid) using your own
  OpenAI-compatible or Ollama embeddings endpoint; off by default, with a
  `reindex` CLI command.
- One-command self-host: `Dockerfile` + `docker-compose.yml` (runs as a
  non-root user, with a `/ready` health check).
- `docker compose` + `start` now run the REST API/dashboard **and** the
  MCP-over-HTTP endpoint in one process on a shared store.
- `/ready` readiness endpoint (touches the DB) alongside `/health` (liveness).
- CLI: `start`, `mcp`, `doctor`, `init`, `reindex`.
- Docs: "Use with n8n" and Cloudflare Access setup in `INFRA.md`.

### Changed
- Hardened per an external review: stale-embedding invalidation on update,
  `ValidationError` so unexpected faults return a generic 500, dashboard CSP +
  `nosniff`, `cf-connecting-ip` trust gated behind a flag, full `/export`
  restricted to `admin`.
- Cleared all production dependency vulnerabilities (`npm audit`).

## [1.0.0] — first public version
- SQLite note store (`node:sqlite`, no native modules) with FTS5 full-text
  search kept in sync by triggers, namespaces, tags, pagination, note
  revisions (compare-and-swap), provenance, and export/import.
- MCP server over stdio and HTTP, plus a plain REST API and a small dashboard.
- Security baseline: localhost-by-default/fail-closed, bearer auth, Origin
  checks, rate limiting, secret-scan-on-write, untrusted-data framing on read,
  size/response caps, audit log.
