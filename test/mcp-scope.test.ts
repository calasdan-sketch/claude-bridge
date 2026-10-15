// A read-scoped MCP server must refuse writes and deletes but still allow
// reads/search/list. Same InMemoryTransport harness as mcp.test.ts.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";

describe("MCP scope enforcement (read-only token)", () => {
  let store: Store;
  let client: Client;

  before(async () => {
    store = new Store(":memory:");
    store.create({ title: "seed", body: "hello" });
    const server = createMcpServer(store, "read"); // read-only principal
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
  });

  after(async () => {
    await client.close();
    store.close();
  });

  test("state_list is allowed under read scope", async () => {
    const r: any = await client.callTool({ name: "state_list", arguments: {} });
    assert.ok(!r.isError, "read scope should allow listing");
  });

  test("state_write is refused under read scope", async () => {
    const r: any = await client.callTool({
      name: "state_write",
      arguments: { title: "nope" },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /scope/i);
    // And nothing was written.
    assert.equal(store.list({}).total, 1);
  });

  test("state_delete is refused under read scope", async () => {
    const r: any = await client.callTool({
      name: "state_delete",
      arguments: { id: 1 },
    });
    assert.equal(r.isError, true);
    assert.equal(store.read(1)?.title, "seed"); // still there
  });
});
