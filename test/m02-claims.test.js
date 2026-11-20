// T-003 / T-004 — Claims and comparison contract (+ INV-02).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, api, seedOrgs, seedBenchmark } from "./helpers.mjs";

async function baseSetup() {
  const app = await makeApp();
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors);
  return { app, actors, bench };
}

test("T-003: register 0.900 / 0.010 / single seed; exact decimals after reload", async (t) => {
  const { app, actors, bench } = await baseSetup();
  t.after(() => app.close());

  const res = await api(app.base, { ...actors.sponsor,
    path: `/v1/claims/${bench.claim.id}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.claim.reference_decimal, "0.900");
  assert.equal(res.body.claim.absolute_tolerance, "0.010");
  assert.deepEqual(res.body.claim.seed_list, [42]);
  assert.equal(res.body.claim.terms.evaluator_version, "accuracy-v1");

  // Reload through a fresh DB handle (simulates restart): decimals intact.
  const db2 = await app.reopenDb();
  const { getClaim } = await import("../src/services/claims.js");
  const reloaded = getClaim(db2, bench.claim.id);
  assert.equal(reloaded.reference_decimal, "0.900");
  assert.equal(reloaded.absolute_tolerance, "0.010");
  db2.close();
});

test("T-004: undeclared multiseed aggregation and negative tolerance rejected", async (t) => {
  const { app, actors, bench } = await baseSetup();
  t.after(() => app.close());

  const multi = await api(app.base, { ...actors.sponsor, method: "POST", path: "/v1/claims",
    body: { recipe_hash: bench.recipe.id, metric: "accuracy",
      evaluator_version: "accuracy-v1", reference: "0.900",
      absolute_tolerance: "0.010", seed_list: [42, 43],
      hardware_class: "cpu-small" } });
  assert.equal(multi.status, 400);
  assert.equal(multi.body.error.code, "AGGREGATION_REQUIRED");

  const neg = await api(app.base, { ...actors.sponsor, method: "POST", path: "/v1/claims",
    body: { recipe_hash: bench.recipe.id, metric: "accuracy",
      evaluator_version: "accuracy-v1", reference: "0.900",
      absolute_tolerance: "-0.010", seed_list: [42],
      hardware_class: "cpu-small" } });
  assert.equal(neg.status, 400);
  assert.equal(neg.body.error.code, "TOLERANCE_NEGATIVE");

  // INV-02: changing tolerance mints a different claim id.
  const other = await api(app.base, { ...actors.sponsor, method: "POST", path: "/v1/claims",
    body: { recipe_hash: bench.recipe.id, metric: "accuracy",
      evaluator_version: "accuracy-v1", reference: "0.900",
      absolute_tolerance: "0.020", seed_list: [42],
      hardware_class: "cpu-small" } });
  assert.equal(other.status, 201);
  assert.notEqual(other.body.claim.id, bench.claim.id);
});
