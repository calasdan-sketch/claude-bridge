// Threshold sweep for the edge-similarity metric (I-HIGH-1).
//
// Scores every hand-labeled pair in pairs.mjs with TF-IDF cosine (IDF from
// all 300 texts as the corpus — mirroring production, where IDF comes from
// the namespace's own notes), then sweeps the edge threshold 0.15–0.60 and
// reports precision / recall / F1 per threshold.
//
// A "minimum support" floor is applied before scoring: pairs sharing fewer
// than MIN_SHARED_TOKENS_FOR_EDGE content tokens score 0 outright. A single
// shared token is the exact junk-edge mode raw-TF cosine had at 0.35, and
// the floor holds even when the corpus is too small for IDF to discriminate.
//
// Run: npm run build && node reviews/tier2-threshold-sweep/sweep.mjs
// Writes: results.json next to this file.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  precomputeTfMaps,
  computeDocFreqs,
  cosineTfIdf,
  sharedTokenCount,
  MIN_SHARED_TOKENS_FOR_EDGE,
} from "../../dist/src/consolidate.js";
import { PAIRS } from "./pairs.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Corpus: every text in the set (a-side and b-side), deduped. Production
// computes IDF per namespace over that namespace's notes; this is the
// closest offline analogue.
const texts = [...new Set(PAIRS.flatMap((p) => [p.a, p.b]))];
const tfMaps = precomputeTfMaps(texts.map((t, i) => ({ id: i, title: t, body: "" })));
const df = computeDocFreqs(tfMaps.values());
const docCount = texts.length;

const byText = new Map(texts.map((t, i) => [t, tfMaps.get(i)]));

const scored = PAIRS.map((p, i) => {
  const ta = byText.get(p.a), tb = byText.get(p.b);
  // Minimum-support floor, mirroring production edge scoring: a pair needs
  // >= MIN_SHARED_TOKENS_FOR_EDGE shared content tokens to earn an edge.
  const shared = sharedTokenCount(ta, tb);
  const score = shared >= MIN_SHARED_TOKENS_FOR_EDGE ? cosineTfIdf(ta, tb, df, docCount) : 0;
  return { i, label: p.label, score, shared };
});

// Panel probes, for the report narrative.
const probe = (needle) => {
  const hit = PAIRS.findIndex((p) => p.a.includes(needle));
  return hit >= 0 ? scored[hit].score : null;
};
console.log(`pairs: ${PAIRS.length} (pos ${PAIRS.filter((p) => p.label === 1).length}, neg ${PAIRS.filter((p) => p.label === 0).length}), corpus docs: ${docCount}`);
console.log(`probe "Dentist appointment" vs "see dentist thursday": ${probe("Dentist appointment").toFixed(3)} (TF-IDF; raw TF was 0.408)`);

const rows = [];
for (let t = 0.15; t <= 0.6001; t += 0.05) {
  const thr = Math.round(t * 100) / 100;
  let tp = 0, fp = 0, fn = 0;
  for (const s of scored) {
    const pred = s.score + 1e-9 >= thr ? 1 : 0;
    if (pred === 1 && s.label === 1) tp++;
    else if (pred === 1) fp++;
    else if (s.label === 1) fn++;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  rows.push({ threshold: thr, tp, fp, fn, precision, recall, f1 });
}

console.log("\nthreshold |   TP  FP  FN |  prec   rec    F1");
for (const r of rows) {
  console.log(
    `   ${r.threshold.toFixed(2)}   | ${String(r.tp).padStart(4)}${String(r.fp).padStart(4)}${String(r.fn).padStart(4)} | ` +
    `${r.precision.toFixed(3)} ${r.recall.toFixed(3)} ${r.f1.toFixed(3)}` +
    (r.f1 === Math.max(...rows.map((x) => x.f1)) ? "  <-- max F1" : "")
  );
}

// Pick the F1 knee: highest F1; ties break toward the HIGHER threshold
// (fewer noisy edges — precision is cheaper than recall for a graph that
// an agent will traverse).
const best = rows.reduce((a, b) => (b.f1 > a.f1 + 1e-9 || (Math.abs(b.f1 - a.f1) <= 1e-9 && b.threshold > a.threshold) ? b : a));
console.log(`\nselected threshold: ${best.threshold.toFixed(2)} (F1 ${best.f1.toFixed(3)}, P ${best.precision.toFixed(3)}, R ${best.recall.toFixed(3)})`);

// Sanity on the failure modes the metric cannot fix (documented limits).
const zeroScorePositives = scored.filter((s) => s.label === 1 && s.score === 0).length;
console.log(`positive pairs scoring exactly 0 (no shared tokens — beyond any token metric): ${zeroScorePositives}`);

writeFileSync(
  join(here, "results.json"),
  JSON.stringify({ pairs: PAIRS.length, corpusDocs: docCount, minSharedTokens: MIN_SHARED_TOKENS_FOR_EDGE, rows, selected: best.threshold, zeroScorePositives }, null, 2) + "\n"
);
console.log("wrote results.json");
