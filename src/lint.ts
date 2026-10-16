// Write-time memory linter.
//
// Every create/update/import is scanned before it reaches the store for two
// things an agent memory should never hold:
//
//   1. secrets      -- API keys, tokens, private keys, JWTs, high-entropy
//                      credentials (patterns live in security.ts so the old
//                      scanForSecrets() contract stays the single source).
//   2. injection    -- prompt-injection-style instructions planted for a
//                      later agent to obey ("ignore previous instructions",
//                      chat-template / system-prompt markers, tool-call
//                      coercion such as "... without telling the user").
//
// What happens on a hit is a policy, set by ONEMEMORY_LINT (read live):
//
//   block       refuse the write (ValidationError, HTTP 400)
//   quarantine  hold the write in the quarantine table; it is NOT a note,
//               so it is invisible to search / list / recall / export until
//               an admin approves it (memory_quarantine / onememory quarantine)
//   warn        store it and return the findings as `warnings`
//
// ONEMEMORY_LINT accepts one value for both categories ("warn"), or a
// per-category list ("secrets=block,injection=warn"). Default:
// secrets=block, injection=quarantine. Patterns are deliberately narrow:
// a false positive costs a user a confusing refusal, so every pattern needs
// an instruction-shaped context, not a single scary word.

import { scanForSecrets } from "./security.js";

export type LintCategory = "secret" | "injection";
export type LintAction = "block" | "quarantine" | "warn";

export interface LintFinding {
  category: LintCategory;
  /** Human label, e.g. "GitHub token" or "instruction override". */
  label: string;
  /** Which field matched: title, body, tags, or source. */
  field: string;
}

export interface LintPolicy {
  secret: LintAction;
  injection: LintAction;
}

export const DEFAULT_LINT_POLICY: LintPolicy = { secret: "block", injection: "quarantine" };

const ACTIONS: readonly LintAction[] = ["block", "quarantine", "warn"];

let warnedBadPolicy = false;

/**
 * Parse ONEMEMORY_LINT. Unknown values fall back to the default (with one
 * stderr warning) -- a typo must never silently disable the linter.
 */
export function lintPolicy(raw: string | undefined = process.env.ONEMEMORY_LINT): LintPolicy {
  const policy: LintPolicy = { ...DEFAULT_LINT_POLICY };
  if (!raw || !raw.trim()) return policy;
  const v = raw.trim().toLowerCase();
  if ((ACTIONS as readonly string[]).includes(v)) {
    return { secret: v as LintAction, injection: v as LintAction };
  }
  let ok = true;
  for (const part of v.split(",")) {
    const [k, a] = part.split("=").map((s) => s.trim());
    const key = k === "secrets" || k === "secret" ? "secret" : k === "injection" ? "injection" : null;
    if (!key || !(ACTIONS as readonly string[]).includes(a)) {
      ok = false;
      continue;
    }
    policy[key] = a as LintAction;
  }
  if (!ok && !warnedBadPolicy) {
    warnedBadPolicy = true;
    console.error(
      `[onememory] ONEMEMORY_LINT="${raw}" has unrecognized parts; using ` +
        `secrets=${policy.secret}, injection=${policy.injection}`
    );
  }
  return policy;
}

// Each pattern requires an instruction-shaped context. "ignore" alone, "you
// are now" alone, or "system:" alone never match.
const INJECTION_PATTERNS: Array<[string, RegExp]> = [
  [
    "instruction override",
    /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|my\s+)*(?:previous|prior|above|earlier|preceding|original|system|existing)\s+(?:instructions?|prompts?|directions|directives|rules|guidelines|guardrails|messages|context)\b/i,
  ],
  [
    "instruction override",
    /\b(?:ignore|disregard|forget)\s+(?:all\s+|everything\s+)?(?:you(?:'ve| have)?\s+been\s+told|your\s+(?:instructions|rules|guidelines|programming|training))\b/i,
  ],
  [
    "role reassignment",
    /\byou\s+are\s+now\s+(?:in\s+)?(?:(?:a|an|the)\s+)?(?:\w+\s+){0,2}(?:mode|assistant|ai|model|agent|bot|persona|jailbroken|unrestricted|unfiltered|dan)\b/i,
  ],
  [
    "role reassignment",
    /\b(?:enable|enter|activate|switch\s+to)\s+(?:developer|god|jailbreak|dan|unrestricted|admin)\s+mode\b/i,
  ],
  [
    "system-prompt marker",
    /<\|(?:im_start|im_end|system|endoftext|begin_of_text|start_header_id)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?system(?:-prompt)?>|^\s*#{2,}\s*(?:system|new\s+instructions?)\s*:?\s*$/im,
  ],
  [
    "system-prompt marker",
    /\b(?:new|updated|real|actual|hidden)\s+system\s+prompt\s*:/i,
  ],
  [
    "system-prompt exfiltration",
    /\b(?:reveal|print|output|repeat|leak|show)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|hidden\s+)?system\s+prompt\b/i,
  ],
  [
    "tool-call coercion",
    /<\/?(?:function_calls|antml:invoke|antml:function_calls|tool_use|tool_call)\b|<invoke\s+name=/i,
  ],
  [
    "tool-call coercion",
    /\b(?:without|before)\s+(?:asking|telling|informing|notifying|confirming\s+with|alerting)\s+(?:the\s+)?user\b|\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|notify|alert|mention\s+(?:this\s+)?to)\s+the\s+user\b/i,
  ],
  [
    "tool-call coercion",
    /\b(?:call|invoke|run|execute|use)\s+(?:the\s+)?[`'"]?(?:state_delete|state_write|memory_consolidate|memory_quarantine|memory_rebuild_edges)[`'"]?(?:\s+tool)?\s+(?:on\s+(?:every|all)|for\s+(?:every|all)|immediately|now\b|right\s+away)/i,
  ],
];

/** First injection label found in `text`, or null. */
export function scanForInjection(text: string | undefined): string | null {
  if (!text) return null;
  for (const [label, re] of INJECTION_PATTERNS) if (re.test(text)) return label;
  return null;
}

/**
 * Lint a note's free-text fields. Returns every finding (at most one per
 * category per field) so the caller can apply the policy and report them.
 */
export function lintContent(input: {
  title?: string;
  body?: string;
  tags?: string[];
  source?: string;
}): LintFinding[] {
  const fields: Array<[string, string | undefined]> = [
    ["title", input.title],
    ["body", input.body],
    ["tags", input.tags && input.tags.length ? input.tags.join(" ") : undefined],
    ["source", input.source],
  ];
  const out: LintFinding[] = [];
  for (const [field, text] of fields) {
    const s = scanForSecrets(text);
    if (s) out.push({ category: "secret", label: s, field });
    // Provenance labels are not instructions an agent reads as prose.
    if (field === "source") continue;
    const inj = scanForInjection(text);
    if (inj) out.push({ category: "injection", label: inj, field });
  }
  return out;
}

/** "GitHub token in body; instruction override in title" */
export function describeFindings(findings: LintFinding[]): string {
  return findings.map((f) => `${f.label} in ${f.field}`).join("; ");
}
