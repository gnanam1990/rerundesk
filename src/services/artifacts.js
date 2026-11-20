// M05 — Artifact reception and verification. Bounded bundle, path
// normalization, digest recompute, atomic manifest seal (INV-05).
import { canonicalize, sha256hex, contentId } from "../canonical.js";
import { putObject, readObject } from "../objectstore.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { LIMITS, COMMAND_CATALOG } from "../catalog.js";
import { now, txn } from "../db.js";
import { getRun, setRunState, recordEvent } from "./runs.js";
import { getRecipe } from "./recipes.js";
import { validateLeaseToken, reapLease } from "./leases.js";
import * as ledger from "./ledger.js";

export function normalizeArtifactPath(p) {
  if (typeof p !== "string" || !p.length) throw badRequest("PATH_INVALID", "path required");
  if (p.length > 256) throw badRequest("PATH_TOO_LONG", "path too long");
  if (p.includes("\0") || p.includes("\\"))
    throw badRequest("PATH_INVALID", "illegal characters in path");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p))
    throw badRequest("PATH_ABSOLUTE", "absolute paths are not allowed");
  const parts = p.split("/");
  if (parts.some((seg) => seg === "" || seg === "." || seg === ".."))
    throw badRequest("PATH_ESCAPE", "path escapes the bundle root");
  return parts.join("/");
}

function sizeLimitFor(path) {
  return path.startsWith("logs/") ? LIMITS.maxLogBytes : LIMITS.maxArtifactBytes;
}

export function uploadArtifact(db, actor, runId, { path, sha256, body: bytes }, token, nowIso = now()) {
  const run = getRun(db, runId);
  const lease = validateLeaseToken(db, actor, runId, token, nowIso);
  const normPath = normalizeArtifactPath(path);
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes ?? "");
  const limit = sizeLimitFor(normPath);
  if (bytes.length === 0) throw badRequest("ARTIFACT_EMPTY", "artifact body is empty");
  if (bytes.length > limit)
    throw badRequest("ARTIFACT_TOO_LARGE",
      `artifact exceeds the ${limit}-byte limit for its class`);

  const actual = sha256hex(bytes);
  if (sha256 && sha256 !== actual)
    throw conflict("DIGEST_MISMATCH",
      `declared sha256 ${sha256} does not match recomputed ${actual}`);

  const existing = db.prepare(
    "SELECT * FROM artifacts WHERE run_id = ? AND epoch = ? AND path = ?"
  ).get(runId, lease.epoch, normPath);
  if (existing) {
    if (existing.sha256 === actual) return { artifact: existing, deduplicated: true };
    throw conflict("ARTIFACT_CONFLICT",
      "a different byte stream already occupies this path");
  }

  const total = db.prepare(
    "SELECT COALESCE(SUM(size),0) s FROM artifacts WHERE run_id = ? AND epoch = ?"
  ).get(runId, lease.epoch).s;
  if (total + bytes.length > LIMITS.maxBundleBytes)
    throw badRequest("BUNDLE_TOO_LARGE", "bundle size budget exceeded");

  const hash = putObject(db, bytes, "artifact");
  db.prepare(
    `INSERT INTO artifacts(run_id, epoch, path, sha256, size, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(runId, lease.epoch, normPath, hash, bytes.length, nowIso);
  recordEvent(db, runId, actor, "artifact.uploaded",
    { epoch: lease.epoch, path: normPath, sha256: hash });
  return {
    artifact: db.prepare(
      "SELECT * FROM artifacts WHERE run_id = ? AND epoch = ? AND path = ?"
    ).get(runId, lease.epoch, normPath),
    deduplicated: false,
  };
}

export function requiredArtifacts(recipe) {
  const entry = COMMAND_CATALOG[recipe.manifest.entrypoint];
  const produced = new Set(entry.producedArtifacts);
  produced.add(recipe.manifest.outputs.predictions);
  return [...produced];
}

export function sealManifest(db, actor, runId, manifestBody, token, nowIso = now()) {
  const run = getRun(db, runId);
  const lease = validateLeaseToken(db, actor, runId, token, nowIso);
  const files = manifestBody?.files;
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.maxManifestFiles)
    throw badRequest("MANIFEST_FILES", "manifest must declare 1..64 files");

  const declared = new Map();
  for (const f of files) {
    const p = normalizeArtifactPath(f?.path);
    if (typeof f?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256))
      throw badRequest("MANIFEST_DIGEST", `file ${p}: sha256 must be 64-hex`);
    if (declared.has(p)) throw badRequest("MANIFEST_DUP", `duplicate path ${p}`);
    declared.set(p, f.sha256);
  }

  const stored = db.prepare(
    "SELECT * FROM artifacts WHERE run_id = ? AND epoch = ?"
  ).all(runId, lease.epoch);
  const storedMap = new Map(stored.map((a) => [a.path, a]));
  for (const [p, hash] of declared) {
    const row = storedMap.get(p);
    if (!row) throw conflict("ARTIFACT_MISSING", `declared file ${p} was not uploaded`);
    if (row.sha256 !== hash)
      throw conflict("DIGEST_MISMATCH", `file ${p}: stored digest differs from manifest`);
    // Recompute from object store bytes — never trust recorded metadata.
    const buf = readObject(db, row.sha256);
    if (sha256hex(buf) !== hash)
      throw conflict("DIGEST_MISMATCH", `file ${p}: object bytes failed re-verification`);
  }
  const undeclared = stored.filter((a) => !declared.has(a.path));
  if (undeclared.length)
    throw badRequest("MANIFEST_INCOMPLETE",
      `uploaded files missing from manifest: ${undeclared.map((a) => a.path).join(", ")}`);

  const recipe = getRecipe(db, run.recipe_id);
  const missing = requiredArtifacts(recipe).filter((p) => !declared.has(p));
  if (missing.length)
    throw badRequest("REQUIRED_MISSING",
      `required artifacts missing: ${missing.join(", ")}`);

  const manifest = {
    format: "rerundesk.manifest.v1",
    run_id: runId,
    epoch: lease.epoch,
    claim_id: run.claim_id,
    recipe_id: run.recipe_id,
    files: [...declared.entries()].sort().map(([path, sha256]) => ({ path, sha256 })),
  };
  const manifestHash = contentId(manifest);
  const canon = canonicalize(manifest);

  txn(db, () => {
    db.prepare(
      `INSERT INTO manifests(run_id, epoch, manifest_hash, manifest_json,
         sealed_by, sealed_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(runId, lease.epoch, manifestHash, canon,
          `${actor.org_id}:${actor.role}`, nowIso);
    db.prepare("UPDATE leases SET status = 'closed' WHERE id = ?").run(lease.id);
    setRunState(db, runId, "artifacts_received");
    // Evidence terms met: capture payment for delivered verified bundle.
    // Settlement is independent of the evaluation verdict (INV-07).
    ledger.capture(db, runId, `bundle sealed at epoch ${lease.epoch}`);
    recordEvent(db, runId, actor, "manifest.sealed",
      { epoch: lease.epoch, manifest_hash: manifestHash });
  });
  return { manifest_hash: manifestHash, epoch: lease.epoch };
}

export function sealedManifest(db, runId) {
  const m = db.prepare("SELECT * FROM manifests WHERE run_id = ?").get(runId);
  if (!m) return null;
  return { ...m, manifest: JSON.parse(m.manifest_json) };
}

export function artifactBytes(db, runId, epoch, path) {
  const row = db.prepare(
    "SELECT * FROM artifacts WHERE run_id = ? AND epoch = ? AND path = ?"
  ).get(runId, epoch, path);
  if (!row) throw notFound(`artifact ${path} not found`);
  return { row, bytes: readObject(db, row.sha256) };
}

export function listArtifacts(db, runId, epoch) {
  return db.prepare(
    "SELECT path, sha256, size, uploaded_at FROM artifacts WHERE run_id = ? AND epoch = ? ORDER BY path"
  ).all(runId, epoch);
}
