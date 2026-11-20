// M06 — Deterministic comparison. Pinned metric, exact decimal arithmetic,
// distinct reason codes for non-comparable evidence. Verdict is independent
// of worker payment status (INV-06, INV-07).
import { parseDecimal, withinTolerance, absDifference, observedScaled, formatDecimal } from "../decimal.js";
import { artifactBytes, sealedManifest, listArtifacts } from "./artifacts.js";
import { getRun, setRunState, recordEvent } from "./runs.js";
import { getClaim, evaluatorDigest, EVALUATOR_VERSION } from "./claims.js";
import { loadGoldLabels, loadSampleIds } from "./datasets.js";
import { conflict, unprocessable, HttpError } from "../errors.js";
import { now, txn } from "../db.js";

function parsePredictionsCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split(",").map((h) => h.trim());
  const idIdx = header.indexOf("id");
  const labelIdx = header.indexOf("label");
  const seedIdx = header.indexOf("seed");
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    rows.push({
      id: cols[idIdx]?.trim(),
      label: labelIdx >= 0 ? cols[labelIdx]?.trim() : undefined,
      seed: seedIdx >= 0 ? Number(cols[seedIdx]) : undefined,
    });
  }
  return { header, rows, hasSeed: seedIdx >= 0, hasLabel: labelIdx >= 0 };
}

function compareIdSets(expectedIds, rows) {
  const expected = new Set(expectedIds);
  const seen = new Map();
  const unexpected = [];
  for (const r of rows) {
    if (!expected.has(r.id)) { unexpected.push(r.id); continue; }
    seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  return { complete: !missing.length && !duplicates.length && !unexpected.length,
           missing, duplicates, unexpected };
}

function aggregate(scaledValues, mode) {
  if (scaledValues.length === 1) return scaledValues[0];
  const sorted = [...scaledValues].sort((a, b) => (a < b ? -1 : 1));
  switch (mode) {
    case "mean": return sorted.reduce((a, b) => a + b, 0n) / BigInt(sorted.length);
    case "min": return sorted[0];
    case "median": {
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
    }
    default: throw new Error(`unknown aggregation ${mode}`);
  }
}

function finish(db, run, evaluation) {
  txn(db, () => {
    db.prepare(
      `INSERT INTO evaluations(run_id, manifest_hash, observed_decimal,
         observed_fraction, outcome, reason_code, explanation,
         evaluator_version, evaluator_digest, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         manifest_hash = excluded.manifest_hash,
         observed_decimal = excluded.observed_decimal,
         observed_fraction = excluded.observed_fraction,
         outcome = excluded.outcome,
         reason_code = excluded.reason_code,
         explanation = excluded.explanation,
         evaluated_at = excluded.evaluated_at`
    ).run(run.id, evaluation.manifest_hash, evaluation.observed_decimal ?? null,
          evaluation.observed_fraction ?? null, evaluation.outcome,
          evaluation.reason_code ?? null, evaluation.explanation,
          EVALUATOR_VERSION, evaluatorDigest(), now());
    setRunState(db, run.id, "evaluated", evaluation.outcome);
    recordEvent(db, run.id, null, "run.evaluated", {
      outcome: evaluation.outcome, reason_code: evaluation.reason_code ?? null,
      observed: evaluation.observed_decimal ?? null,
    });
  });
  return db.prepare("SELECT * FROM evaluations WHERE run_id = ?").get(run.id);
}

export function evaluateRun(db, actor, runId) {
  const run = getRun(db, runId);
  if (!["artifacts_received", "evaluated"].includes(run.state))
    throw conflict("RUN_STATE", `run state '${run.state}' cannot be evaluated`);

  const sealed = sealedManifest(db, runId);
  if (!sealed)
    throw conflict("MANIFEST_MISSING", "no sealed manifest bound to this run");
  if (sealed.epoch !== run.attempt)
    throw conflict("EPOCH_MISMATCH",
      "sealed epoch does not match the run's accepted attempt");

  const claim = getClaim(db, run.claim_id);
  if (claim.evaluator_digest !== evaluatorDigest())
    throw conflict("EVALUATOR_CHANGED",
      "evaluator implementation differs from the digest frozen in the claim");

  const files = new Map(sealed.manifest.files.map((f) => [f.path, f.sha256]));
  const fail = (reason_code, explanation) =>
    finish(db, run, { manifest_hash: sealed.manifest_hash, outcome: "inconclusive",
                      reason_code, explanation });

  // Runtime metadata gates: seed, hardware, metric, image (FR-06).
  if (!files.has("runtime.json"))
    return fail("missing_evidence", "runtime.json is absent from the sealed bundle");
  const runtime = JSON.parse(
    artifactBytes(db, runId, sealed.epoch, "runtime.json").bytes.toString("utf8"));
  if (!claim.seed_list.includes(runtime.seed))
    return fail("bad_seed",
      `runtime seed ${runtime.seed} is not in the predeclared seed list [${claim.seed_list}]`);
  if (runtime.hardware_class !== claim.hardware_class)
    return fail("incompatible_hardware",
      `runtime hardware '${runtime.hardware_class}' != claim '${claim.hardware_class}'`);
  if (runtime.metric !== undefined && runtime.metric !== claim.metric)
    return fail("metric_mismatch",
      `bundle declares metric '${runtime.metric}' but the claim froze '${claim.metric}'`);
  const recipe = db.prepare("SELECT canonical_json FROM recipes WHERE id = ?").get(run.recipe_id);
  const recipeManifest = JSON.parse(recipe.canonical_json);
  if (runtime.image_digest && runtime.image_digest !== recipeManifest.image_digest)
    return fail("image_mismatch", "runtime image digest differs from the pinned recipe");

  const predPath = recipeManifest.outputs.predictions;
  if (!files.has(predPath))
    return fail("missing_evidence", `predictions artifact '${predPath}' is absent`);

  const expectedIds = loadSampleIds(db, claim.terms.data_hash);
  const gold = loadGoldLabels(db, claim.terms.data_hash);
  const csv = parsePredictionsCsv(
    artifactBytes(db, runId, sealed.epoch, predPath).bytes.toString("utf8"));
  if (!csv.hasLabel)
    return fail("missing_evidence", "predictions file lacks a 'label' column");

  const refScaled = parseDecimal(claim.terms.reference_decimal, "reference");
  const tolScaled = parseDecimal(claim.terms.absolute_tolerance, "tolerance");
  const seeds = claim.seed_list;

  // Multi-seed claims evaluate each predeclared seed then aggregate.
  const perSeed = new Map();
  if (seeds.length > 1 || csv.hasSeed) {
    if (!csv.hasSeed)
      return fail("missing_evidence",
        "multi-seed claim requires a 'seed' column in predictions");
    for (const r of csv.rows) {
      if (!seeds.includes(r.seed))
        return fail("bad_seed", `predictions carry undeclared seed ${r.seed}`);
      if (!perSeed.has(r.seed)) perSeed.set(r.seed, []);
      perSeed.get(r.seed).push(r);
    }
    for (const s of seeds)
      if (!perSeed.has(s))
        return fail("missing_evidence", `no predictions submitted for seed ${s}`);
  } else {
    perSeed.set(seeds[0], csv.rows);
  }

  const scaled = [];
  const fractions = [];
  let totalCorrect = 0, totalRows = 0;
  for (const [seed, rows] of perSeed) {
    const cmp = compareIdSets(expectedIds, rows);
    if (!cmp.complete) {
      const parts = [];
      if (cmp.missing.length) parts.push(`${cmp.missing.length} missing ids`);
      if (cmp.duplicates.length) parts.push(`${cmp.duplicates.length} duplicate ids`);
      if (cmp.unexpected.length) parts.push(`${cmp.unexpected.length} unexpected ids`);
      return fail("output_incomplete",
        `seed ${seed}: submission is not a complete bijection over the frozen ` +
        `dataset ids (${parts.join("; ")})`);
    }
    let correct = 0;
    for (const r of rows) if (String(r.label) === String(gold.get(r.id))) correct++;
    totalCorrect += correct;
    totalRows += rows.length;
    scaled.push(observedScaled(correct, rows.length));
    fractions.push(`${correct}/${rows.length}`);
  }

  const observed = seeds.length > 1
    ? aggregate(scaled, claim.aggregation)
    : scaled[0];
  // Exact boundary check: single-seed uses exact rational compare; multi-seed
  // compares the aggregated scaled value against reference.
  const reproduced = seeds.length === 1
    ? withinTolerance(totalCorrect, totalRows, refScaled, tolScaled)
    : (() => {
        const d = observed > refScaled ? observed - refScaled : refScaled - observed;
        return d <= tolScaled;
      })();

  const observedStr = formatDecimal(observed, 3);
  const refStr = claim.terms.reference_decimal;
  const diffScaled = seeds.length === 1
    ? absDifference(totalCorrect, totalRows, refScaled)
    : (observed > refScaled ? observed - refScaled : refScaled - observed);
  const diffStr = formatDecimal(diffScaled, 3);
  const tolStr = claim.terms.absolute_tolerance;
  const explanation = reproduced
    ? `observed ${observedStr} vs reference ${refStr}: absolute difference ` +
      `${diffStr} is within tolerance ${tolStr}`
    : `observed ${observedStr} vs reference ${refStr}: absolute difference ` +
      `${diffStr} exceeds tolerance ${tolStr}`;

  return finish(db, run, {
    manifest_hash: sealed.manifest_hash,
    observed_decimal: observedStr,
    observed_fraction: fractions.join("+"),
    outcome: reproduced ? "reproduced" : "diverged",
    reason_code: null,
    explanation,
  });
}

export function getEvaluation(db, runId) {
  return db.prepare("SELECT * FROM evaluations WHERE run_id = ?").get(runId) ?? null;
}
