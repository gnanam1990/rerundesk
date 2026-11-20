// T-005 / T-006 — Worker enrollment and purchase (+ INV-03).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, api, seedOrgs, seedBenchmark, reserveRun } from "./helpers.mjs";

async function setup() {
  const app = await makeApp();
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors);
  return { app, actors, bench };
}

test("T-005: eligible worker gets one funded run after repeated idempotent POST", async (t) => {
  const { app, actors, bench } = await setup();
  t.after(() => app.close());

  const first = await reserveRun(app.base, actors, { claim_id: bench.claim.id, offer_id: bench.offer.id }, "fixed-key-1");
  assert.equal(first.res.status, 201);
  const runId = first.res.body.run.id;
  assert.equal(first.res.body.run.state, "authorized");

  // Identical retry returns the stored operation reference — no second run.
  const retry = await reserveRun(app.base, actors, { claim_id: bench.claim.id, offer_id: bench.offer.id }, "fixed-key-1");
  assert.equal(retry.res.status, 200);
  assert.equal(retry.res.body.run.id, runId);
  assert.equal(retry.res.body.replayed, true);

  const list = await api(app.base, { ...actors.sponsor, path: "/v1/runs" });
  assert.equal(list.body.runs.length, 1);

  // Ledger shows exactly one reservation bound to the run.
  const rows = app.db.prepare("SELECT * FROM ledger WHERE run_id = ?").all(runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "reservation");
  assert.equal(rows[0].status, "authorized");
  assert.equal(rows[0].amount_minor, 500);

  // A different payload under the same key is a conflict.
  const clash = await api(app.base, { ...actors.sponsor, method: "POST",
    path: "/v1/runs", headers: { "idempotency-key": "fixed-key-1" },
    body: { claim_id: bench.claim.id, offer_id: bench.offer.id, max_spend_minor: 999 } });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, "IDEMPOTENCY_CONFLICT");
});

test("T-006: expired quote and self-enrolled sponsor worker are rejected", async (t) => {
  const { app, actors, bench } = await setup();
  t.after(() => app.close());

  // Expired offer: insert a stale offer directly (past expiry).
  const { createOffer } = await import("../src/services/offers.js");
  const expired = createOffer(app.db,
    { org_id: actors.workerOrg, role: "worker" },
    { price_minor: 500, currency: "USD", ttl_seconds: 60, capacity: 1 },
    "2020-01-01T00:00:00.000Z");
  const r1 = await reserveRun(app.base, actors,
    { claim_id: bench.claim.id, offer_id: expired.id });
  assert.equal(r1.res.status, 422);
  assert.equal(r1.res.body.error.code, "OFFER_NOT_ELIGIBLE");

  // Sponsor org acting as its own worker (kind 'both' can publish offers).
  const both = await api(app.base, { method: "POST", path: "/v1/orgs",
    body: { name: "SelfDesk", kind: "both", evidence: {} } });
  const selfOrg = both.body.org.id;
  // Self org provisions its own worker + sponsor credentials (kind 'both').
  const selfAdmin = { token: both.body.bootstrap_credential };
  const cred = async (role) => (await api(app.base, { ...selfAdmin,
    method: "POST", path: `/v1/orgs/${selfOrg}/credentials`,
    body: { role } })).body.credential;
  const selfWorker = { token: await cred("worker") };
  const selfSponsor = { token: await cred("sponsor") };
  const selfOffer = await api(app.base, { ...selfWorker,
    method: "POST", path: "/v1/offers",
    body: { price_minor: 100, currency: "USD", ttl_seconds: 3600 } });
  // The self org freezes its own claim then tries to hire itself.
  const selfClaim = await api(app.base, { ...selfSponsor,
    method: "POST", path: "/v1/claims",
    body: { recipe_hash: bench.recipe.id, metric: "accuracy",
      evaluator_version: "accuracy-v1", reference: "0.900",
      absolute_tolerance: "0.010", seed_list: [42], hardware_class: "cpu-small" } });
  const r2 = await api(app.base, { ...selfSponsor,
    method: "POST", path: "/v1/runs", headers: { "idempotency-key": "self-1" },
    body: { claim_id: selfClaim.body.claim.id, offer_id: selfOffer.body.offer.id,
      max_spend_minor: 1000 } });
  assert.equal(r2.status, 422);
  assert.equal(r2.body.error.code, "WORKER_NOT_INDEPENDENT");

  // Spend cap is enforced.
  const r3 = await api(app.base, { ...actors.sponsor, method: "POST",
    path: "/v1/runs", headers: { "idempotency-key": "cap-1" },
    body: { claim_id: bench.claim.id, offer_id: bench.offer.id, max_spend_minor: 100 } });
  assert.equal(r3.status, 422);
  assert.equal(r3.body.error.code, "SPEND_CAP_EXCEEDED");

  // Cross-tenant isolation: an unrelated org cannot see the run.
  const { res } = await reserveRun(app.base, actors, { claim_id: bench.claim.id, offer_id: bench.offer.id }, "iso-1");
  const outsider = await api(app.base, { method: "POST", path: "/v1/orgs",
    body: { name: "Outsider", kind: "sponsor", evidence: {} } });
  const peek = await api(app.base, { token: outsider.body.bootstrap_credential,
    path: `/v1/runs/${res.body.run.id}` });
  assert.equal(peek.status, 403);
});
