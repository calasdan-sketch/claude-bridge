// onememory recall — Claude Code SessionStart hook.
// Prints the most recent notes as a hook JSON payload so the agent gets
// memory context before its first message. Designed to FAIL SILENT:
// any failure (missing/corrupt DB, timeout, thrown error) resolves to a
// valid JSON payload with empty additionalContext and exit code 0 — a
// broken DB must never break session start.
//
// Recency is the recall signal for session start; no embeddings involved.
import type { NoteRecord } from "./store.js";

export const RECALL_HARD_TIMEOUT_MS = 5000; // never block session start
export const RECALL_MAX_CHARS = 8000; // keep the hook payload compact
const BODY_SNIPPET_CHARS = 200;

export interface RecallOptions {
  /** Soft budget in ms (default 800). Exceeding it returns what we have. */
  budgetMs?: number;
  /** Max notes to include (default 10). */
  limit?: number;
  /** Override DB path (config DB_PATH is used when omitted). Test hook. */
  dbPath?: string;
}

/**
 * Pure function: notes -> the human-readable summary injected as
 * hookSpecificOutput.additionalContext.
 */
export function buildSummary(notes: NoteRecord[]): string {
  if (notes.length === 0) return "";
  const lines = notes.map((n) => {
    const title = collapse(n.title);
    const snippet = collapse(n.body).slice(0, BODY_SNIPPET_CHARS);
    return `- [${title}]${snippet ? ": " + snippet : ""}`;
  });
  let text =
    `Recent memory (${notes.length} note${notes.length === 1 ? "" : "s"}):\n` +
    lines.join("\n");
  if (text.length > RECALL_MAX_CHARS) {
    text = text.slice(0, RECALL_MAX_CHARS - 1) + "…";
  }
  return text;
}

function collapse(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/**
 * Exact output shape Claude Code requires for SessionStart hooks.
 */
export function buildHookOutput(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  });
}

/**
 * Best-effort server-side namespace resolution. A parallel branch may add
 * src/namespace.ts with a resolveNamespace() export; if it isn't there (or
 * throws), we recall across all namespaces. Never rejects.
 */
async function tryResolveNamespace(): Promise<string | undefined> {
  try {
    // String variable (not a literal) so tsc does not require the file to
    // exist — the parallel namespace branch may not be merged yet.
    const specifier: string = "./namespace.js";
    const mod = (await import(specifier)) as {
      resolveNamespace?: () => string | Promise<string> | undefined;
    };
    if (typeof mod.resolveNamespace === "function") {
      const ns = await mod.resolveNamespace();
      if (typeof ns === "string" && ns.trim()) return ns.trim();
    }
  } catch {
    // namespace.ts not present on this branch — recall unscoped.
  }
  return undefined;
}

async function fetchRecentNotes(opts: RecallOptions): Promise<NoteRecord[]> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const limit = clampInt(opts.limit ?? 10, 10, 1, 100);
  const namespace = await tryResolveNamespace();
  const store = new Store(opts.dbPath ?? DB_PATH);
  try {
    return store.list({ namespace, limit }).notes;
  } finally {
    store.close();
  }
}

function clampInt(v: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * Fail-silent wrapper. ALWAYS resolves to the hook JSON on stdout-ready
 * text, exit code is the caller's concern (the CLI forces 0). Never throws;
 * stderr logging only.
 */
export async function runRecall(opts: RecallOptions = {}): Promise<string> {
  try {
    const started = Date.now();
    const budgetMs = opts.budgetMs ?? 800;

    const timer = new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), RECALL_HARD_TIMEOUT_MS);
      // Don't let the hard-timeout timer hold the process open after
      // we've already printed.
      (t as unknown as { unref?: () => void }).unref?.();
    });

    const notes = await Promise.race([fetchRecentNotes(opts), timer]);
    if (notes === null) {
      console.error("onememory recall: hard timeout, returning empty context");
      return buildHookOutput("");
    }
    const elapsed = Date.now() - started;
    if (elapsed > budgetMs && budgetMs > 0) {
      // Soft budget exceeded after the fetch; keep it simple and return
      // what we have — recency fetch is one cheap query.
      console.error(`onememory recall: budget ${budgetMs}ms exceeded (${elapsed}ms)`);
    }
    return buildHookOutput(buildSummary(notes));
  } catch (e) {
    console.error("onememory recall failed: " + (e as Error).message);
    return buildHookOutput("");
  }
}
