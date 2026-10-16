// npm preinstall: rescue 1.0.x state before a GLOBAL upgrade deletes it.
//
// 1.0.x kept its database inside the package (<pkg>/data). `npm install -g`
// moves the old package aside (npm 11: ../.onememory-mcp-XXXX) and deletes it
// once the new one is in place -- before 1.1.0 ever runs its own migration.
// This copies state.db (+ token/spaces files) into ~/.onememory
// (ONEMEMORY_HOME wins) when that has no state.db yet.
//
// Deliberately narrow, because a wrong copy is worse than none (it would
// block the real migration later):
//   - only for global installs, never `npm install` in a checkout, npx, or a
//     project dependency;
//   - only looks next to this package (the folder npm is replacing);
//   - only regular files (no symlinks), newest candidate wins;
//   - only publishes a copy that SQLite opened and that has OneMemory's
//     `notes` table; never overwrites anything.
// Plain node, no deps, and it never fails the install: exit code is always 0.
"use strict";
try {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");

  const pkgDir = path.resolve(__dirname, "..");
  const isGlobal =
    process.env.npm_config_global === "true" || process.env.npm_config_location === "global";
  if (!isGlobal || fs.existsSync(path.join(pkgDir, ".git"))) return;

  const home = (process.env.ONEMEMORY_HOME || "").trim();
  const target = home ? path.resolve(home) : path.join(os.homedir(), ".onememory");
  const dst = path.join(target, "state.db");
  if (fs.existsSync(dst)) return;

  const isFile = (p) => {
    try {
      return fs.lstatSync(p).isFile();
    } catch {
      return false;
    }
  };

  const root = path.dirname(pkgDir);
  const dirs = [path.join(root, "onememory-mcp", "data")];
  try {
    for (const e of fs.readdirSync(root)) if (e.startsWith(".onememory-mcp-")) dirs.push(path.join(root, e, "data"));
  } catch {}
  const from = dirs
    .filter((d) => d !== path.join(pkgDir, "data") && isFile(path.join(d, "state.db")))
    .sort((a, b) => fs.statSync(path.join(b, "state.db")).mtimeMs - fs.statSync(path.join(a, "state.db")).mtimeMs)[0];
  if (!from) return;

  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const tmp = `${dst}.preinstall-${process.pid}`;
  let ok = false;
  try {
    process.emitWarning = () => {}; // quiet node:sqlite's ExperimentalWarning
    const { DatabaseSync } = require("node:sqlite");
    const src = new DatabaseSync(path.join(from, "state.db"));
    try {
      src.exec("PRAGMA busy_timeout = 5000;");
      src.prepare("VACUUM INTO ?").run(tmp);
    } finally {
      src.close();
    }
    const check = new DatabaseSync(tmp);
    try {
      ok = !!check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'").get();
    } finally {
      check.close();
    }
  } catch {}
  if (ok) {
    try {
      fs.linkSync(tmp, dst); // never replaces: EEXIST means someone else won
      if (process.platform !== "win32") fs.chmodSync(dst, 0o600);
    } catch {
      ok = false;
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {}
  if (!ok) return;

  for (const f of [".token", "tokens.json", "spaces.json"]) {
    const a = path.join(from, f);
    const b = path.join(target, f);
    if (!isFile(a) || fs.existsSync(b)) continue;
    try {
      fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
      if (process.platform !== "win32") fs.chmodSync(b, 0o600);
    } catch {}
  }
  console.error(`[onememory] preinstall: copied your 1.0.x data from ${from} to ${target}`);
} catch {
} finally {
  process.exitCode = 0;
}
