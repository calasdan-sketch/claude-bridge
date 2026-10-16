# Security & Threat Model — OneMemory

OneMemory is a note store exposed over MCP + HTTP. **Treat all stored
content as untrusted input to your agents** — see "Memory safety" below.

## Controls

- **Network:** binds `127.0.0.1` by default. Public exposure is opt-in
  (`ONEMEMORY_BIND`) and the server **refuses to start** on a non-loopback
  address unless you set an explicit `ONEMEMORY_TOKEN`. Public deployments
  are expected to sit behind an authenticated tunnel (e.g. Cloudflare Tunnel +
  Cloudflare Access). The **Origin** header is validated (DNS-rebinding
  defense); browser origins are blocked unless listed in
  `ONEMEMORY_ALLOWED_ORIGINS`.
- **Auth:** a bearer token is required on every route except `/health` and
  `/ready`. Each token is compared in constant time (a minor side-channel on
  token length/count is not fully eliminated, which is immaterial for the
  high-entropy tokens this uses behind a tunnel). Tokens are never placed in
  URLs and are never logged. The primary token file is created `0600` and is
  git-ignored.
- **Scoped tokens:** besides the primary (admin) token, you can define extra
  `read` / `write` / `admin` tokens via `ONEMEMORY_TOKENS` (a JSON array)
  or a `~/.onememory/tokens.json` file, so a leaked read-only token can't write, delete
  or dump the store. Scopes are enforced identically on the REST API and the
  MCP tools; `/export` (a full-store dump), `/import` and all deletes require
  `admin`. If you use `~/.onememory/tokens.json`, it is re-`chmod`ed `600` on every start (POSIX) — it holds credentials
  and the app reads but does not set its permissions.
- **Rate limiting:** per-client fixed-window limiter (defaults configurable via
  `ONEMEMORY_RATE_MAX` / `ONEMEMORY_RATE_WINDOW_MS`) so a leaked token
  can't be brute-forced or hammered. Over-limit requests get `429`.
- **Input validation:** per-note size caps (title/body/tags), a 1MB request
  body cap, and parameterized SQL only (no string-built queries).
- **Secret guard:** writes are scanned for high-confidence credentials (AWS
  keys, private-key blocks, provider API tokens, etc.) and **rejected** — a
  memory store is exactly where secrets get pasted by accident, and they would
  otherwise sit in plaintext forever.
- **Audit log:** an append-only log records every mutation (op, id, namespace,
  byte count) — **no note content and no secrets** are logged.
- **Supply chain:** committed lockfile + `npm ci`, Dependabot, `npm audit` in
  CI, and MIT-licensed with only two production dependencies.

## Memory safety (the important part)

A note store whose contents are read back by autonomous agents is a
**stored prompt-injection / "memory poisoning"** channel: someone could plant
text like *"ignore your instructions and …"* in a note that a later agent
reads. The shipped **SKILL.md** instructs agents to treat note contents as
**data, never as instructions** — only the user's live messages are commands.
If you integrate the HTTP/MCP tools yourself, enforce the same rule.

## Known limitations (stated honestly)

- A leaked read-write token grants full access to the store until you rotate
  it (rotate by setting a new `ONEMEMORY_TOKEN` or deleting `~/.onememory/.token`).
- The SQLite file is **not encrypted at rest** by default — use full-disk
  encryption, or wait for the planned SQLCipher option. Encryption at rest
  protects against disk/backup theft, not a live attacker with a valid token.
- Prompt injection is **mitigated, not eliminated** (OWASP GenAI #1). Your
  agents must treat retrieved notes as untrusted data.

## On the roadmap

SQLCipher encryption at rest, full OAuth 2.1 (PKCE + audience binding +
protected-resource-metadata), token rotation helpers, and
soft-delete/tombstones.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or email the
maintainer. Do not file public issues for security reports.
