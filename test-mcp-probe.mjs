// Manual smoke test for the stdio MCP server: connects a real MCP Client,
// lists tools, writes a note, and searches for it. Run with:
//   node test-mcp-probe.mjs
// (after `npm run build`, from the project root).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/mcp-stdio.js"],
  env: { ...process.env },
  cwd: process.cwd(),
});
const client = new Client({ name: "probe", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(","));

const readResult = await client.callTool({ name: "state_read", arguments: { id: 1 } });
console.log("STATE_READ id=1:", readResult.content[0].text);

const writeResult = await client.callTool({
  name: "state_write",
  arguments: { title: "From stdio MCP probe", body: "cross-surface-proof-token-42" },
});
console.log("STATE_WRITE:", writeResult.content[0].text);

const searchResult = await client.callTool({
  name: "state_search",
  arguments: { query: "cross-surface-proof-token-42" },
});
console.log("STATE_SEARCH:", searchResult.content[0].text);

await client.close();
