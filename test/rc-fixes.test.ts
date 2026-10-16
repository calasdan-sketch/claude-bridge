// 1.1.0-rc review fixes: one block per finding, each fails on the pre-fix code.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";

const STORE_JS = fileURLToPath(new URL("../src/store.js", import.meta.url));

/** Run `script` (ESM, argv[1] = arg) in n child processes; resolve their stdout+code. */
function runProcs(n: number, script: string, arg: string, env: NodeJS.ProcessEnv = {}) {
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<{ out: string; err: string; code: number | null }>((resolve) => {
          const p = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script, arg], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...env },
          });
          let out = "";
          let err = "";
          p.stdout.on("data", (d) => (out += d));
          p.stderr.on("data", (d) => (err += d));
          p.on("close", (code) => resolve({ out, err, code }));
        })
    )
  );
}

describe("1: multi-process create() never throws SQLITE_BUSY", () => {
  for (const [procs, per] of [
    [2, 40],
    [8, 15],
  ] as const) {
    test(`${procs} processes x ${per} creates -> zero errors, exact row count`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "om-race-"));
      try {
        const path = join(dir, "s.db");
        const s0 = new Store(path);
        for (let i = 0; i < 30; i++) s0.create({ title: `seed ${i}`, body: `alpha beta gamma deploy ${i}` });
        s0.close();
        const script = `const { Store } = await import(${JSON.stringify("file://" + STORE_JS)});
          const s = new Store(process.argv[1]); let e = 0;
          for (let i = 0; i < ${per}; i++) { try { s.create({ title: "c" + process.pid + "-" + i, body: "alpha beta gamma deploy server " + i }); } catch (x) { e++; console.error(x.message); } }
          console.log(e); s.close();`;
        const res = await runProcs(procs, script, path, { ONEMEMORY_HOME: dir });
        const errors = res.reduce((a, r) => a + (Number(r.out.trim()) || 0) + (r.code ? 1 : 0), 0);
        assert.equal(errors, 0, res.map((r) => r.err).join("\n").slice(0, 400));
        const db = new DatabaseSync(path);
        const n = (db.prepare("SELECT count(*) c FROM notes").get() as { c: number }).c;
        db.close();
        assert.equal(n, 30 + procs * per);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
