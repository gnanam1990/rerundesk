// T-009 / T-010 — Artifact reception and verification (+ INV-05).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256hex } from "../src/canonical.js";
import {
  makeApp, api, seedOrgs, seedBenchmark, reserveRun, issueLease, runtimeJson,
} from "./helpers.mjs";

async function leasedRun(app, actors, bench, key) {
  const { res } = await reserveRun(app.base, actors,
    { claim_id: bench.claim.id, offer_id: bench.offer.id }, key);
  const lease = await issueLease(app.base, actors, res.body.run.id);
  return { run: res.body.run, lease };
}

const bundle = (preds) => [
  { path: "outputs/predictions.csv", bytes: Buffer.from(preds) },
  { path: "runtime.json", bytes: Buffer.from(runtimeJson()) },
  { path: "logs/run.log", bytes: Buffer.from("[test] run\n") },
];

test("T-009: upload a chunk twice, then seal the same manifest once", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors);
  const { run, lease } = await leasedRun(app, actors, bench, "m05-a");

  const { predictionsMatching } = await import("../benchmark/fixtures.mjs");
  const preds = predictionsMatching(bench.gold, 890);
  const files = bundle(preds);

  // First upload.
  const up1 = await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/artifacts?path=${files[0].path}&sha256=${sha256hex(files[0].bytes)}`,
    raw: files[0].bytes, headers: { "x-rd-lease": lease.token } });
  assert.equal(up1.status, 201);
  assert.equal(up1.body.deduplicated, false);
  // Same bytes again -> deduplicated idempotent resume.
  const up2 = await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/artifacts?path=${files[0].path}&sha256=${sha256hex(files[0].bytes)}`,
    raw: files[0].bytes, headers: { "x-rd-lease": lease.token } });
  assert.equal(up2.status, 201);
  assert.equal(up2.body.deduplicated, true);

  for (const f of files.slice(1)) {
    const r = await api(app.base, { ...actors.worker, method: "PUT",
      path: `/v1/runs/${run.id}/artifacts?path=${f.path}`,
      raw: f.bytes, headers: { "x-rd-lease": lease.token } });
    assert.equal(r.status, 201);
  }

  const list = await api(app.base, { ...actors.worker, path: `/v1/runs/${run.id}/artifacts` });
  const manifest = { files: list.body.artifacts.map((a) => ({ path: a.path, sha256: a.sha256 })) };
  const seal = await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/manifest`, body: manifest,
    headers: { "x-rd-lease": lease.token } });
  assert.equal(seal.status, 200);
  assert.ok(seal.body.manifest_hash);

  // A second seal is refused: the lease is closed and the epoch is accepted.
  const seal2 = await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/manifest`, body: manifest,
    headers: { "x-rd-lease": lease.token } });
  assert.equal(seal2.status, 409);
  const count = app.db.prepare("SELECT COUNT(*) n FROM manifests WHERE run_id = ?").get(run.id).n;
  assert.equal(count, 1);

  const runAfter = app.db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id);
  assert.equal(runAfter.state, "artifacts_received");
});

test("T-010: path escape, oversized log and modified bytes are rejected", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors);
  const { run, lease } = await leasedRun(app, actors, bench, "m05-b");

  // Path escaping the bundle root.
  for (const bad of ["../evil.txt", "outputs/../../etc/passwd", "/abs.txt", "a\\b"]) {
    const r = await api(app.base, { ...actors.worker, method: "PUT",
      path: `/v1/runs/${run.id}/artifacts?path=${encodeURIComponent(bad)}`,
      raw: Buffer.from("x"), headers: { "x-rd-lease": lease.token } });
    assert.equal(r.status, 400, `path ${bad} should be rejected`);
  }

  // Oversized log (>1 MiB).
  const big = Buffer.alloc(1024 * 1024 + 1, 65);
  const r2 = await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/artifacts?path=logs/run.log`,
    raw: big, headers: { "x-rd-lease": lease.token } });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error.code, "ARTIFACT_TOO_LARGE");

  // Declared digest does not match the bytes actually sent.
  const payload = Buffer.from("real-bytes");
  const r3 = await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/artifacts?path=runtime.json&sha256=${sha256hex(Buffer.from("other"))}`,
    raw: payload, headers: { "x-rd-lease": lease.token } });
  assert.equal(r3.status, 409);
  assert.equal(r3.body.error.code, "DIGEST_MISMATCH");

  // Different bytes at the same path are a conflict — no silent overwrite.
  await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/artifacts?path=runtime.json`,
    raw: Buffer.from("v1"), headers: { "x-rd-lease": lease.token } });
  const r4 = await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/artifacts?path=runtime.json`,
    raw: Buffer.from("v2-modified"), headers: { "x-rd-lease": lease.token } });
  assert.equal(r4.status, 409);
  assert.equal(r4.body.error.code, "ARTIFACT_CONFLICT");
});
