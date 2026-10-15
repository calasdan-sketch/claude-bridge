// resolveTokens() parses the primary token + optional scoped tokens from the
// environment. These tests drive it purely via env vars (no files), restoring
// the environment after each case.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveTokens, type TokenEntry } from "../src/config.js";

const SAVE = { tok: process.env.CLAUDE_BRIDGE_TOKEN, list: process.env.CLAUDE_BRIDGE_TOKENS };

function scopeOf(list: TokenEntry[], token: string): string | undefined {
  return list.find((e) => e.token === token)?.scope;
}

describe("resolveTokens", () => {
  afterEach(() => {
    if (SAVE.tok === undefined) delete process.env.CLAUDE_BRIDGE_TOKEN;
    else process.env.CLAUDE_BRIDGE_TOKEN = SAVE.tok;
    if (SAVE.list === undefined) delete process.env.CLAUDE_BRIDGE_TOKENS;
    else process.env.CLAUDE_BRIDGE_TOKENS = SAVE.list;
  });

  test("primary token is admin; valid scoped tokens are added, invalid ones skipped", () => {
    process.env.CLAUDE_BRIDGE_TOKEN = "PRIMARY";
    process.env.CLAUDE_BRIDGE_TOKENS = JSON.stringify([
      { token: "R", scope: "read" },
      { token: "W", scope: "write", label: "writer" },
      { token: "BAD", scope: "superuser" }, // invalid scope -> skipped
      { token: "", scope: "read" }, // empty token -> skipped
    ]);
    const t = resolveTokens();
    assert.equal(scopeOf(t, "PRIMARY"), "admin");
    assert.equal(scopeOf(t, "R"), "read");
    assert.equal(scopeOf(t, "W"), "write");
    assert.equal(scopeOf(t, "BAD"), undefined);
    assert.equal(t.some((e) => e.token === ""), false);
  });

  test("malformed CLAUDE_BRIDGE_TOKENS does not throw and keeps the primary", () => {
    process.env.CLAUDE_BRIDGE_TOKEN = "PRIMARY";
    process.env.CLAUDE_BRIDGE_TOKENS = "{not valid json";
    const t = resolveTokens();
    assert.equal(scopeOf(t, "PRIMARY"), "admin");
  });

  test("a non-array JSON value is ignored (not applied)", () => {
    process.env.CLAUDE_BRIDGE_TOKEN = "PRIMARY";
    process.env.CLAUDE_BRIDGE_TOKENS = JSON.stringify({ token: "X", scope: "admin" });
    const t = resolveTokens();
    assert.equal(scopeOf(t, "X"), undefined);
    assert.equal(scopeOf(t, "PRIMARY"), "admin");
  });

  test("a duplicate token keeps the MOST restrictive scope", () => {
    process.env.CLAUDE_BRIDGE_TOKEN = "PRIMARY";
    process.env.CLAUDE_BRIDGE_TOKENS = JSON.stringify([
      { token: "D", scope: "admin" },
      { token: "D", scope: "read" },
    ]);
    assert.equal(scopeOf(resolveTokens(), "D"), "read");
  });

  test("the primary admin token cannot be downgraded by a scoped entry", () => {
    process.env.CLAUDE_BRIDGE_TOKEN = "PRIMARY";
    process.env.CLAUDE_BRIDGE_TOKENS = JSON.stringify([{ token: "PRIMARY", scope: "read" }]);
    assert.equal(scopeOf(resolveTokens(), "PRIMARY"), "admin");
  });
});
