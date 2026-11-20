// T-001 / T-002 — Recipe admission and provenance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, api, seedOrgs, seedBenchmark, RECIPE_MANIFEST } from "./helpers.mjs";
import { canonicalize, contentId } from "../src/canonical.js";

test("T-001: a reordered manifest serializes to the same canonical digest", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);

  const { buildDataset } = await import("../benchmark/fixtures.mjs");
  const d = await api(app.base, { ...actors.maintainer, method: "POST",
    path: "/v1/datasets", body: buildDataset(110) });
  const manifest = RECIPE_MANIFEST(d.body.dataset.id);

  // Same manifest, keys inserted in a different order.
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(canonicalize(manifest), canonicalize(reordered));
  assert.equal(contentId(manifest), contentId(reordered));

  const r1 = await api(app.base, { ...actors.maintainer, method: "POST",
    path: "/v1/recipes", body: { manifest } });
  assert.equal(r1.status, 201);
  const r2 = await api(app.base, { ...actors.maintainer, method: "POST",
    path: "/v1/recipes", body: { manifest: reordered } });
  assert.equal(r2.status, 200);            // same content id, deduplicated
  assert.equal(r2.body.recipe.id, r1.body.recipe.id);
  assert.equal(r1.body.recipe.status, "admitted");
});

test("T-002: floating image tag or missing dataset license is rejected", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const { buildDataset } = await import("../benchmark/fixtures.mjs");
  const d = await api(app.base, { ...actors.maintainer, method: "POST",
    path: "/v1/datasets", body: buildDataset(110) });

  const tagged = { ...RECIPE_MANIFEST(d.body.dataset.id), image_digest: "bench:latest" };
  const r1 = await api(app.base, { ...actors.maintainer, method: "POST",
    path: "/v1/recipes", body: { manifest: tagged } });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error.code, "RECIPE_REJECTED");
  assert.ok(r1.body.error.details.some((x) => x.includes("image_digest")));

  const unlicensed = { ...RECIPE_MANIFEST(d.body.dataset.id) };
  delete unlicensed.license_ref;
  const r2 = await api(app.base, { ...actors.maintainer, method: "POST",
    path: "/v1/recipes", body: { manifest: unlicensed } });
  assert.equal(r2.status, 400);
  assert.ok(r2.body.error.details.some((x) => x.includes("license_ref")));

  // Rejected manifests are persisted for audit but never schedulable.
  const list = await api(app.base, { ...actors.maintainer, path: "/v1/recipes" });
  const rejected = list.body.recipes.filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 2);

  // Dataset intake itself refuses unlicensed input.
  const bad = { ...buildDataset(110), license_ref: "Proprietary-Unknown" };
  const d2 = await api(app.base, { ...actors.maintainer, method: "POST",
    path: "/v1/datasets", body: bad });
  assert.equal(d2.status, 400);
  assert.equal(d2.body.error.code, "LICENSE_NOT_ALLOWED");
});
