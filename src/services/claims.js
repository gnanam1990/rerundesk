// M02 — Claims and comparison contract. A claim freezes evaluator, units,
// seeds, tolerance, baseline and hardware before procurement. The claim id is
// the content hash, so any rule change (e.g. tolerance) yields a new claim and
// can never rewrite an active run (INV-02).
import { createHash } from "node:crypto";
import fs from "node:fs";
import { canonicalize, contentId } from "../canonical.js";
import { parseDecimal, formatDecimal, SCALE } from "../decimal.js";
import { badRequest, notFound } from "../errors.js";
import { METRICS, AGGREGATIONS, HARDWARE_CLASSES } from "../catalog.js";
import { requireSchedulable } from "./recipes.js";
import { now } from "../db.js";

export const EVALUATOR_NAME = "accuracy";
export const EVALUATOR_VERSION = "accuracy-v1";

// Digest of the evaluator implementation pinned into every claim.
export function evaluatorDigest() {
  const file = new URL("./evaluate.js", import.meta.url);
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function freezeClaim(db, actor, body) {
  const recipe = requireSchedulable(db, body?.recipe_hash);
  const manifest = recipe.manifest;

  if (!METRICS.includes(body?.metric))
    throw badRequest("METRIC_UNKNOWN", `metric must be one of ${METRICS.join(", ")}`);
  if (body?.evaluator_version !== EVALUATOR_VERSION)
    throw badRequest("EVALUATOR_VERSION", `evaluator_version must be '${EVALUATOR_VERSION}'`);

  let refScaled, tolScaled;
  try {
    refScaled = parseDecimal(body?.reference, "reference");
  } catch (e) { throw badRequest("REFERENCE_INVALID", e.message); }
  try {
    tolScaled = parseDecimal(body?.absolute_tolerance, "absolute_tolerance");
  } catch (e) { throw badRequest("TOLERANCE_INVALID", e.message); }
  if (tolScaled < 0n) throw badRequest("TOLERANCE_NEGATIVE", "absolute_tolerance must be >= 0");
  if (refScaled < 0n) throw badRequest("REFERENCE_NEGATIVE", "reference must be >= 0");

  const seeds = body?.seed_list;
  if (!Array.isArray(seeds) || seeds.length === 0 || !seeds.every((s) => Number.isInteger(s)))
    throw badRequest("SEED_LIST_INVALID", "seed_list must be a non-empty array of integers");
  const seedList = [...seeds].sort((a, b) => a - b);

  let aggregation = body?.aggregation ?? null;
  if (seedList.length > 1) {
    if (!aggregation)
      throw badRequest("AGGREGATION_REQUIRED", "multi-seed claims must declare aggregation");
    if (!AGGREGATIONS.includes(aggregation))
      throw badRequest("AGGREGATION_INVALID", `aggregation must be one of ${AGGREGATIONS.join(", ")}`);
  } else if (aggregation !== null && !AGGREGATIONS.includes(aggregation)) {
    throw badRequest("AGGREGATION_INVALID", `aggregation must be one of ${AGGREGATIONS.join(", ")}`);
  }

  const hardware = body?.hardware_class;
  if (!HARDWARE_CLASSES.includes(hardware))
    throw badRequest("HARDWARE_INVALID", `hardware_class must be one of ${HARDWARE_CLASSES.join(", ")}`);
  if (hardware !== manifest.hardware_class)
    throw badRequest("HARDWARE_MISMATCH", "claim hardware must match the recipe hardware_class");

  const units = body?.units ?? "ratio";
  if (typeof units !== "string" || !units) throw badRequest("UNITS_INVALID", "units required");

  const claim = {
    recipe_hash: recipe.id,
    data_hash: manifest.data_hash,
    metric: body.metric,
    evaluator_version: EVALUATOR_VERSION,
    evaluator_digest: evaluatorDigest(),
    reference_decimal: formatDecimal(refScaled, decimalPlaces(body.reference)),
    absolute_tolerance: formatDecimal(tolScaled, decimalPlaces(body.absolute_tolerance)),
    seed_list: seedList,
    hardware_class: hardware,
    aggregation,
    units,
  };
  const id = contentId(claim);
  const existing = db.prepare("SELECT * FROM claims WHERE id = ?").get(id);
  if (existing) return { claim: decorate(existing), created: false };

  db.prepare(
    `INSERT INTO claims(id, canonical_json, recipe_hash, metric, evaluator_version,
       evaluator_digest, reference_decimal, absolute_tolerance, seed_list_json,
       hardware_class, aggregation, units, sponsor_org_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, canonicalize(claim), recipe.id, claim.metric, claim.evaluator_version,
        claim.evaluator_digest, claim.reference_decimal, claim.absolute_tolerance,
        JSON.stringify(seedList), hardware, aggregation, units, actor.org_id, now());
  return { claim: getClaim(db, id), created: true };
}

function decimalPlaces(v) {
  const s = String(v);
  const i = s.indexOf(".");
  return i < 0 ? 0 : Math.min(18, s.length - i - 1);
}

function decorate(row) {
  return { ...row, terms: JSON.parse(row.canonical_json), seed_list: JSON.parse(row.seed_list_json) };
}

export function getClaim(db, id) {
  const c = db.prepare("SELECT * FROM claims WHERE id = ?").get(id);
  if (!c) throw notFound("claim not found");
  return decorate(c);
}

export function claimRefScaled(claim) {
  return parseDecimal(claim.terms.reference_decimal, "reference");
}
export function claimTolScaled(claim) {
  return parseDecimal(claim.terms.absolute_tolerance, "absolute_tolerance");
}
export { SCALE };
