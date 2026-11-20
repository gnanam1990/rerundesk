// Licensed dataset intake (part of FR-01): content-addressed inputs and gold
// labels with license verification before any recipe may reference them.
import { canonicalize, sha256hex } from "../canonical.js";
import { putObject, readObject } from "../objectstore.js";
import { badRequest, notFound } from "../errors.js";
import { LICENSE_ALLOWLIST } from "../catalog.js";
import { now } from "../db.js";

export function registerDataset(db, actor, body) {
  const name = body?.name;
  const licenseRef = body?.license_ref;
  const samples = body?.samples;       // [{id, feature}]
  const gold = body?.gold;             // [{id, label}]
  if (typeof name !== "string" || !name.trim())
    throw badRequest("DATASET_NAME_REQUIRED", "dataset name required");
  if (!LICENSE_ALLOWLIST.includes(licenseRef))
    throw badRequest("LICENSE_NOT_ALLOWED", `license '${licenseRef}' is not admitted`, {
      allowlist: LICENSE_ALLOWLIST,
    });
  if (!Array.isArray(samples) || samples.length === 0)
    throw badRequest("SAMPLES_REQUIRED", "samples array required");
  if (!Array.isArray(gold) || gold.length !== samples.length)
    throw badRequest("GOLD_REQUIRED", "gold labels must cover every sample");

  const ids = samples.map((s) => s?.id);
  if (ids.some((i) => typeof i !== "string" || !i))
    throw badRequest("SAMPLE_ID_INVALID", "every sample needs a string id");
  if (new Set(ids).size !== ids.length)
    throw badRequest("SAMPLE_ID_DUPLICATE", "sample ids must be unique");
  const goldIds = new Set(gold.map((g) => g?.id));
  for (const id of ids)
    if (!goldIds.has(id)) throw badRequest("GOLD_MISSING", `gold label missing for ${id}`);

  const datasetBuf = Buffer.from(canonicalize({ samples }), "utf8");
  const goldBuf = Buffer.from(canonicalize({ gold }), "utf8");
  const datasetSha = putObject(db, datasetBuf, "dataset");
  const goldSha = putObject(db, goldBuf, "gold");

  const descriptor = {
    format: "rerundesk.dataset.v1",
    name: name.trim(),
    license_ref: licenseRef,
    sample_count: samples.length,
    dataset_sha256: datasetSha,
    gold_sha256: goldSha,
    sample_ids_sha256: sha256hex(canonicalize([...ids].sort())),
  };
  const id = sha256hex(canonicalize(descriptor));
  const existing = db.prepare("SELECT id FROM datasets WHERE id = ?").get(id);
  if (existing) return getDataset(db, id);
  db.prepare(
    `INSERT INTO datasets(id, name, license_ref, descriptor_json, dataset_sha256,
       gold_sha256, sample_count, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, descriptor.name, licenseRef, canonicalize(descriptor),
        datasetSha, goldSha, samples.length, actor?.org_id ?? null, now());
  return getDataset(db, id);
}

export function getDataset(db, id) {
  const d = db.prepare("SELECT * FROM datasets WHERE id = ?").get(id);
  if (!d) throw notFound("dataset not found");
  return { ...d, descriptor: JSON.parse(d.descriptor_json) };
}

export function loadGoldLabels(db, datasetId) {
  const d = getDataset(db, datasetId);
  const buf = readObject(db, d.gold_sha256);
  const { gold } = JSON.parse(buf.toString("utf8"));
  const map = new Map();
  for (const g of gold) map.set(g.id, g.label);
  return map;
}

export function loadSampleIds(db, datasetId) {
  const d = getDataset(db, datasetId);
  const buf = readObject(db, d.dataset_sha256);
  const { samples } = JSON.parse(buf.toString("utf8"));
  return samples.map((s) => s.id);
}

export function listDatasets(db) {
  return db
    .prepare("SELECT id, name, license_ref, sample_count, created_at FROM datasets ORDER BY created_at")
    .all();
}
