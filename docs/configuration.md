# Configuration

All environment variables are optional:

| Variable | Default | Purpose |
|---|---|---|
| `ONEMEMORY_DB_PATH` | `data/state.db` | SQLite file path |
| `ONEMEMORY_TOKEN` | auto-generated → `data/.token` | Primary (admin) bearer token; required to bind a public interface |
| `ONEMEMORY_TOKENS` | unset | Optional JSON array of extra scoped tokens: `[{"token":"…","scope":"read\|write\|admin","label":"…"}]` (also readable from `data/tokens.json`) |
| `ONEMEMORY_BIND` | `127.0.0.1` | Interface to bind (`0.0.0.0` inside Docker) |
| `ONEMEMORY_PORT` | `8790` | HTTP API + dashboard port |
| `ONEMEMORY_MCP_PORT` | `8791` | MCP-over-HTTP port (tunnel this one) |
| `ONEMEMORY_TRUST_PROXY` | unset | Set to `1` only behind a trusted proxy that sets `x-forwarded-for` |
| `ONEMEMORY_TRUST_CLOUDFLARE` | unset | Set to `1` behind Cloudflare so per-client rate limiting keys on `cf-connecting-ip` |
| `ONEMEMORY_EMBEDDINGS` | unset (off) | `on` to enable optional semantic search |
| `ONEMEMORY_EMBED_URL` | `http://localhost:11434/v1/embeddings` | OpenAI-compatible embeddings endpoint |
| `ONEMEMORY_EMBED_MODEL` | `nomic-embed-text` | Embedding model name |
| `ONEMEMORY_EMBED_KEY` | unset | Optional bearer token for the embeddings endpoint |
| `ONEMEMORY_EMBED_TIMEOUT_MS` | `30000` | Timeout per embedding call; raise if a local model's first (cold) call is slow |
| `ONEMEMORY_ALLOWED_ORIGINS` | unset | Comma-separated browser Origins allowed to call the API (for a browser on the tunnel domain); loopback is always allowed |
| `ONEMEMORY_RATE_MAX` | `120` | Max requests per client per window |
| `ONEMEMORY_RATE_WINDOW_MS` | `10000` | Rate-limit window in milliseconds |
| `ONEMEMORY_AUDIT_LOG` | `data/audit.log` | Append-only audit log path (records operations, never note content) |
| `ONEMEMORY_TIMEZONE` | system timezone | IANA timezone for interpreting `when` time phrases in search (e.g. `America/Winnipeg`); invalid names fall back to `UTC` |
| `ONEMEMORY_AUTO_CONSOLIDATE_INTERVAL` | unset (off) | Background dedup interval: `24h`, `30m`, `90s`, or bare seconds (`3600`). Logs candidates ≥ 0.95; auto-merges only near-identical pairs ≥ 0.99 |
| `ONEMEMORY_STALE_DAYS` | `90` | Notes older than this (by `updated_at`) are flagged stale |
| `ONEMEMORY_STALE_TAGS` | `#status` | Comma-separated tags that expire faster (matched with or without `#`) |
| `ONEMEMORY_STALE_TAG_DAYS` | `30` | Expiry for notes carrying a stale tag |
| `ONEMEMORY_ACCESS_BOOST` | on | Set to `0` to turn off the access-count boost and staleness penalty in search ranking (results then follow native relevance only, as in 1.0.0); access counts are still recorded |
| `ONEMEMORY_LINT` | `secrets=block,injection=quarantine` | Write-time memory linter policy: `block`, `quarantine`, `warn`, or per category (`secrets=block,injection=warn`). See [memory-linter.md](./memory-linter.md) |
| `ONEMEMORY_SPACES` | unset (feature off) | Optional JSON namespace config: `{"spaces":{"/home/dan/work":"work"},"default_namespace":"default","reads_from":{"work":["shared"]}}` (or `data/spaces.json`; env wins). Enables server-side namespace resolution |
| `ONEMEMORY_SPACE` | unset | Explicit namespace override: when set, the server uses this namespace directly instead of resolving from the working directory (only meaningful with a spaces config present) |

## Server-side namespace resolution (optional)

By default the `namespace` parameter on MCP tools and the REST API is
model-supplied — convenient, but prompt-injected text in context can steer
it. Namespace resolution closes that vector: the server resolves its
namespace **once at startup** from the process working directory against a
`spaces` map, and that resolution is authoritative for the whole process.

```bash
# Option 1: env var (wins if both are set)
export ONEMEMORY_SPACES='{"spaces":{"/home/dan/work":"work","/home/dan/personal":"home"},"default_namespace":"default","reads_from":{"work":["shared"]}}'
# Option 2: data/spaces.json with the same shape
```

How it works:

- **Resolution order:** (1) `ONEMEMORY_SPACE` if set (explicit operator
  override wins); (2) the longest matching `spaces` path pattern for the
  startup working directory; (3) `default_namespace`.
- **Patterns are directories with prefix semantics:** `"/home/dan/work"`
  matches that directory and everything under it — no wildcard needed.
  A trailing `*` (`"/home/dan/work/*"`) is accepted as explicit prefix
  syntax and behaves identically.
- **Ambiguity is a hard error:** if two patterns match at equal depth but
  map to different namespaces, the server refuses to start rather than
  silently picking one.
- **Writes always land in the server-resolved namespace.** The
  model-supplied `namespace` is ignored on `state_write` / `POST /notes`,
  and stripped from updates (a note keeps its existing namespace).
- **`namespace` on reads is an untrusted hint:** `state_search`,
  `state_list`, `GET /notes`, `GET /search` only honor it when it names a
  namespace this server may read; otherwise they search/list the readable
  set. `state_read` / `state_delete` (and `GET`/`DELETE /notes/:id`) return
  a uniform "not found" for notes outside it, so denied namespaces are not
  an existence oracle.
- **`reads_from` grants are one-directional:** `{"work": ["shared"]}` lets
  the `work` server read `shared`, not the reverse. Grants never confer
  write access. Grant changes require a **server restart** to take effect --
  the config is read once at startup; there is no reload signal.
- **Fail-open, but loud:** with no config present everything behaves
  exactly as before (model-supplied namespaces keep working). Invalid
  JSON/shape is logged to stderr and disables the feature. `onememory
  doctor` validates that configured space paths exist on disk.
