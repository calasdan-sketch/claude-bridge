# Install OneMemory in your agent

OneMemory speaks the standard **MCP** protocol, so it drops into any
MCP-capable agent. They all launch it the same way — a local command over
"stdio" — they just keep their config in different places. Pick yours below.

> **One-time setup first:**
> ```bash
> git clone https://github.com/calasdan-sketch/onememory.git
> cd OneMemory
> npm install && npm run build
> ```
> That produces `dist/src/mcp-stdio.js`, which every client below points at.
> Requires Node.js 24+.

In every snippet, replace `/ABSOLUTE/PATH/TO` with the real path to the
folder you cloned into.

---

## Claude Code

```bash
claude mcp add onememory -- node /ABSOLUTE/PATH/TO/onememory/dist/src/mcp-stdio.js
```

## Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "onememory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/onememory/dist/src/mcp-stdio.js"]
    }
  }
}
```

## Cursor

Create `.cursor/mcp.json` in your project (or the global one in `~/.cursor/`):

```json
{
  "mcpServers": {
    "onememory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/onememory/dist/src/mcp-stdio.js"]
    }
  }
}
```

## GitHub Copilot (VS Code)

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "onememory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/onememory/dist/src/mcp-stdio.js"]
    }
  }
}
```

## Windsurf / Cline / Continue / other MCP agents

They all accept the same stdio launch. Find the client's MCP config and add
a server whose command is `node` and whose argument is the absolute path to
`dist/src/mcp-stdio.js`. Example (Windsurf `~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "onememory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/onememory/dist/src/mcp-stdio.js"]
    }
  }
}
```

---

## Also reach Claude web & mobile (optional)

Everything above is local. To let Claude on the web or your phone read/write
the **same** store, run the HTTP server and expose it over an HTTPS tunnel —
see [INFRA.md](./INFRA.md) for the Cloudflare Tunnel + token walkthrough.

## Any other app or language

There's also a plain HTTP JSON API (`POST /notes`, `GET /search`, etc.), so
any script or model that can make a web request can use the same store — no
MCP required. See the README for the routes.
