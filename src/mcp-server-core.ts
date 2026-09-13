// Transport-agnostic MCP server: registers the four tools the spec requires
// (state_write, state_read, state_search, state_list) directly against the
// shared Store. Both the stdio entry point and the HTTP/SSE entry point
// build one of these per connection/process, always pointed at the same
// SQLite file as the HTTP API -- there is exactly one state store, not a
// mock or a second copy.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Store } from "./store.js";

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message }),
      },
    ],
    isError: true,
  };
}

export function createMcpServer(store: Store): McpServer {
  const server = new McpServer({
    name: "claude-bridge",
    version: "1.0.0",
  });

  server.registerTool(
    "state_write",
    {
      title: "Write shared state",
      description:
        "Create a new note in the shared cross-surface state store, or update an existing one if `id` is given. Returns the resulting note.",
      inputSchema: {
        id: z
          .number()
          .int()
          .optional()
          .describe("Id of an existing note to update. Omit to create a new note."),
        namespace: z
          .string()
          .optional()
          .describe("Namespace/bucket for the note. Defaults to 'default'."),
        title: z
          .string()
          .optional()
          .describe("Note title. Required when creating a new note."),
        body: z.string().optional().describe("Note body/content."),
        tags: z.array(z.string()).optional().describe("Tags for the note."),
      },
    },
    async ({ id, namespace, title, body, tags }) => {
      try {
        if (id !== undefined) {
          const updated = store.update(id, { namespace, title, body, tags });
          if (!updated) return errorResult(`no note with id ${id}`);
          return textResult({ note: updated });
        }
        if (!title || !title.trim()) {
          return errorResult("title is required when creating a new note");
        }
        const created = store.create({ namespace, title, body, tags });
        return textResult({ note: created });
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "state_read",
    {
      title: "Read shared state",
      description: "Read a single note from the shared state store by id.",
      inputSchema: {
        id: z.number().int().describe("Id of the note to read."),
      },
    },
    async ({ id }) => {
      const note = store.read(id);
      if (!note) return errorResult(`no note with id ${id}`);
      return textResult({ note });
    }
  );

  server.registerTool(
    "state_search",
    {
      title: "Search shared state",
      description:
        "Full-text search notes in the shared state store by title/body/tags. Always reflects the latest writes.",
      inputSchema: {
        query: z.string().describe("Search text."),
        namespace: z.string().optional().describe("Restrict search to this namespace."),
        limit: z.number().int().optional().describe("Max results (default 20, max 200)."),
      },
    },
    async ({ query, namespace, limit }) => {
      try {
        const results = store.search(query, { namespace, limit });
        return textResult({ results });
      } catch (e) {
        return errorResult((e as Error).message);
      }
    }
  );

  server.registerTool(
    "state_list",
    {
      title: "List shared state",
      description: "List notes in the shared state store, optionally filtered by namespace.",
      inputSchema: {
        namespace: z.string().optional().describe("Restrict listing to this namespace."),
        limit: z.number().int().optional().describe("Max results (default 50, max 500)."),
        offset: z.number().int().optional().describe("Pagination offset."),
      },
    },
    async ({ namespace, limit, offset }) => {
      const result = store.list({ namespace, limit, offset });
      return textResult(result);
    }
  );

  return server;
}
