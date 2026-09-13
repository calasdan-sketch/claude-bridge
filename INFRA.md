---
type: guide
status: active
---
# Claude Bridge — Infra & Ops Guide

Setup and operations guide for exposing claude-bridge to Claude's remote
surfaces (web, mobile) over the public internet. This document covers the
infra side only — tunnel setup, auth verification, connector setup, and a
smoke test. See the main [README](./README.md) for what the project is and
how to build/run it locally.

## Real values (from `src/config.ts`)

| Name | Value |
|---|---|
| HTTP API port | `8790` (env `CLAUDE_BRIDGE_PORT`) |
| MCP-over-HTTP port | `8791` (env `CLAUDE_BRIDGE_MCP_PORT`) |
| MCP-over-HTTP path | `/mcp` |
| Bearer token env var | `CLAUDE_BRIDGE_TOKEN` (auto-generated and persisted to `data/.token` if unset) |
| DB path env var | `CLAUDE_BRIDGE_DB_PATH` (defaults to `data/state.db`) |

Placeholders used below that are specific to *your* setup:

| Placeholder | Meaning |
|---|---|
| `<TUNNEL_HOSTNAME>` | The public hostname the tunnel exposes, e.g. `bridge.yourdomain.com` |
| `<BRIDGE_TOKEN>` | The bearer token value (from `CLAUDE_BRIDGE_TOKEN` or the auto-generated `data/.token` file) |

---

## 1. Cloudflare Tunnel setup

### Prerequisite: a domain

Cloudflare named tunnels (the kind that survive a restart with the same
public URL) need a **hostname under a domain that is added as a zone in your
Cloudflare account**. A free `*.workers.dev` subdomain doesn't count — you
need an actual domain (purchased or transferred elsewhere and pointed at
Cloudflare's nameservers).

- **Quick Tunnels** (`cloudflared tunnel --url http://localhost:8791`, no
  login needed) hand you a random `*.trycloudflare.com` URL that **changes
  every time cloudflared restarts** — fine for a five-minute test, useless
  for a connector you configure once on your phone and forget about.
- **Named Tunnels** (below) restart with the same URL, but need
  `cloudflared tunnel route dns`, which requires a zone in your account.

The steps below assume you have a domain added as a zone; swap in your real
one wherever you see `yourdomain.com`.

### Step 1 — Install cloudflared

Windows (winget):

```powershell
winget install --id Cloudflare.cloudflared -e
```

Close and reopen the terminal, then confirm:

```powershell
cloudflared --version
```

macOS/Linux: see [Cloudflare's install docs](https://developers.cloudflare.com/cloudflared/get-started/).

### Step 2 — Authenticate

```powershell
cloudflared tunnel login
```

Opens a browser. Log in with your Cloudflare account and pick the domain
(zone) to authorize. This drops a cert at `~/.cloudflared/cert.pem`.

### Step 3 — Create the named tunnel

```powershell
cloudflared tunnel create claude-bridge
```

Note the **Tunnel ID** it prints (a UUID). This also writes a credentials
file to `~/.cloudflared/<TUNNEL_ID>.json` — treat that file as a secret.

### Step 4 — Config file

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /path/to/home/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: <TUNNEL_HOSTNAME>
    service: http://localhost:8791
  - service: http_status:404
```

`8791` is the MCP-over-HTTP port (see table above). The catch-all 404 rule
at the bottom is required by cloudflared syntax — every ingress list needs
a final rule with no hostname.

### Step 5 — Route DNS

```powershell
cloudflared tunnel route dns claude-bridge <TUNNEL_HOSTNAME>
```

Creates a CNAME in Cloudflare DNS pointing `<TUNNEL_HOSTNAME>` at the
tunnel. Cloudflare terminates TLS for you — the public URL is
`https://<TUNNEL_HOSTNAME>/mcp` with a real cert, no extra work.

### Step 6 — Test it manually

```powershell
cloudflared tunnel run claude-bridge
```

Leave it running, then from another machine (or your phone off wifi) hit
`https://<TUNNEL_HOSTNAME>/health` and confirm you get `{"status":"ok"}`,
not a Cloudflare error page. Ctrl+C to stop once confirmed.

### Step 7 — Restart-on-boot

**Option A — Windows Service (recommended, needs an elevated shell once):**

```powershell
cloudflared service install
```

Registers `cloudflared` as a Windows service that starts at boot, before
any user logs in. Manage it afterwards with:

```powershell
Get-Service Cloudflared
Restart-Service Cloudflared
```

**Option B — Scheduled Task at logon (no elevation needed, weaker guarantee):**

```powershell
schtasks /create /tn "CloudflaredTunnel-ClaudeBridge" /tr "cloudflared tunnel run claude-bridge" /sc onlogon /rl limited
```

Caveat: this only starts the tunnel once you log into Windows, not at raw
machine boot. Fine as a stopgap, not a substitute for Option A.

On macOS/Linux, `cloudflared service install` similarly registers a
launchd/systemd unit.

---

## 2. Token auth checklist

**Do not expose the bridge endpoint unauthenticated.** Verify this before
telling anyone the endpoint is safe to use.

### What "done" looks like

1. The MCP-over-HTTP server (`dist/src/mcp-http.js`) reads a bearer token
   from `CLAUDE_BRIDGE_TOKEN` (or the auto-generated `data/.token` file)
   and rejects any request whose `Authorization: Bearer <token>` header
   doesn't match, before touching the SQLite store or returning any MCP
   capability/tool list.
2. cloudflared itself adds **no auth** — it's a dumb TCP/HTTP proxy from
   `<TUNNEL_HOSTNAME>` to `http://localhost:8791`. Anyone with the URL can
   reach the local server unless the server's own code checks the token.
   The check lives in the app, not the tunnel.
3. The token is never printed to a log beyond the one-time generation
   message, never committed to version control, and should be stored the
   same way you store any other secret (a password manager or OS keychain
   entry), not pasted into notes or docs.

### How to verify

Run these from the machine itself (localhost, no tunnel needed for the
first two):

```powershell
# 1. No token at all — must fail (expect 401, not 200)
curl.exe -i http://localhost:8791/mcp

# 2. Wrong token — must fail (expect 401)
curl.exe -i http://localhost:8791/mcp -H "Authorization: Bearer wrong-token-obviously"

# 3. Correct token — must succeed
curl.exe -i http://localhost:8791/mcp -H "Authorization: Bearer <BRIDGE_TOKEN>"
```

Then repeat all three through the public tunnel URL
(`https://<TUNNEL_HOSTNAME>/mcp`) from a network that isn't this machine
(phone on cellular data works) to confirm the tunnel isn't somehow
bypassing the check.

**Don't consider this done, and don't call the endpoint safe to expose,
until all three checks above have actually been run and produced the
expected status codes.**

### Recommended second layer (optional, not a blocker)

If you're already on Cloudflare, **Cloudflare Access** (part of the free
Zero Trust plan) can sit in front of the tunnel hostname and require an
email-OTP login restricted to your own address before traffic even reaches
the bridge server — defense in depth on top of the bearer token, in case
the token ever leaks. This adds a login step to every new client
connection, so weigh that against the extra protection before turning it
on.

---

## 3. Connector setup — all four Claude surfaces

Two surfaces (Code, Desktop) are **local**: they run on your machine and
talk to the bridge over local stdio, no tunnel needed. The other two (web,
mobile) are **remote** and must go over the public HTTPS tunnel URL from
Section 1.

### Claude Code (local, stdio)

Claude Code reads MCP servers from a `.mcp.json` file (project-level, at
the repo root you're working in):

```json
{
  "mcpServers": {
    "claude-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/claude-bridge/dist/src/mcp-stdio.js"],
      "env": {
        "CLAUDE_BRIDGE_TOKEN": "<BRIDGE_TOKEN>"
      }
    }
  }
}
```

Or generate it with the CLI:

```powershell
claude mcp add claude-bridge -- node /absolute/path/to/claude-bridge/dist/src/mcp-stdio.js
```

(`claude mcp add --help` shows the current flags for passing env vars.)

### Claude Desktop (local, stdio)

Config file: `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).
Install/launch Desktop at least once before this file exists to edit.

Same `mcpServers` shape as Code:

```json
{
  "mcpServers": {
    "claude-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/claude-bridge/dist/src/mcp-stdio.js"],
      "env": {
        "CLAUDE_BRIDGE_TOKEN": "<BRIDGE_TOKEN>"
      }
    }
  }
}
```

Desktop's newer builds also expose **Settings → Connectors → Add custom
connector** for remote (HTTP) MCP servers, if you'd rather point Desktop at
the same tunnel URL the web/mobile surfaces use instead of local stdio.
Either works; local stdio is faster and doesn't depend on the tunnel being
up. Check your installed version's settings UI directly — menu placement
moves between releases.

### Claude web (remote, HTTPS)

Claude web only supports remote MCP servers added as a custom connector
through the UI. As currently documented: **claude.ai → Settings →
Connectors → Add custom connector**, then supply:

- Name: `claude-bridge` (or whatever you like)
- URL: `https://<TUNNEL_HOSTNAME>/mcp`
- Auth: however the connector UI asks for the bearer token (a header field
  or an OAuth-style flow, depending on the current UI)

Verify the exact menu path and field names against the live product —
connector UIs change between releases.

### Claude mobile (remote, HTTPS)

Same remote connector mechanism as web, reached through the mobile app's
own settings: **Claude app → Settings → Connectors → Add custom
connector**, same URL and token as the web setup above.

---

## 4. Smoke test — Definition of Done

The real acceptance test: *write a note from Claude Code on the desktop,
then read that same note back from Claude mobile.* Run it exactly like
this once both halves are live — don't accept a partial pass.

### Preconditions (all must be true first)

- [ ] Backend built and running: `npm run build && npm start` in
      `claude-bridge/` completes with no errors, and the process stays up.
- [ ] `npm run mcp:stdio` and `npm run mcp:http` both start cleanly.
- [ ] cloudflared tunnel is running (Section 1) and
      `https://<TUNNEL_HOSTNAME>/health` responds from outside this
      machine.
- [ ] Token auth verified with the three curl checks in Section 2 — all
      three gave the expected status code.
- [ ] Claude Code has the `.mcp.json` entry from Section 3 and lists
      `claude-bridge` as a connected server (`claude mcp list`).
- [ ] Claude mobile has the custom connector from Section 3 added and
      showing as connected in its settings.

### The test itself

1. **On Claude Code, on the desktop**, in a fresh conversation, ask it to
   use the bridge's write tool to save a note with unmistakable, one-off
   content, e.g.:

   > "Using the claude-bridge MCP server, write a note titled
   > `smoke-test-<date>` with the body `bridge smoke test — written from
   > Claude Code desktop at <exact current time>`."

   Confirm Claude Code reports the write succeeded (tool call returned
   success, not an error).

2. **Independently confirm the write landed**, not just that the tool
   claimed success — e.g. hit `https://<TUNNEL_HOSTNAME>/mcp` with curl
   and the bearer token, or check `data/state.db` for the new row
   directly. "The tool said it worked" is not evidence the shared store
   actually persisted it.

3. **On Claude mobile**, start a brand-new conversation and ask:

   > "Using the claude-bridge connector, read back the note titled
   > `smoke-test-<date>` and show me its exact contents."

4. **Pass criteria — all of these, not just "it returned something":**
   - The body text mobile returns is **character-for-character identical**
     to what was written from desktop, including the timestamp.
   - It came back on the first ask, no retries, no "connector not
     responding" errors.
   - Repeat once more in the other direction (write from mobile, read from
     Code) to confirm it's genuinely bidirectional.

5. **Negative check (don't skip this):** temporarily change the bearer
   token Claude mobile's connector is using to something wrong, retry the
   read, and confirm it fails. Put the correct token back afterward.

If all of the above holds, the Definition of Done is met. If a step fails,
the failure point tells you which half broke — Section 1 for anything
tunnel/network-shaped, Section 2 for anything auth-shaped, Section 3 for
anything connector-config-shaped, or the server code itself if the
write/read tools misbehave.
