// The command runner ships separately from the memory package. This guards
// the published tarball: if any runner file (code, docs, scripts, example
// allowlist, phone signing page) ever appears in `npm pack`, it fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";

const RUNNER_FILE = /runner|(^|\/)sign(er)?\.(html|js)$|RUNNER\.md|install-runner-task|(^|\/)api\.cmd$/i;

test("npm pack ships no runner file", () => {
  // npm_execpath is npm's own CLI script when run via `npm test`; invoking it
  // with node avoids needing a shell to find npm(.cmd) on Windows.
  const npmCli = process.env.npm_execpath;
  const [cmd, pre] = npmCli ? [process.execPath, [npmCli]] : ["npm", []];
  const out = execFileSync(cmd, [...pre, "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const files = (JSON.parse(out) as { files: { path: string }[] }[])[0].files.map((f) => f.path);
  assert.ok(files.includes("dist/src/store.js"), "sanity: the memory package itself is packed");
  const leaked = files.filter((f) => RUNNER_FILE.test(f));
  assert.deepEqual(leaked, [], `runner files in the tarball: ${leaked.join(", ")}`);
});
