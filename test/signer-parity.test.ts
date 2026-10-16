// The phone signer (docs/signer.js) and the runner (src/runner.ts) must agree
// byte-for-byte on what gets signed. If they ever drift, every command from
// the phone would be silently ignored as "bad signature" — the single most
// confusing failure mode this system has. So the two implementations are
// tested against each other directly, on the awkward inputs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalString, signCommand, verifyCommand } from "../src/runner.js";
// @ts-expect-error -- plain JS module shared with the browser, no types
import * as browser from "../../docs/signer.js";

const SECRET = "parity-secret";

const cases: Record<string, Parameters<typeof canonicalString>[0]> = {
  "no params": {
    cmd_id: "a", action: "status", issued_at: "2026-10-16T00:00:00.000Z", nonce: "n",
  },
  "params out of order": {
    cmd_id: "b", action: "deploy", params: { zebra: "1", alpha: "2", middle: "3" },
    issued_at: "2026-10-16T00:00:00.000Z", nonce: "n",
  },
  "with a target": {
    cmd_id: "c", action: "status", params: {}, target: "DANITA",
    issued_at: "2026-10-16T00:00:00.000Z", nonce: "n",
  },
  "awkward characters in a value": {
    cmd_id: "d", action: "run", params: { path: "a=b&c\nd", other: "ünïcøde 🙂" },
    issued_at: "2026-10-16T00:00:00.000Z", nonce: "n",
  },
  "empty-string param": {
    cmd_id: "e", action: "run", params: { blank: "" },
    issued_at: "2026-10-16T00:00:00.000Z", nonce: "n",
  },
};

describe("browser signer matches the runner", () => {
  for (const [name, cmd] of Object.entries(cases)) {
    test(`canonical form agrees — ${name}`, () => {
      assert.equal(browser.canonicalString(cmd), canonicalString(cmd));
    });

    test(`signature agrees — ${name}`, async () => {
      assert.equal(await browser.signCommand(SECRET, cmd), signCommand(SECRET, cmd));
    });
  }

  test("a command built in the browser verifies on the runner", async () => {
    const cmd = await browser.buildCommand(SECRET, "status", { repo: "calas-site" }, "DANITA");
    const v = verifyCommand(SECRET, JSON.stringify(cmd));
    assert.equal(v.ok, true, "the runner must accept what the phone produced");
  });

  test("a browser command signed with the wrong secret is still rejected", async () => {
    const cmd = await browser.buildCommand("wrong", "status", {}, "");
    assert.equal(verifyCommand(SECRET, JSON.stringify(cmd)).ok, false);
  });
});
