// T-007 / T-008 — Leased isolated execution (+ INV-04), plus the fenced
// runner. The containment assertions distinguish three honest environments:
// contained host (sandbox_apply works), unsupported host (fail-closed 503),
// and explicit operator override (unsandboxed, recorded as such).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

test("M04: fenced runner — contained where supported, fail-closed otherwise", async (t) => {
  const app = await makeApp();
  t.after(() => { delete process.env.RERUNDESK_UNSAFE_RUNNER; app.close(); });
  const actors = await seedOrgs(app.base);
  const bench = await seedBenchmark(app.base, actors);
  const run = await seededRun(app, actors, bench, "m04-c");
  const lease = await issueLease(app.base, actors, run.id);

  const { capabilityProbe } = await import("../src/runner.js");
  const support = capabilityProbe(path.join(app.dir, "preflight"));

  const execute = () => api(app.base, { ...actors.worker, method: "POST",
    path: `/v1/runs/${run.id}/execute`, headers: { "x-rd-lease": lease.token },
    body: {} });

  if (support.ok) {
    // Contained host: real seatbelt execution must succeed and be recorded.
    // A policy/launch failure here (500 SANDBOX_POLICY_FAILED) is a defect
    // and must fail the test, never be reclassified as "unsupported".
    const ex = await execute();
    assert.equal(ex.status, 200, JSON.stringify(ex.body));
    assert.equal(ex.body.exit_status, 0);
    assert.deepEqual(ex.body.produced.sort(),
      ["logs/run.log", "outputs/predictions.csv", "runtime.json"].sort());
    const rt = JSON.parse(fs.readFileSync(`${ex.body.workspace}/runtime.json`, "utf8"));
    assert.equal(rt.containment, "sandbox-exec:no-network");
    assert.equal(rt.seed, 42);
    const preds = fs.readFileSync(`${ex.body.workspace}/outputs/predictions.csv`, "utf8");
    assert.equal(preds.trim().split("\n").length, 1001);
  } else {
    // Unsupported host (e.g. nested inside another sandbox): the execute path
    // must fail closed with a distinct, operator-actionable state.
    t.diagnostic(`sandbox unsupported in this environment: ${support.detail}`);
    const ex = await execute();
    assert.equal(ex.status, 503);
    assert.equal(ex.body.error.code, "SANDBOX_UNAVAILABLE");

    // The explicit operator override is the only escape, and it is recorded.
    process.env.RERUNDESK_UNSAFE_RUNNER = "1";
    const ex2 = await execute();
    assert.equal(ex2.status, 200, JSON.stringify(ex2.body));
    assert.equal(ex2.body.exit_status, 0);
    const rt = JSON.parse(fs.readFileSync(`${ex2.body.workspace}/runtime.json`, "utf8"));
    assert.equal(rt.containment, "unsandboxed:operator-override");
    delete process.env.RERUNDESK_UNSAFE_RUNNER;
  }
});

test("M04: seatbelt scope — read limited to scope, write limited to workspace", async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const { capabilityProbe, sandboxProfile, runFenced } =
    await import("../src/runner.js");
  const support = capabilityProbe(path.join(app.dir, "preflight2"));
  if (!support.ok) {
    t.skip(`seatbelt cannot be applied in this environment: ${support.detail}`);
    return;
  }

  // Disposable fixture: a probe script plus files inside and outside scope.
  const ws = fs.mkdtempSync(path.join(app.dir, "ws-"));
  const inputs = path.join(ws, "inputs");
  const probeDir = path.join(ws, "probe");
  const outside = path.join(app.dir, "outside-scope");
  fs.mkdirSync(inputs, { recursive: true });
  fs.mkdirSync(probeDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(inputs, "allowed.txt"), "input-bytes");

  const probe = path.join(probeDir, "probe.mjs");
  fs.writeFileSync(probe, `
import fs from "node:fs";
const [inputFile, insideFile, outsideFile, etcFile] = process.argv.slice(2);
const r = {};
const attempt = (k, fn) => { try { fn(); r[k] = "allowed"; } catch (e) { r[k] = "denied"; } };
attempt("read_in_scope", () => fs.readFileSync(inputFile));
attempt("write_in_workspace", () => fs.writeFileSync(insideFile, "x"));
attempt("write_outside_workspace", () => fs.writeFileSync(outsideFile, "x"));
attempt("read_outside_scope", () => fs.readFileSync(etcFile));
console.log(JSON.stringify(r));
`);

  const profilePath = path.join(ws, "probe.sb");
  fs.writeFileSync(profilePath, sandboxProfile({
    workspace: ws,
    inputsDir: inputs,
    recipeDir: probeDir,
    nodeRoot: path.dirname(path.dirname(fs.realpathSync(process.execPath))),
  }));

  const insideFile = path.join(ws, "ok.txt");
  const outsideFile = path.join(outside, "nope.txt");
  const res = runFenced([
    process.execPath, probe,
    path.join(inputs, "allowed.txt"), insideFile, outsideFile, "/etc/passwd",
  ], profilePath);
  assert.equal(res.status, 0, res.stderr);
  const r = JSON.parse(res.stdout.trim());
  assert.equal(r.read_in_scope, "allowed");
  assert.equal(r.write_in_workspace, "allowed");
  assert.equal(r.write_outside_workspace, "denied");
  assert.equal(r.read_outside_scope, "denied");
  assert.ok(!fs.existsSync(outsideFile), "no file may be written outside the fence");
});
