// T-013 / T-014 — Report, settlement and repeatability (+ INV-07, NFR-01).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeApp, api, seedOrgs, seedBenchmark, reserveRun, issueLease,
  uploadAndSeal, runtimeJson,
} from "./helpers.mjs";

const files = (preds, runtime = {}) => [
  { path: "outputs/predictions.csv", bytes: Buffer.from(preds) },
  { path: "runtime.json", bytes: Buffer.from(runtimeJson(runtime)) },
  { path: "logs/run.log", bytes: Buffer.from("[test] run\n") },
];

async function fullRun(app, actors, bench, key, preds) {
  const { res } = await reserveRun(app.base, actors,
    { claim_id: bench.claim.id, offer_id: bench.offer.id }, key);
  const run = res.body.run;
  const lease = await issueLease(app.base, actors, run.id);
  await uploadAndSeal(app.base, actors, run.id, lease.token, files(preds));
  const ev = await api(app.base, { ...actors.evaluator, method: "POST",
    path: `/v1/runs/${run.id}/evaluate` });
  return { run, evaluation: ev.body.evaluation };
}

test("T-013: divergence packet; independent re-evaluation returns same verdict", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors, { noise: 110 });
  const { predictionsMatching } = await import("../benchmark/fixtures.mjs");

  const { run, evaluation } = await fullRun(app, actors, bench, "m07-a",
    predictionsMatching(bench.gold, 889));
  assert.equal(evaluation.outcome, "diverged");

  // Download the packet as the sponsor.
  const rep = await api(app.base, { ...actors.sponsor, path: `/v1/runs/${run.id}/report` });
  assert.equal(rep.status, 200);
  const r = rep.body.report;
  assert.equal(r.evaluation.outcome, "diverged");
  assert.equal(r.evaluation.observed_decimal, "0.889");
  assert.ok(r.reproduction.manifest_hash);
  assert.equal(r.reproduction.artifacts.length, 3);
  assert.ok(r.timeline.length >= 3);
  assert.ok(Array.isArray(r.cost_history));
  assert.equal(r.independence.independently_operated, true);
  assert.equal(r.independence.independence_status, "enrolled");

  // Independent re-evaluation: recompute on the sealed bundle via a fresh DB
  // handle (post-restart) — same metric and outcome, deterministically.
  const db2 = await app.reopenDb();
  const { evaluateRun } = await import("../src/services/evaluate.js");
  const again = evaluateRun(db2, { org_id: actors.maintainerOrg, role: "evaluator" }, run.id);
  assert.equal(again.outcome, "diverged");
  assert.equal(again.observed_decimal, "0.889");
  db2.close();
});

test("T-014: unconfirmed payment is not settled; missing identity evidence is not independent", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors, { noise: 110 });
  const { predictionsMatching } = await import("../benchmark/fixtures.mjs");

  // Worker org with no identity evidence enrolled.
  const bare = await api(app.base, { method: "POST", path: "/v1/orgs",
    body: { name: "Ghost LLC", kind: "worker", evidence: {} } });
  const ghost = { org: bare.body.org.id, role: "worker" };
  const goffer = await api(app.base, { ...ghost, method: "POST", path: "/v1/offers",
    body: { price_minor: 300, currency: "USD", ttl_seconds: 3600 } });

  const { res } = await reserveRun(app.base, actors,
    { claim_id: bench.claim.id, offer_id: goffer.body.offer.id }, "m07-b");
  const run = res.body.run;

  // Before any capture, settlement reports the honest ledger state.
  const rep1 = await api(app.base, { ...actors.sponsor, path: `/v1/runs/${run.id}/report` });
  assert.notEqual(rep1.body.report.settlement.status, "captured");
  assert.equal(rep1.body.report.settlement.status, "authorized");
  assert.match(rep1.body.report.settlement.note, /not a verified external payment/);

  // Independence is only as strong as recorded proof: ghost worker shows
  // 'unknown', never 'independent' or 'attested'.
  assert.equal(rep1.body.report.independence.independence_status, "unknown");
  assert.match(rep1.body.report.independence.how_checked, /unknown = no evidence recorded/);

  // Even with a sealed bundle and a verdict, a payment the provider cannot
  // confirm stays 'unconfirmed' — never 'settled'/'captured'.
  const lease = await issueLease(app.base, { ...actors, worker: ghost }, run.id);
  await uploadAndSeal(app.base, { ...actors, worker: ghost }, run.id, lease.token,
    files(predictionsMatching(bench.gold, 890)));
  await api(app.base, { ...actors.evaluator, method: "POST",
    path: `/v1/runs/${run.id}/evaluate` });
  app.db.prepare(
    "UPDATE ledger SET status = 'pending_external' WHERE run_id = ?").run(run.id);
  const rep2 = await api(app.base, { ...actors.sponsor, path: `/v1/runs/${run.id}/report` });
  assert.equal(rep2.body.report.evaluation.outcome, "reproduced");
  assert.equal(rep2.body.report.settlement.status, "unconfirmed");
  assert.notEqual(rep2.body.report.settlement.status, "captured");
});

test("M07: viewer receives the redacted packet; tenant outsider is denied", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors, { noise: 110 });
  const { predictionsMatching } = await import("../benchmark/fixtures.mjs");
  const { run } = await fullRun(app, actors, bench, "m07-c",
    predictionsMatching(bench.gold, 890));

  const rep = await api(app.base, { ...actors.viewer, path: `/v1/runs/${run.id}/report` });
  assert.equal(rep.status, 200);
  assert.equal(rep.body.report.evaluation.outcome, "reproduced");
  // Redacted: no reverify internals, org entries reduced to ids/status.
  assert.equal(rep.body.report.reproduction.reverify_command, undefined);
  assert.equal(rep.body.report.independence.worker_org.name, undefined);
  assert.equal(rep.body.report.independence.sponsor_org.name, undefined);

  // A sponsor from an unrelated org is denied.
  const outsider = await api(app.base, { method: "POST", path: "/v1/orgs",
    body: { name: "Other", kind: "sponsor", evidence: {} } });
  const deny = await api(app.base, { org: outsider.body.org.id, role: "sponsor",
    path: `/v1/runs/${run.id}/report` });
  assert.equal(deny.status, 404);
});
