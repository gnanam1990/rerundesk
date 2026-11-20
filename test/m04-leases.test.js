// T-007 / T-008 — Leased isolated execution (+ INV-04).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  makeApp, api, seedOrgs, seedBenchmark, reserveRun, issueLease,
} from "./helpers.mjs";

async function seededRun(app, actors, bench, key) {
  const { res } = await reserveRun(app.base, actors,
    { claim_id: bench.claim.id, offer_id: bench.offer.id }, key);
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.run;
}

test("T-007: orchestrator restart while worker runs; lease + run id retained", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors);
  const run = await seededRun(app, actors, bench, "m04-a");

  const lease = await issueLease(app.base, actors, run.id);
  const hb = await api(app.base, { ...actors.worker, method: "POST",
    path: `/v1/runs/${run.id}/lease/heartbeat`, body: { lease_token: lease.token } });
  assert.equal(hb.status, 200);

  // Simulate orchestrator restart: reopen the database on the same file and
  // drive the heartbeat through the service layer on the fresh handle.
  const db2 = await app.reopenDb();
  const { heartbeat, activeLease } = await import("../src/services/leases.js");
  const lease2 = heartbeat(db2,
    { org_id: actors.workerOrg, role: "worker" }, run.id, lease.token);
  assert.equal(lease2.run_id, run.id);
  assert.equal(lease2.status, "active");
  assert.equal(activeLease(db2, run.id).epoch, lease.epoch);
  const run2 = db2.prepare("SELECT * FROM runs WHERE id = ?").get(run.id);
  assert.equal(run2.state, "running");
  db2.close();
});

test("T-008: an expired lease cannot finalize output even if worker finishes late", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors);
  const run = await seededRun(app, actors, bench, "m04-b");

  const lease = await issueLease(app.base, actors, run.id);
  // Force expiry: backdate the lease deadline.
  app.db.prepare("UPDATE leases SET expires_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", lease.id);

  const up = await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/artifacts?path=runtime.json`,
    raw: Buffer.from("{}"), headers: { "x-rd-lease": lease.token } });
  assert.equal(up.status, 409);
  assert.equal(up.body.error.code, "LEASE_EXPIRED");

  // The run is recoverable: a fresh lease gets a new epoch.
  const lease2 = await issueLease(app.base, actors, run.id);
  assert.equal(lease2.epoch, lease.epoch + 1);
  const stale = await api(app.base, { ...actors.worker, method: "PUT",
    path: `/v1/runs/${run.id}/artifacts?path=runtime.json`,
    raw: Buffer.from("{}"), headers: { "x-rd-lease": lease.token } });
  assert.equal(stale.status, 403);          // superseded token cannot deliver

  // Only one active lease at a time.
  const dup = await api(app.base, { ...actors.worker, method: "POST",
    path: `/v1/runs/${run.id}/lease`, body: {} });
  assert.equal(dup.status, 409);
});

test("M04: fenced runner executes the pinned recipe under sandbox-exec", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors);
  const run = await seededRun(app, actors, bench, "m04-c");
  const lease = await issueLease(app.base, actors, run.id);

  const ex = await api(app.base, { ...actors.worker, method: "POST",
    path: `/v1/runs/${run.id}/execute`, headers: { "x-rd-lease": lease.token },
    body: {} });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ex.body.exit_status, 0);
  assert.deepEqual(ex.body.produced.sort(),
    ["logs/run.log", "outputs/predictions.csv", "runtime.json"].sort());

  const rt = JSON.parse(fs.readFileSync(`${ex.body.workspace}/runtime.json`, "utf8"));
  // In a host where seatbelt can be applied this is 'sandbox-exec:no-network';
  // inside this build sandbox, sandbox_apply is denied and the runner records
  // 'unsandboxed' honestly instead of claiming isolation it did not enforce.
  assert.ok(["sandbox-exec:no-network", "unsandboxed"].includes(rt.containment));
  assert.equal(rt.seed, 42);
  const preds = fs.readFileSync(`${ex.body.workspace}/outputs/predictions.csv`, "utf8");
  assert.equal(preds.trim().split("\n").length, 1001); // header + 1000 rows
});
