// npm preinstall: rescue 1.0.x state before an upgrade deletes it.
//
// 1.0.x kept its database inside the package (<pkg>/data). `npm install -g`
// moves the old package aside (npm 11: ../.onememory-mcp-XXXX) and deletes it
// once the new one is in place -- before 1.1.0 ever runs its own migration.
// This copies state.db (+ token/spaces files) into ~/.onememory
// (ONEMEMORY_HOME wins) when that has no state.db yet. Plain node, no deps,
// and it never fails the install: every error is swallowed, exit code 0.
"use strict";
try {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");

  const pkgDir = path.resolve(__dirname, "..");
  const home = (process.env.ONEMEMORY_HOME || "").trim();
  const target = home ? path.resolve(home) : path.join(os.homedir(), ".onememory");
  const dst = path.join(target, "state.db");

  const roots = new Set([path.dirname(pkgDir)]);
  const prefix = process.env.npm_config_prefix;
  if (prefix) roots.add(process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules"));
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, "onememory-mcp", "data"));
    try {
      for (const e of fs.readdirSync(root)) if (e.startsWith(".onememory-mcp-")) candidates.push(path.join(root, e, "data"));
    } catch {}
  }
  const from = candidates.find((d) => d !== path.join(pkgDir, "data") && fs.existsSync(path.join(d, "state.db")));

  if (from && !fs.existsSync(dst)) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const tmp = `${dst}.preinstall-${process.pid}`;
    let copied = false;
    try {
      process.emitWarning = () => {}; // quiet node:sqlite's ExperimentalWarning
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(path.join(from, "state.db"));
      try {
        db.exec("PRAGMA busy_timeout = 5000;");
        db.prepare("VACUUM INTO ?").run(tmp);
        copied = true;
      } finally {
        db.close();
      }
    } catch {
      // no node:sqlite (or it failed): copy the files; the WAL replays on open
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
    }
    const publish = (a, b) => {
      try {
        fs.linkSync(a, b); // never replaces: EEXIST means someone else won
        fs.chmodSync(b, 0o600);
      } catch {}
      try {
        fs.rmSync(a, { force: true });
      } catch {}
    };
    if (copied) publish(tmp, dst);
    else {
      for (const ext of ["-wal", "-shm"]) {
        const a = path.join(from, `state.db${ext}`);
        if (fs.existsSync(a) && !fs.existsSync(dst + ext)) {
          try {
            fs.copyFileSync(a, `${tmp}${ext}`);
            publish(`${tmp}${ext}`, dst + ext);
          } catch {}
        }
      }
      try {
        fs.copyFileSync(path.join(from, "state.db"), tmp);
        publish(tmp, dst);
      } catch {}
    }
    for (const f of [".token", "tokens.json", "spaces.json"]) {
      const a = path.join(from, f);
      const b = path.join(target, f);
      try {
        if (fs.existsSync(a) && !fs.existsSync(b)) fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(b, 0o600);
      } catch {}
    }
    if (fs.existsSync(dst)) console.error(`[onememory] preinstall: copied your 1.0.x data from ${from} to ${target}`);
  }
} catch {}
process.exitCode = 0;
