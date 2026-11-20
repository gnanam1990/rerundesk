// Shared test harness: temp data dir, migrated DB, live HTTP server on an
// ephemeral port. Each test file runs in its own process under node --test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rerundesk-test-"));
  process.env.RERUNDESK_DATA = dir;
  const { openDb } = await import("../src/db.js");
  const { createServer, resetRoutes } = await import("../src/http.js");
  const { registerRoutes } = await import("../src/routes.js");
  const db = openDb(path.join(dir, "rerundesk.sqlite"));
  resetRoutes();
  registerRoutes();
  const server = createServer(db);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    db, server, dir,
    base: `http://127.0.0.1:${server.address().port}`,
    async reopenDb() {
      const { openDb: open } = await import("../src/db.js");
      return open(path.join(dir, "rerundesk.sqlite"));
    },
    close() { try { server.close(); db.close(); } catch {} },
  };
}

// Actors carry a provisioned credential token; `org`/`role` send the
// dev-fixture identity headers (rejected unless RERUNDESK_DEV_AUTH=1).
export async function api(base, { token, org, role, method = "GET", path, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h["authorization"] = `Bearer ${token}`;
  if (org) h["x-rd-org"] = org;
  if (role) h["x-rd-role"] = role;
  let payload;
  if (raw !== undefined) { payload = raw; }
  else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] = "application/json"; }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

export async function seedOrgs(base) {
  const m = await api(base, { method: "POST", path: "/v1/orgs",
    body: { name: "Maintainer Ops", kind: "both", evidence: { operator_domain: "ops.example" } } });
  const s = await api(base, { method: "POST", path: "/v1/orgs",
    body: { name: "Sponsor Co", kind: "sponsor", evidence: { operator_domain: "sponsor.example" } } });
  const w = await api(base, { method: "POST", path: "/v1/orgs",
    body: { name: "Worker LLC", kind: "worker", evidence: { operator_domain: "worker.example" } } });
  const maintainer = { token: m.body.bootstrap_credential };
  const sponsor = { token: s.body.bootstrap_credential };
  const worker = { token: w.body.bootstrap_credential };
  // Additional roles are provisioned server-side by the maintainer.
  const prov = (orgId, role) => api(base, { ...maintainer, method: "POST",
    path: `/v1/orgs/${orgId}/credentials`, body: { role } });
  const ev = await prov(m.body.org.id, "evaluator");
  const vw = await prov(s.body.org.id, "viewer");
  return {
    maintainer, sponsor, worker,
    evaluator: { token: ev.body.credential },
    viewer: { token: vw.body.credential },
    sponsorOrg: s.body.org.id, workerOrg: w.body.org.id, maintainerOrg: m.body.org.id,
  };
}

export const RECIPE_MANIFEST = (dataHash) => ({
  name: "accuracy-bench",
  image_digest: "sha256:" + "ab".repeat(32),
  entrypoint: "score-predictions",
  entrypoint_version: "1.0.0",
  data_hash: dataHash,
  license_ref: "CC0-1.0",
  hardware_class: "cpu-small",
  outputs: { predictions: "outputs/predictions.csv" },
});

export async function seedBenchmark(base, actors, { noise = 110, seedList = [42] } = {}) {
  const { buildDataset } = await import("../benchmark/fixtures.mjs");
  const ds = buildDataset(noise);
  const d = await api(base, { ...actors.maintainer, method: "POST",
    path: "/v1/datasets", body: ds });
  if (d.status !== 201) throw new Error("dataset intake failed: " + JSON.stringify(d.body));
  const r = await api(base, { ...actors.maintainer, method: "POST",
    path: "/v1/recipes", body: { manifest: RECIPE_MANIFEST(d.body.dataset.id) } });
  if (r.status !== 201 && r.status !== 200)
    throw new Error("recipe admission failed: " + JSON.stringify(r.body));
  const c = await api(base, { ...actors.sponsor, method: "POST", path: "/v1/claims",
    body: { recipe_hash: r.body.recipe.id, metric: "accuracy",
      evaluator_version: "accuracy-v1", reference: "0.900",
      absolute_tolerance: "0.010", seed_list: seedList,
      hardware_class: "cpu-small", units: "ratio" } });
  if (c.status !== 201) throw new Error("claim freeze failed: " + JSON.stringify(c.body));
  const o = await api(base, { ...actors.worker, method: "POST", path: "/v1/offers",
    body: { price_minor: 500, currency: "USD", ttl_seconds: 3600, capacity: 1 } });
  return {
    dataset: d.body.dataset, recipe: r.body.recipe, claim: c.body.claim,
    offer: o.body.offer, gold: ds.gold, samples: ds.samples,
  };
}

export async function reserveRun(base, actors, { claim_id, offer_id }, key = "k-" + Math.random().toString(36).slice(2)) {
  const res = await api(base, { ...actors.sponsor, method: "POST", path: "/v1/runs",
    body: { claim_id, offer_id, max_spend_minor: 1000 },
    headers: { "idempotency-key": key } });
  return { res, key };
}

export async function issueLease(base, actors, runId) {
  const res = await api(base, { ...actors.worker, method: "POST",
    path: `/v1/runs/${runId}/lease`, body: {} });
  if (res.status !== 201) throw new Error("lease failed: " + JSON.stringify(res.body));
  return res.body.lease;
}

export async function uploadAndSeal(base, actors, runId, token, files) {
  for (const f of files) {
    const res = await api(base, { ...actors.worker, method: "PUT",
      path: `/v1/runs/${runId}/artifacts?path=${encodeURIComponent(f.path)}`,
      raw: f.bytes, headers: { "x-rd-lease": token } });
    if (res.status !== 201) throw new Error("upload failed: " + JSON.stringify(res.body));
  }
  const manifest = { files: files.map((f) => ({
    path: f.path, sha256: f.sha256 ?? undefined })) };
  // Fill hashes from uploaded artifact list.
  const list = await api(base, { ...actors.worker,
    path: `/v1/runs/${runId}/artifacts` });
  manifest.files = list.body.artifacts.map((a) => ({ path: a.path, sha256: a.sha256 }));
  const seal = await api(base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${runId}/manifest`, body: manifest,
    headers: { "x-rd-lease": token } });
  return seal;
}

export function runtimeJson(overrides = {}) {
  return JSON.stringify({
    format: "rerundesk.runtime.v1", seed: 42, hardware_class: "cpu-small",
    image_digest: "sha256:" + "ab".repeat(32), metric: "accuracy",
    containment: "test", started_at: "2026-11-20T00:00:00Z",
    finished_at: "2026-11-20T00:00:01Z", exit_status: 0, ...overrides,
  });
}
