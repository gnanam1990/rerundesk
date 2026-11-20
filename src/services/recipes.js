// M01 — Recipe admission and provenance. Content-addressed manifests, image
// digest verification, fixed command catalog, licensed inputs only.
import { canonicalize, contentId } from "../canonical.js";
import { badRequest, notFound } from "../errors.js";
import {
  COMMAND_CATALOG, LICENSE_ALLOWLIST, HARDWARE_CLASSES,
} from "../catalog.js";
import { now } from "../db.js";

const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function validateRecipeManifest(m, db) {
  const reasons = [];
  if (!m || typeof m !== "object") reasons.push("manifest must be an object");
  if (reasons.length) return reasons;

  if (typeof m.name !== "string" || !m.name.trim())
    reasons.push("name: required string");
  if (typeof m.image_digest !== "string" || !IMAGE_DIGEST_RE.test(m.image_digest))
    reasons.push("image_digest: must be an immutable sha256:<64-hex> digest; tags are rejected");
  if (typeof m.entrypoint !== "string" || !(m.entrypoint in COMMAND_CATALOG))
    reasons.push(`entrypoint: must be one of ${Object.keys(COMMAND_CATALOG).join(", ")}`);
  else if (m.entrypoint_version !== COMMAND_CATALOG[m.entrypoint].version)
    reasons.push("entrypoint_version: does not match the reviewed catalog version");
  if (typeof m.data_hash !== "string" || !SHA256_RE.test(m.data_hash))
    reasons.push("data_hash: must be a 64-hex dataset content hash");
  else if (db && !db.prepare("SELECT id FROM datasets WHERE id = ?").get(m.data_hash))
    reasons.push("data_hash: no admitted dataset with this content hash");
  if (!LICENSE_ALLOWLIST.includes(m.license_ref))
    reasons.push("license_ref: missing or not on the admitted license list");
  if (!HARDWARE_CLASSES.includes(m.hardware_class))
    reasons.push(`hardware_class: must be one of ${HARDWARE_CLASSES.join(", ")}`);
  if (!m.outputs || typeof m.outputs.predictions !== "string" || !m.outputs.predictions)
    reasons.push("outputs.predictions: required bundle path for the metric output");
  if (m.model_digest !== undefined &&
      (typeof m.model_digest !== "string" || !SHA256_RE.test(m.model_digest)))
    reasons.push("model_digest: must be a 64-hex digest when present");
  return reasons;
}

export function admitRecipe(db, actor, manifest) {
  const reasons = validateRecipeManifest(manifest, db);
  const canon = canonicalize(manifest);
  const id = contentId(manifest);
  const existing = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id);
  if (existing) return { recipe: decorate(existing), created: false };

  const status = reasons.length ? "rejected" : "admitted";
  db.prepare(
    `INSERT INTO recipes(id, canonical_json, status, rejection_reasons_json,
       decided_by, decided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, canon, status,
        reasons.length ? JSON.stringify(reasons) : null,
        actor?.org_id ?? null, now(), now());
  const row = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id);
  const recipe = decorate(row);
  if (status === "rejected") {
    const e = badRequest("RECIPE_REJECTED", "recipe admission rejected", reasons);
    e.recipe = recipe;
    throw e;
  }
  return { recipe, created: true };
}

function decorate(row) {
  return {
    ...row,
    manifest: JSON.parse(row.canonical_json),
    rejection_reasons: row.rejection_reasons_json
      ? JSON.parse(row.rejection_reasons_json)
      : null,
  };
}

export function getRecipe(db, id) {
  const r = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id);
  if (!r) throw notFound("recipe not found");
  return decorate(r);
}

// INV-01 gate: only immutable admitted recipes may be scheduled.
export function requireSchedulable(db, recipeId) {
  const r = getRecipe(db, recipeId);
  if (r.status !== "admitted")
    throw badRequest("RECIPE_NOT_ADMITTED", `recipe ${recipeId} is not admitted`);
  return r;
}

export function listRecipes(db) {
  return db
    .prepare("SELECT id, status, created_at FROM recipes ORDER BY created_at")
    .all()
    .map((r) => ({ ...r, manifest: getRecipe(db, r.id).manifest }));
}
