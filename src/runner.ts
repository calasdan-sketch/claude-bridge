// OneMemory command runner: the half that makes remote control actually work.
//
// The note store is a mailbox. On its own, a command note dropped from a
// phone just sits there. This module is the listener that opens the mail:
// it polls a dedicated namespace, verifies each command, claims it so it can
// only ever run once, executes it, and writes the result back as a reply note
// the phone can read.
//
// Threat model is deliberately paranoid: the store is reachable over a public
// Cloudflare tunnel, so ANY note arriving here is treated as hostile input.
// Three independent gates must all pass before a single process is spawned:
//
//   1. SIGNATURE  -- HMAC-SHA256 over the canonical command fields, compared
//                    in constant time. An unsigned or mis-signed note is
//                    ignored. Holding a store write-token is NOT enough to
//                    execute anything; the runner secret is separate.
//   2. FRESHNESS  -- the command must be recent (default 5 min). An attacker
//                    who captures a valid signed note can't replay it tomorrow.
//   3. ALLOWLIST  -- the action must name a pre-declared entry. There is no
//                    "run this string" path: commands are never passed to a
//                    shell, argv is built from the allowlist, and any
//                    caller-supplied parameter must match that action's own
//                    regex. An unknown action is refused IN WRITING so the
//                    phone sees the refusal instead of silence.
//
// Everything below the gates is about not lying to the operator: claims are
// atomic (the store's compare-and-swap), results always get written (even on
// crash/timeout), and a heartbeat note says whether this loop is alive at all
// -- so "no reply" can be told apart from "PC is asleep".

import { execFile } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_ROOT } from "./config.js";
import { audit } from "./security.js";
import { Store, ValidationError, type NoteRecord } from "./store.js";

// ---- Tunables (all overridable by env; defaults are the safe end) ----------
export const RUNNER = {
  /** Namespace watched for inbound command notes. */
  namespace: process.env.ONEMEMORY_RUNNER_NAMESPACE || "commands",
  /** Namespace results are written to. */
  resultsNamespace: process.env.ONEMEMORY_RUNNER_RESULTS_NAMESPACE || "results",
  /** Seconds between polls. */
  pollMs: Number(process.env.ONEMEMORY_RUNNER_POLL_MS || 30_000),
  /** How old a signed command may be and still run. Replay defense. */
  freshnessMs: Number(process.env.ONEMEMORY_RUNNER_FRESHNESS_MS || 300_000),
  /** Hard ceiling on any single command's runtime. */
  timeoutMs: Number(process.env.ONEMEMORY_RUNNER_TIMEOUT_MS || 120_000),
  /** Heartbeat note refresh interval. */
  heartbeatMs: Number(process.env.ONEMEMORY_RUNNER_HEARTBEAT_MS || 180_000),
  /** Max characters of stdout/stderr kept in a result note. */
  outputChars: 20_000,
  /** Max command ids remembered in the replay ledger. */
  ledgerMax: 5_000,
  /** Most commands executed in a single poll pass. Overflow waits, not lost. */
  maxPerPoll: Number(process.env.ONEMEMORY_RUNNER_MAX_PER_POLL || 10),
  /** Flood ceiling: most commands executed per rolling window. */
  maxPerWindow: Number(process.env.ONEMEMORY_RUNNER_MAX_PER_WINDOW || 60),
  windowMs: Number(process.env.ONEMEMORY_RUNNER_WINDOW_MS || 600_000),
  /** Delete handled commands and results older than this. 0 disables. */
  retentionDays: Number(process.env.ONEMEMORY_RUNNER_RETENTION_DAYS || 30),
  /** Minimum gap between prune sweeps, regardless of heartbeat rate. */
  pruneEveryMs: Number(process.env.ONEMEMORY_RUNNER_PRUNE_EVERY_MS || 3_600_000),
};

/** Reserved action name: ask the PC what it is allowed to do. */
export const INTROSPECT_ACTION = "__actions";

export const CLAIMED_TAG = "claimed";
export const RESULT_TAG = "result";

// ---- Command shape ---------------------------------------------------------

export interface CommandEnvelope {
  cmd_id: string;
  action: string;
  params?: Record<string, string>;
  /**
   * Optional machine name this command is for. Empty = any listener. If you
   * ever run a second runner against the same store, this is what stops the
   * wrong PC answering -- and because it is inside the signature, an attacker
   * cannot re-point a captured command at a different machine.
   */
  target?: string;
  issued_at: string;
  nonce: string;
  sig: string;
}

/** This machine's runner name, matched against a command's `target`. */
export function runnerId(): string {
  return (
    process.env.ONEMEMORY_RUNNER_ID ||
    process.env.COMPUTERNAME ||
    process.env.HOSTNAME ||
    "default"
  );
}

export interface AllowEntry {
  /** Executable to run. Never passed through a shell. */
  file: string;
  /** Fixed arguments, always applied. */
  args?: string[];
  /**
   * Caller-supplied parameters this action accepts. Each maps to a regex the
   * value MUST fully match. A parameter not declared here is rejected -- this
   * is what stops `--upload-pack=...`-style argument injection through an
   * otherwise innocent action.
   */
  params?: Record<string, string>;
  /** Where the params land in argv, as `{name}` placeholders. */
  paramArgs?: string[];
  cwd?: string;
  timeoutMs?: number;
  description?: string;
}

export type Allowlist = Record<string, AllowEntry>;

// ---- Gate 1: signature -----------------------------------------------------

/**
 * Canonical bytes that get signed. Field order is fixed and params are
 * serialized with sorted keys, so the same logical command always produces
 * the same string regardless of JSON key order on the sender's side.
 * `sig` itself is excluded, obviously.
 */
export function canonicalString(cmd: Omit<CommandEnvelope, "sig">): string {
  const params = cmd.params ?? {};
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return [
    cmd.cmd_id,
    cmd.action,
    sortedParams,
    cmd.target ?? "",
    cmd.issued_at,
    cmd.nonce,
  ].join("\n");
}

export function signCommand(secret: string, cmd: Omit<CommandEnvelope, "sig">): string {
  return createHmac("sha256", secret).update(canonicalString(cmd), "utf8").digest("hex");
}

/** Constant-time hex compare; hashed first so length never leaks via timing. */
function sigEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// ---- Verification pipeline -------------------------------------------------

export type VerifyResult =
  | { ok: true; cmd: CommandEnvelope }
  | { ok: false; reason: string; cmd_id?: string };

/**
 * Parse + verify a note body. Returns a plain reason string on failure so the
 * caller can write it back to the operator rather than failing silently.
 * Note: a bad SIGNATURE is reported without echoing anything attacker-supplied
 * beyond the id, and the caller deliberately does not reply to unsigned notes.
 */
export function verifyCommand(
  secret: string,
  body: string,
  now: number = Date.now(),
  freshnessMs: number = RUNNER.freshnessMs
): VerifyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "body is not a command object" };
  }
  const c = parsed as Partial<CommandEnvelope>;
  for (const field of ["cmd_id", "action", "issued_at", "nonce", "sig"] as const) {
    if (typeof c[field] !== "string" || !c[field]) {
      return { ok: false, reason: `missing or empty field: ${field}` };
    }
  }
  if (c.params !== undefined) {
    if (typeof c.params !== "object" || Array.isArray(c.params)) {
      return { ok: false, reason: "params must be an object of string values", cmd_id: c.cmd_id };
    }
    for (const [k, v] of Object.entries(c.params)) {
      if (typeof v !== "string") {
        return { ok: false, reason: `param "${k}" must be a string`, cmd_id: c.cmd_id };
      }
    }
  }

  const cmd = c as CommandEnvelope;

  // Signature BEFORE freshness: never let unauthenticated input steer control
  // flow any further than it has to.
  const expected = signCommand(secret, {
    cmd_id: cmd.cmd_id,
    action: cmd.action,
    params: cmd.params,
    target: cmd.target,
    issued_at: cmd.issued_at,
    nonce: cmd.nonce,
  });
  if (!sigEqual(expected, cmd.sig)) {
    return { ok: false, reason: "bad signature", cmd_id: cmd.cmd_id };
  }

  const issued = Date.parse(cmd.issued_at);
  if (!Number.isFinite(issued)) {
    return { ok: false, reason: "issued_at is not a valid timestamp", cmd_id: cmd.cmd_id };
  }
  const age = now - issued;
  // Reject clearly-future timestamps too (small skew allowance), otherwise a
  // command dated next year would stay replayable forever.
  if (age > freshnessMs) {
    return { ok: false, reason: `command is stale (${Math.round(age / 1000)}s old)`, cmd_id: cmd.cmd_id };
  }
  if (age < -60_000) {
    return { ok: false, reason: "issued_at is in the future", cmd_id: cmd.cmd_id };
  }

  return { ok: true, cmd };
}

// ---- Gate 3: allowlist -----------------------------------------------------

export type ResolveResult =
  | { ok: true; file: string; args: string[]; cwd?: string; timeoutMs: number }
  | { ok: false; reason: string };

/** Turn an allowed action + validated params into a concrete argv. */
export function resolveAction(
  allow: Allowlist,
  action: string,
  params: Record<string, string> = {}
): ResolveResult {
  const entry = allow[action];
  if (!entry) {
    const known = Object.keys(allow).sort().join(", ") || "(none configured)";
    return { ok: false, reason: `action "${action}" is not allowed. Allowed actions: ${known}` };
  }

  const declared = entry.params ?? {};
  for (const name of Object.keys(params)) {
    if (!(name in declared)) {
      return { ok: false, reason: `action "${action}" does not accept a parameter named "${name}"` };
    }
  }
  for (const [name, pattern] of Object.entries(declared)) {
    const value = params[name];
    if (value === undefined) {
      return { ok: false, reason: `action "${action}" requires parameter "${name}"` };
    }
    // Anchored on both ends: a pattern like \w+ must match the WHOLE value,
    // so "repo; rm -rf /" can't sneak through on a partial match.
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${pattern})$`);
    } catch {
      return { ok: false, reason: `allowlist for "${action}" has an invalid pattern for "${name}"` };
    }
    if (!re.test(value)) {
      return { ok: false, reason: `parameter "${name}" does not match the allowed pattern` };
    }
  }

  const args = [...(entry.args ?? [])];
  for (const tpl of entry.paramArgs ?? []) {
    args.push(tpl.replace(/\{(\w+)\}/g, (_m, k: string) => params[k] ?? ""));
  }

  return {
    ok: true,
    file: entry.file,
    args,
    cwd: entry.cwd,
    timeoutMs: entry.timeoutMs ?? RUNNER.timeoutMs,
  };
}

/** Load the allowlist from env or disk. Missing file = no actions allowed. */
export function loadAllowlist(): Allowlist {
  const raw =
    process.env.ONEMEMORY_RUNNER_ALLOW ||
    (() => {
      const p = join(PROJECT_ROOT, "data", "runner-allow.json");
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    })();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Allowlist;
  } catch {
    console.error("[onememory:runner] ignoring allowlist: not valid JSON");
    return {};
  }
}

// ---- Replay ledger ---------------------------------------------------------
// Defense in depth behind the claim tag: the tag stops the SAME note running
// twice, the ledger stops the SAME cmd_id arriving again as a NEW note.

export class Ledger {
  private seen: string[] = [];
  private set = new Set<string>();
  constructor(private path: string, private max = RUNNER.ledgerMax) {
    try {
      if (existsSync(path)) {
        const arr = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (Array.isArray(arr)) {
          this.seen = arr.filter((x): x is string => typeof x === "string");
          this.set = new Set(this.seen);
        }
      }
    } catch {
      /* a corrupt ledger must not stop the runner; worst case we re-run once */
    }
  }
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.seen.push(id);
    while (this.seen.length > this.max) {
      const old = this.seen.shift();
      if (old) this.set.delete(old);
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.seen));
    } catch {
      /* best effort */
    }
  }
}

// ---- Single instance lock --------------------------------------------------

/** True if a process with this pid is alive (signal 0 = existence probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the runner lock. A stale lock (owner process gone) is reclaimed rather
 * than wedging the loop forever after an unclean shutdown.
 */
export function acquireLock(path: string): boolean {
  try {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return false;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(path: string): void {
  try {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) {
      unlinkSync(path);
    }
  } catch {
    /* ignore */
  }
}

// ---- Output handling -------------------------------------------------------

export function truncate(s: string, max = RUNNER.outputChars): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`;
}

export interface ExecOutcome {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

/**
 * Run an allowlisted command. shell:false is the whole point -- argv is passed
 * as an array, so no value can ever be interpreted as shell syntax. The child
 * gets a trimmed environment: the runner secret and the store token are
 * removed so an allowlisted script can't read the credentials that authorized
 * it.
 */
export function runCommand(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number }
): Promise<ExecOutcome> {
  const started = Date.now();
  // Scrub credential-shaped variables from the child's environment. An
  // allowlisted script has no business reading the secret that authorized it
  // -- and while we are at it, nor should it inherit unrelated API keys that
  // happen to be set on this machine. Narrow beats convenient here.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(^ONEMEMORY_(TOKEN|TOKENS|RUNNER_SECRET)$)|SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY/i.test(k)) {
      delete env[k];
    }
  }
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        windowsHide: true,
        env,
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; signal?: string }) | null;
        // Use the `killed` flag Node sets when IT enforced the timeout, rather
        // than inferring from elapsed time (which races on a slow machine).
        const killed = !!(e as (Error & { killed?: boolean }) | null)?.killed;
        const timedOut = killed;
        resolve({
          exit_code: typeof e?.code === "number" ? e.code : e ? 1 : 0,
          signal: e?.signal ?? null,
          stdout: truncate(String(stdout ?? "")),
          stderr: truncate(String(stderr ?? "") + (e && !stderr ? `\n${e.message}` : "")),
          duration_ms: Date.now() - started,
          timed_out: timedOut,
        });
      }
    );
  });
}

// ---- The loop ---------------------------------------------------------------

export interface RunnerDeps {
  store: Store;
  secret: string;
  allow: Allowlist;
  ledger: Ledger;
  now?: () => number;
  /** Timestamps of recent executions, for the flood ceiling. Managed here. */
  recent?: number[];
  /** Override this machine's name (tests, or multiple runners on one box). */
  runnerId?: string;
}

/**
 * Claim a note by bumping its rev with the store's compare-and-swap. Two
 * runners racing on the same store (or a restart mid-poll) cannot both win:
 * the loser's CAS fails and it skips the note. This reuses the existing
 * `ifRev` guard rather than inventing a second locking scheme.
 */
export function claimNote(store: Store, note: NoteRecord): boolean {
  if (note.tags.includes(CLAIMED_TAG)) return false;
  try {
    const updated = store.update(
      note.id,
      { tags: [...note.tags, CLAIMED_TAG] },
      { ifRev: note.rev }
    );
    return updated !== null;
  } catch (e) {
    // ValidationError here means another writer moved the note first -- that
    // is a lost race, not a fault.
    if (e instanceof ValidationError) return false;
    throw e;
  }
}

/** Write the outcome (or refusal) back where the phone can read it. */
export function writeResult(
  store: Store,
  cmdId: string,
  payload: Record<string, unknown>
): number | null {
  try {
    const note = store.create({
      namespace: RUNNER.resultsNamespace,
      title: `result ${cmdId}`,
      body: JSON.stringify(
        { cmd_id: cmdId, completed_at: new Date().toISOString(), ...payload },
        null,
        2
      ),
      tags: [RESULT_TAG, `cmd:${cmdId}`],
      source: "onememory-runner",
    });
    return note.id;
  } catch (e) {
    // A result that can't be stored (e.g. output tripped the secret scanner)
    // must still leave a trace, or the operator sees silence and assumes the
    // PC is down.
    const why = e instanceof Error ? e.message : String(e);
    try {
      const note = store.create({
        namespace: RUNNER.resultsNamespace,
        title: `result ${cmdId}`,
        body: JSON.stringify({ cmd_id: cmdId, error: `result could not be stored: ${why}` }),
        tags: [RESULT_TAG, `cmd:${cmdId}`],
        source: "onememory-runner",
      });
      return note.id;
    } catch {
      console.error(`[onememory:runner] could not write result for ${cmdId}: ${why}`);
      return null;
    }
  }
}

/**
 * Update an already-open result note, falling back to a fresh note if the
 * update fails. Used to close out a "running" note once the command finishes.
 */
export function closeResult(
  store: Store,
  noteId: number | null,
  cmdId: string,
  payload: Record<string, unknown>
): void {
  const body = JSON.stringify(
    { cmd_id: cmdId, completed_at: new Date().toISOString(), ...payload },
    null,
    2
  );
  if (noteId !== null) {
    try {
      if (store.update(noteId, { body }) !== null) return;
    } catch {
      /* fall through to writing a new note */
    }
  }
  writeResult(store, cmdId, payload);
}

/**
 * Answer the reserved introspection action: what may this PC be asked to do?
 * Worth having because the allowlist lives on the machine you are away from,
 * and guessing an action name just produces refusals.
 */
export function describeActions(allow: Allowlist): Record<string, unknown> {
  const actions = Object.entries(allow)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, e]) => ({
      action: name,
      description: e.description ?? "",
      params: Object.keys(e.params ?? {}),
    }));
  return { status: "ok", action: INTROSPECT_ACTION, actions, count: actions.length };
}

/**
 * Delete handled commands and results past the retention window. Without
 * this the namespaces grow forever, every poll pages through more history,
 * and a year from now the loop is reading thousands of dead notes.
 */
export function pruneOld(store: Store, days: number = RUNNER.retentionDays, now = Date.now()): number {
  if (!days || days <= 0) return 0;
  const cutoff = now - days * 86_400_000;
  const pageSize = 200;
  const maxPages = 100;
  const doomed: number[] = [];

  // list() returns NEWEST first, so the notes old enough to prune are at the
  // END of the namespace. An earlier version read only the first page and
  // stopped -- which meant retention quietly never deleted anything. Walk all
  // the way to the end, collect, then delete.
  for (const ns of [RUNNER.namespace, RUNNER.resultsNamespace]) {
    for (let page = 0; page < maxPages; page++) {
      const { notes, total } = store.list({
        namespace: ns,
        limit: pageSize,
        offset: page * pageSize,
      });
      if (notes.length === 0) break;
      for (const n of notes) {
        const handled = ns === RUNNER.resultsNamespace || n.tags.includes(CLAIMED_TAG);
        if (handled && Date.parse(n.updated_at) < cutoff) doomed.push(n.id);
      }
      if ((page + 1) * pageSize >= total) break;
    }
  }

  let removed = 0;
  for (const id of doomed) if (store.delete(id)) removed++;
  if (removed) audit({ op: "runner.prune", bytes: removed });
  return removed;
}

/** Process one note end-to-end. Exported so tests can drive it directly. */
export async function processNote(deps: RunnerDeps, note: NoteRecord): Promise<string> {
  const now = deps.now ?? Date.now;
  const verdict = verifyCommand(deps.secret, note.body, now(), RUNNER.freshnessMs);

  if (!verdict.ok) {
    // Claim it anyway so a junk/forged note isn't re-examined every 30s.
    claimNote(deps.store, note);
    audit({ op: "runner.reject", id: note.id, namespace: note.namespace });
    // Only answer notes that at least identified themselves. An unsigned blob
    // gets silence -- replying would turn the runner into an oracle an
    // attacker could probe.
    if (verdict.cmd_id && verdict.reason !== "bad signature") {
      writeResult(deps.store, verdict.cmd_id, { status: "rejected", reason: verdict.reason });
    }
    return `rejected: ${verdict.reason}`;
  }

  const cmd = verdict.cmd;

  // Addressed to a different machine: leave it alone entirely -- do not claim
  // it, or this runner would swallow a command meant for the other one.
  if (cmd.target && cmd.target !== (deps.runnerId ?? runnerId())) {
    return `skipped: addressed to ${cmd.target}`;
  }

  if (deps.ledger.has(cmd.cmd_id)) {
    claimNote(deps.store, note);
    audit({ op: "runner.replay", id: note.id });
    writeResult(deps.store, cmd.cmd_id, {
      status: "rejected",
      reason: "this command id has already been executed",
    });
    return "rejected: replay";
  }

  if (!claimNote(deps.store, note)) return "skipped: already claimed";
  // Record BEFORE running: if the machine dies mid-command we would rather
  // not run it a second time on restart.
  deps.ledger.add(cmd.cmd_id);

  // The reserved introspection action never executes anything -- it just
  // reports what this machine is willing to do.
  if (cmd.action === INTROSPECT_ACTION) {
    writeResult(deps.store, cmd.cmd_id, describeActions(deps.allow));
    return "ok: actions listed";
  }

  const resolved = resolveAction(deps.allow, cmd.action, cmd.params ?? {});
  if (!resolved.ok) {
    audit({ op: "runner.refuse", id: note.id });
    writeResult(deps.store, cmd.cmd_id, { status: "refused", reason: resolved.reason });
    return `refused: ${resolved.reason}`;
  }

  // Open the result note BEFORE spawning anything. If the PC loses power or
  // the process is killed mid-command, the operator still finds a note saying
  // "running since 14:02" instead of silence -- which, from another country,
  // is the difference between "it's working on it" and "my PC is dead".
  audit({ op: "runner.exec", id: note.id, namespace: note.namespace });
  const openId = writeResult(deps.store, cmd.cmd_id, {
    status: "running",
    action: cmd.action,
    started_at: new Date().toISOString(),
    pid: process.pid,
  });

  const outcome = await runCommand(resolved.file, resolved.args, {
    cwd: resolved.cwd,
    timeoutMs: resolved.timeoutMs,
  });
  closeResult(deps.store, openId, cmd.cmd_id, {
    status: outcome.timed_out ? "timed_out" : outcome.exit_code === 0 ? "ok" : "failed",
    action: cmd.action,
    ...outcome,
  });
  return outcome.exit_code === 0 ? "ok" : "failed";
}

/** One poll pass: oldest-first so commands run in the order they were sent. */
export async function pollOnce(deps: RunnerDeps): Promise<number> {
  // Page through the namespace rather than reading one window. list() is
  // newest-first AND claiming bumps updated_at, so handled notes crowd the
  // front: with a single 50-note window, a backlog would permanently hide
  // older pending commands and they would never run. Paging keeps the queue
  // fair no matter how much history has built up.
  const pageSize = 100;
  const maxPages = 20; // bounded so one poll can't run forever
  const pending: NoteRecord[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { notes, total } = deps.store.list({
      namespace: RUNNER.namespace,
      limit: pageSize,
      offset: page * pageSize,
    });
    if (notes.length === 0) break;
    for (const n of notes) if (!n.tags.includes(CLAIMED_TAG)) pending.push(n);
    if ((page + 1) * pageSize >= total) break;
  }
  pending.reverse(); // oldest first

  // Flood control. If the signing secret ever leaked, an attacker could queue
  // thousands of valid commands. Overflow is DEFERRED, not refused: a genuine
  // burst still runs, just across several polls, and nothing is silently lost.
  const now = (deps.now ?? Date.now)();
  deps.recent = (deps.recent ?? []).filter((t) => now - t < RUNNER.windowMs);
  const windowRoom = Math.max(0, RUNNER.maxPerWindow - deps.recent.length);
  const room = Math.min(RUNNER.maxPerPoll, windowRoom);
  if (pending.length > room) {
    console.error(
      `[onememory:runner] ${pending.length} commands pending, running ${room} this pass`
    );
  }
  const batch = pending.slice(0, room);

  let handled = 0;
  for (const note of batch) {
    deps.recent.push(now);
    try {
      await processNote(deps, note);
      handled++;
    } catch (e) {
      // One bad note must never kill the loop -- that would silently end
      // remote control until Dan next looks at the PC.
      console.error(`[onememory:runner] note ${note.id} failed:`, e);
    }
  }
  return handled;
}

/**
 * Heartbeat: a single note, updated in place, saying the loop is alive. This
 * is what lets the operator tell "PC ignored me" from "PC isn't listening".
 */
let heartbeatId: number | null = null;

export function beat(store: Store, startedAt: string): void {
  const title = "runner heartbeat";
  const body = JSON.stringify({
    alive_at: new Date().toISOString(),
    started_at: startedAt,
    pid: process.pid,
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown",
    poll_ms: RUNNER.pollMs,
  });
  try {
    // Cache the id. Re-scanning a window each beat would silently start
    // creating duplicate heartbeats once the namespace outgrew that window,
    // and duplicate heartbeats are worse than none -- you would not know
    // which one to trust.
    if (heartbeatId !== null && store.update(heartbeatId, { body }) !== null) return;
    const existing = store
      .list({ namespace: "runner", limit: 200 })
      .notes.find((n) => n.title === title);
    if (existing) {
      heartbeatId = existing.id;
      store.update(existing.id, { body });
    } else {
      heartbeatId = store.create({
        namespace: "runner",
        title,
        body,
        tags: ["heartbeat"],
        source: "onememory-runner",
      }).id;
    }
  } catch {
    /* a missed heartbeat must not stop command processing */
  }
}

/** Test seam: forget the cached heartbeat note. */
export function resetHeartbeat(): void {
  heartbeatId = null;
}

export interface StartedRunner {
  stop: () => void;
}

/** Start the polling loop. Returns a handle so callers/tests can stop it. */
export function startRunner(deps: RunnerDeps): StartedRunner {
  const startedAt = new Date().toISOString();
  let stopped = false;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (stopped || busy) return; // never overlap passes
    busy = true;
    try {
      await pollOnce(deps);
    } finally {
      busy = false;
    }
  };

  beat(deps.store, startedAt);
  const pollTimer = setInterval(() => void tick(), RUNNER.pollMs);
  // Prune on its own clock, not on every heartbeat. Heartbeats are every few
  // minutes; walking both namespaces to the end that often is wasted work on
  // a store with any history in it.
  let lastPrune = 0;
  const beatTimer = setInterval(() => {
    beat(deps.store, startedAt);
    const now = (deps.now ?? Date.now)();
    if (now - lastPrune < RUNNER.pruneEveryMs) return;
    lastPrune = now;
    try {
      pruneOld(deps.store);
    } catch (e) {
      console.error("[onememory:runner] prune failed:", e);
    }
  }, RUNNER.heartbeatMs);
  void tick();

  return {
    stop(): void {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(beatTimer);
    },
  };
}

/** Entry point for `npm run runner`. */
export function main(): void {
  const secret = process.env.ONEMEMORY_RUNNER_SECRET?.trim();
  if (!secret) {
    console.error(
      "[onememory:runner] refusing to start: ONEMEMORY_RUNNER_SECRET is not set.\n" +
        "Without it every note in the commands namespace would be unauthenticated input."
    );
    process.exit(1);
  }
  const allow = loadAllowlist();
  if (Object.keys(allow).length === 0) {
    console.error(
      "[onememory:runner] warning: no allowlisted actions. The runner will refuse everything " +
        "until data/runner-allow.json (or ONEMEMORY_RUNNER_ALLOW) names some."
    );
  }
  const lockPath = join(PROJECT_ROOT, "data", "runner.lock");
  if (!acquireLock(lockPath)) {
    console.error("[onememory:runner] another runner is already holding the lock; exiting.");
    process.exit(1);
  }
  const dbPath = process.env.ONEMEMORY_DB_PATH || join(PROJECT_ROOT, "data", "state.db");
  const store = new Store(dbPath);
  const ledger = new Ledger(join(PROJECT_ROOT, "data", "runner-seen.json"));
  const handle = startRunner({ store, secret, allow, ledger });

  const shutdown = (): void => {
    handle.stop();
    releaseLock(lockPath);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(
    `[onememory:runner] listening on namespace "${RUNNER.namespace}" every ${RUNNER.pollMs}ms ` +
      `(${Object.keys(allow).length} allowed action(s))`
  );
}

/** Helper for senders (phone/CLI): build a ready-to-post signed command. */
export function buildCommand(
  secret: string,
  action: string,
  params: Record<string, string> = {},
  target = ""
): CommandEnvelope {
  const base = {
    cmd_id: randomUUID(),
    action,
    params,
    target,
    issued_at: new Date().toISOString(),
    nonce: randomUUID(),
  };
  return { ...base, sig: signCommand(secret, base) };
}
