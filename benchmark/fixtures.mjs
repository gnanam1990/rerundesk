// Deterministic benchmark fixtures for the canonical acceptance scenario.
// 1000 samples; gold labels equal the recipe's prediction except at `noise`
// positions (a fixed seeded selection), so measured accuracy = (1000-noise)/1000.
import crypto from "node:crypto";

export const SAMPLE_COUNT = 1000;
export const CLASSES = 7;

function noisePositions(noise, seedStr) {
  const picked = new Set();
  let i = 0;
  while (picked.size < noise) {
    const h = crypto.createHash("sha256").update(`${seedStr}:${i}`).digest();
    picked.add(h.readUInt32BE(0) % SAMPLE_COUNT);
    i++;
  }
  return picked;
}

export function buildDataset(noise, name = `accuracy-bench-${1000 - noise}of1000`) {
  const noiseSet = noisePositions(noise, name);
  const samples = [];
  const gold = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const id = "s" + String(i).padStart(4, "0");
    const feature = i % CLASSES;
    samples.push({ id, feature });
    gold.push({ id, label: noiseSet.has(i) ? (feature + 1) % CLASSES : feature });
  }
  return { name, license_ref: "CC0-1.0", samples, gold };
}

export function predictionsCsv(samples, { wrongIds = new Set(), omitIds = new Set(), dupIds = [] } = {}) {
  const lines = ["id,label"];
  for (const s of samples) {
    if (omitIds.has(s.id)) continue;
    lines.push(`${s.id},${wrongIds.has(s.id) ? (s.feature + 1) % CLASSES : s.feature}`);
  }
  for (const id of dupIds) lines.push(`${id},0`);
  return lines.join("\n") + "\n";
}

// Predictions scored exactly `correctCount` against the gold labels:
// first N ids match gold, the rest are deliberately wrong. Deterministic.
export function predictionsMatching(gold, correctCount, { omitIds = new Set(), dupId = null } = {}) {
  const lines = ["id,label"];
  let n = 0;
  for (const g of gold) {
    if (omitIds.has(g.id)) { n++; continue; }
    const label = n < correctCount ? g.label : (g.label + 1) % CLASSES;
    lines.push(`${g.id},${label}`);
    n++;
  }
  if (dupId) lines.push(`${dupId},0`);
  return lines.join("\n") + "\n";
}
