// T-011 / T-012 — Deterministic comparison (+ INV-06).
// Reference 0.900, tolerance 0.010, seed 42. 890/1000 -> reproduced (diff
// 0.010, boundary inclusive). 889/1000 -> diverged (diff 0.011). Incomplete
// or non-bijective outputs -> inconclusive, never a numeric verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeApp, api, seedOrgs, seedBenchmark, reserveRun, issueLease,
  uploadAndSeal, runtimeJson,
} from "./helpers.mjs";

async function evaluatedRun(app, actors, bench, key, files, evalActor) {
  const { res } = await reserveRun(app.base, actors,
    { claim_id: bench.claim.id, offer_id: bench.offer.id }, key);
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const run = res.body.run;
  const lease = await issueLease(app.base, actors, run.id);
  const seal = await uploadAndSeal(app.base, actors, run.id, lease.token, files);
  if (seal.status !== 200) throw new Error("seal: " + JSON.stringify(seal.body));
  const ev = await api(app.base, { ...evalActor, method: "POST",
    path: `/v1/runs/${run.id}/evaluate` });
  return { run, seal, ev };
}

const files = (preds, runtime = {}) => [
  { path: "outputs/predictions.csv", bytes: Buffer.from(preds) },
  { path: "runtime.json", bytes: Buffer.from(runtimeJson(runtime)) },
  { path: "logs/run.log", bytes: Buffer.from("[test] run\n") },
];

test("T-011: 890/1000 within 0.010 reproduces; 889/1000 diverges", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors, { noise: 110 });
  const { predictionsMatching } = await import("../benchmark/fixtures.mjs");

  const a = await evaluatedRun(app, actors, bench, "m06-a",
    files(predictionsMatching(bench.gold, 890)), actors.evaluator);
  assert.equal(a.ev.status, 200, JSON.stringify(a.ev.body));
  assert.equal(a.ev.body.evaluation.outcome, "reproduced");
  assert.equal(a.ev.body.evaluation.observed_decimal, "0.890");
  assert.match(a.ev.body.evaluation.explanation, /0\.010 is within tolerance/);

  // Second run on the same claim with one more wrong answer diverges.
  const offer2 = await api(app.base, { ...actors.worker, method: "POST",
    path: "/v1/offers", body: { price_minor: 500, currency: "USD", ttl_seconds: 3600 } });
  const bench2 = { ...bench, offer: offer2.body.offer };
  const b = await evaluatedRun(app, actors, bench2, "m06-b",
    files(predictionsMatching(bench.gold, 889)), actors.evaluator);
  assert.equal(b.ev.body.evaluation.outcome, "diverged");
  assert.equal(b.ev.body.evaluation.observed_decimal, "0.889");
  assert.match(b.ev.body.evaluation.explanation, /0\.011 exceeds tolerance/);
});

test("T-012: 999/1000 rows and duplicate-with-missing are inconclusive", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors, { noise: 110 });
  const { predictionsMatching } = await import("../benchmark/fixtures.mjs");

  // 999 output rows for 1000 expected ids.
  const missing1 = predictionsMatching(bench.gold, 1000, { omitIds: new Set(["s0999"]) });
  const a = await evaluatedRun(app, actors, bench, "m06-c", files(missing1), actors.evaluator);
  assert.equal(a.ev.body.evaluation.outcome, "inconclusive");
  assert.equal(a.ev.body.evaluation.reason_code, "output_incomplete");
  assert.match(a.ev.body.evaluation.explanation, /1 missing ids/);

  // 1000 rows with one duplicate and one missing expected id.
  const dup = predictionsMatching(bench.gold, 1000, { omitIds: new Set(["s0999"]), dupId: "s0000" });
  const offer2 = await api(app.base, { ...actors.worker, method: "POST",
    path: "/v1/offers", body: { price_minor: 500, currency: "USD", ttl_seconds: 3600 } });
  const b = await evaluatedRun(app, actors, { ...bench, offer: offer2.body.offer }, "m06-d",
    files(dup), actors.evaluator);
  assert.equal(b.ev.body.evaluation.outcome, "inconclusive");
  assert.equal(b.ev.body.evaluation.reason_code, "output_incomplete");
  assert.match(b.ev.body.evaluation.explanation, /duplicate/);
});

test("M06: distinct reason codes for bad seed, metric and hardware mismatch", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors, { noise: 110 });
  const { predictionsMatching } = await import("../benchmark/fixtures.mjs");
  const preds = () => predictionsMatching(bench.gold, 890);

  const offer = async () => (await api(app.base, { ...actors.worker, method: "POST",
    path: "/v1/offers", body: { price_minor: 500, currency: "USD", ttl_seconds: 3600 } })).body.offer;

  const bad = await evaluatedRun(app, actors, { ...bench, offer: await offer() }, "m06-e",
    files(preds(), { seed: 99 }), actors.evaluator);
  assert.equal(bad.ev.body.evaluation.reason_code, "bad_seed");

  const hw = await evaluatedRun(app, actors, { ...bench, offer: await offer() }, "m06-f",
    files(preds(), { hardware_class: "gpu-large" }), actors.evaluator);
  assert.equal(hw.ev.body.evaluation.reason_code, "incompatible_hardware");

  const mm = await evaluatedRun(app, actors, { ...bench, offer: await offer() }, "m06-g",
    files(preds(), { metric: "f1" }), actors.evaluator);
  assert.equal(mm.ev.body.evaluation.reason_code, "metric_mismatch");

  // Verdict is independent of settlement: captured payment on the inconclusive
  // runs still shows the bundle was delivered and paid for its evidence.
  const led = app.db.prepare(
    "SELECT kind, status FROM ledger WHERE run_id = ?").all(bad.run.id);
  assert.ok(led.some((r) => r.kind === "capture" && r.status === "captured"));
});
