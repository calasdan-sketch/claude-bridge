// Browser-side command signer, used by sign.html.
//
// This is plain JS with no build step so it runs straight off a phone, and it
// uses WebCrypto, which both browsers and Node provide. Your runner secret is
// used here and nowhere else -- it is never sent to the store, only the
// resulting signature is.
//
// The canonical format MUST stay identical to canonicalString() in
// src/runner.ts. A parity test in test/signer-parity.test.ts imports both and
// fails if they ever drift, because a silent mismatch would show up as every
// command being ignored with no explanation.

/** Exactly the field order and joining used by the runner. */
export function canonicalString(cmd) {
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

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signCommand(secret, cmd) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(canonicalString(cmd)));
  return toHex(sig);
}

export async function buildCommand(secret, action, params = {}, target = "") {
  const base = {
    cmd_id: crypto.randomUUID(),
    action,
    params,
    target,
    issued_at: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };
  return { ...base, sig: await signCommand(secret, base) };
}
