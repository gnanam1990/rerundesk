// RerunDesk end-to-end demo through the real HTTP entry points.
// Journey: enroll orgs -> admit licensed dataset + recipe -> freeze claim ->
// publish offer -> reserve run (idempotent) -> lease -> orchestrator restart ->
// fenced execution -> upload + seal bundle -> evaluate -> report + reverify.
//
// Usage: node scripts/demo.mjs [--data DIR] [--port N]
// Uses only local entry points; no external services or paid calls.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argi = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const DATA = path.resolve(argi("--data", "data/demo"));
const PORT = Number(argi("--port", "8901"));
const BASE = `http://127.0.0.1:${PORT}`;

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

let server;
async function startServer() {
  server = spawn(process.execPath, ["src/index.js", "serve", "--port", String(PORT)], {
    env: { ...process.env, RERUNDESK_DATA: DATA }, stdio: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/login"); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
}
function stopServer() { server?.kill("SIGTERM"); }
process.on("exit", stopServer);

const results = [];
function step(name, ok, detail) {
  results.push({ step: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

async function api(actor, method, p, body, { rawBody, headers: extra = {} } = {}) {
  const headers = { ...(actor ? { "x-rd-org": actor.org, "x-rd-role": actor.role } : {}), ...extra };
  const res = await fetch(BASE + p, {
    method, headers,
    body: rawBody !== undefined ? rawBody
        : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function main() {
  await startServer();

  // --- enrollment ---
  const mk = async (name, kind, evidence) =>
    (await api(null, "POST", "/v1/orgs", { name, kind, evidence })).body.org.id;
  const mOrg = await mk("Maintainer Ops", "both", { operator_domain: "ops.rerundesk.local" });
  const sOrg = await mk("Sponsor Co", "sponsor", { operator_domain: "sponsor.example" });
  const wOrg = await mk("Independent Worker LLC", "worker", { operator_domain: "worker.example" });
  const M = { org: mOrg, role: "maintainer" };
  const S = { org: sOrg, role: "sponsor" };
  const W = { org: wOrg, role: "worker" };
  const E = { org: mOrg, role: "evaluator" };
  step("enroll sponsor + independent worker orgs", true, `${sOrg} / ${wOrg}`);

  // --- licensed dataset + recipe admission (M01) ---
  const { buildDataset, predictionsMatching } = await import("../benchmark/fixtures.mjs");
  const ds = buildDataset(110);
  const d = await api(M, "POST", "/v1/datasets", ds);
  step("licensed dataset intake (CC0-1.0, 1000 samples)", d.status === 201, d.body.dataset?.id);

  const manifest = {
    name: "accuracy-bench", image_digest: "sha256:" + "ab".repeat(32),
    entrypoint: "score-predictions", entrypoint_version: "1.0.0",
    data_hash: d.body.dataset.id, license_ref: "CC0-1.0",
    hardware_class: "cpu-small", outputs: { predictions: "outputs/predictions.csv" },
  };
  const r = await api(M, "POST", "/v1/recipes", { manifest });
  step("recipe admission (pinned image digest, fixed entrypoint)",
    [200, 201].includes(r.status) && r.body.recipe?.status === "admitted", r.body.recipe?.id);

  // --- claim freeze (M02) ---
  const c = await api(S, "POST", "/v1/claims", {
    recipe_hash: r.body.recipe.id, metric: "accuracy", evaluator_version: "accuracy-v1",
    reference: "0.900", absolute_tolerance: "0.010", seed_list: [42],
    hardware_class: "cpu-small", units: "ratio" });
  step("claim frozen: accuracy 0.900 ±0.010 seed 42",
    [200, 201].includes(c.status) && c.body.claim?.reference_decimal === "0.900"
      && c.body.claim?.absolute_tolerance === "0.010", c.body.claim?.id);

  // --- offer + idempotent reservation (M03) ---
  const o = await api(W, "POST", "/v1/offers",
    { price_minor: 500, currency: "USD", ttl_seconds: 3600, capacity: 1 });
  const rr = await api(S, "POST", "/v1/runs",
    { claim_id: c.body.claim.id, offer_id: o.body.offer.id, max_spend_minor: 1000 },
    { headers: { "idempotency-key": "demo-1" } });
  const run = rr.body.run;
  const retry = await api(S, "POST", "/v1/runs",
    { claim_id: c.body.claim.id, offer_id: o.body.offer.id, max_spend_minor: 1000 },
    { headers: { "idempotency-key": "demo-1" } });
  step("run reserved; idempotent retry replays same run",
    rr.status === 201 && retry.body.run?.id === run.id, run.id);

  // --- lease + orchestrator restart (M04, T-007) ---
  const lease = (await api(W, "POST", `/v1/runs/${run.id}/lease`, {})).body.lease;
  stopServer();
  await new Promise((r) => setTimeout(r, 400));
  await startServer();
  const hb = await api(W, "POST", `/v1/runs/${run.id}/lease/heartbeat`,
    { lease_token: lease.token });
  step("orchestrator restarted mid-run; lease + run id retained",
    hb.status === 200 && hb.body.lease?.run_id === run.id,
    `epoch ${hb.body.lease?.epoch}`);

  // --- fenced execution + bundle upload + seal (M04/M05) ---
  // Fenced execution is REQUIRED to claim success — no automatic override.
  // SANDBOX_UNAVAILABLE (503) => isolation genuinely unavailable here: the
  // step is recorded blocked and the demo continues with a labeled synthetic
  // bundle so the remaining verdict evidence still exercises the pipeline.
  // SANDBOX_POLICY_FAILED (500) => a defect in our profile: loud failure.
  let ex = await api(W, "POST", `/v1/runs/${run.id}/execute`, {},
    { headers: { "x-rd-lease": lease.token } });
  const produced = ["outputs/predictions.csv", "runtime.json", "logs/run.log"];
  let uploadsOk;
  let rt;
  if (ex.status === 200) {
    const ws = ex.body.workspace;
    uploadsOk = true;
    for (const p of produced) {
      const bytes = fs.readFileSync(path.join(ws, p));
      const u = await api(W, "PUT",
        `/v1/runs/${run.id}/artifacts?path=${encodeURIComponent(p)}`, undefined,
        { headers: { "x-rd-lease": lease.token }, rawBody: bytes });
      uploadsOk &&= u.status === 201;
    }
    rt = JSON.parse(fs.readFileSync(path.join(ws, "runtime.json"), "utf8"));
    step(`fenced execution (${rt.containment}) + bundle upload`,
      uploadsOk && rt.containment === "sandbox-exec:no-network",
      `${ex.body.produced?.length ?? 0} artifacts`);
  } else {
    const blocked = ex.status === 503 && ex.body.error?.code === "SANDBOX_UNAVAILABLE";
    const detail = blocked ? "BLOCKED — " + ex.body.error.message
      : "FAILED — " + (ex.body.error?.message ?? JSON.stringify(ex.body));
    step(`fenced execution (sandbox-exec:no-network)`, false, detail);
    // Labeled synthetic bundle: verdict steps below still run, but the
    // execution claim above stays blocked/failed — nothing claims isolation
    // that did not happen.
    const { predictionsMatching } = await import("../benchmark/fixtures.mjs");
    const rtSynthetic = {
      format: "rerundesk.runtime.v1", run_id: run.id, epoch: 1, seed: 42,
      hardware_class: "cpu-small", image_digest: manifest.image_digest,
      metric: "accuracy", containment: "none:synthetic-bundle",
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      exit_status: null,
    };
    uploadsOk = true;
    for (const f of [
      { p: "outputs/predictions.csv", b: Buffer.from(predictionsMatching(ds.gold, 890)) },
      { p: "runtime.json", b: Buffer.from(JSON.stringify(rtSynthetic)) },
      { p: "logs/run.log", b: Buffer.from("[demo] synthetic bundle — fenced execution unavailable\n") },
    ]) {
      const u = await api(W, "PUT",
        `/v1/runs/${run.id}/artifacts?path=${encodeURIComponent(f.p)}`, undefined,
        { headers: { "x-rd-lease": lease.token }, rawBody: f.b });
      uploadsOk &&= u.status === 201;
    }
    step("synthetic bundle uploaded for verdict coverage (labeled)",
      uploadsOk, "no isolation claimed");
    rt = rtSynthetic;
  }

  const arts = (await api(W, "GET", `/v1/runs/${run.id}/artifacts`)).body.artifacts;
  const seal = await api(W, "PUT", `/v1/runs/${run.id}/manifest`,
    { files: arts.map((a) => ({ path: a.path, sha256: a.sha256 })) },
    { headers: { "x-rd-lease": lease.token } });
  step("manifest sealed, digests recomputed", seal.status === 200,
    seal.body.manifest_hash?.slice(0, 16));

  // --- evaluation (M06) ---
  const ev = await api(E, "POST", `/v1/runs/${run.id}/evaluate`);
  const okEv = ev.body.evaluation?.outcome === "reproduced" &&
    ev.body.evaluation?.observed_decimal === "0.890";
  step("evaluator: 890/1000 = 0.890, diff 0.010 within tolerance -> reproduced",
    okEv, ev.body.evaluation?.explanation);

  // --- report + settlement separation (M07) ---
  const rep = await api(S, "GET", `/v1/runs/${run.id}/report`);
  const report = rep.body.report;
  step("report: timeline + independence + repro manifest + cost history",
    rep.status === 200 &&
    report.independence.independence_status === "enrolled" &&
    report.settlement.status === "captured" &&
    report.evaluation.outcome === "reproduced",
    `settlement=${report.settlement.status} (${report.settlement.provider}, local)`);

  // --- second run: divergence is a valid outcome (same claim, new offer) ---
  const o2 = await api(W, "POST", "/v1/offers",
    { price_minor: 500, currency: "USD", ttl_seconds: 3600, capacity: 1 });
  const rr2 = await api(S, "POST", "/v1/runs",
    { claim_id: c.body.claim.id, offer_id: o2.body.offer.id, max_spend_minor: 1000 },
    { headers: { "idempotency-key": "demo-2" } });
  const run2 = rr2.body.run;
  const lease2 = (await api(W, "POST", `/v1/runs/${run2.id}/lease`, {})).body.lease;
  const preds889 = predictionsMatching(ds.gold, 889);
  for (const f of [
    { p: "outputs/predictions.csv", b: Buffer.from(preds889) },
    { p: "runtime.json", b: Buffer.from(JSON.stringify({ ...rt, run_id: run2.id, epoch: 1 })) },
    { p: "logs/run.log", b: Buffer.from("[demo] second run\n") },
  ]) {
    await api(W, "PUT", `/v1/runs/${run2.id}/artifacts?path=${encodeURIComponent(f.p)}`,
      undefined, { headers: { "x-rd-lease": lease2.token }, rawBody: f.b });
  }
  const arts2 = (await api(W, "GET", `/v1/runs/${run2.id}/artifacts`)).body.artifacts;
  await api(W, "PUT", `/v1/runs/${run2.id}/manifest`,
    { files: arts2.map((a) => ({ path: a.path, sha256: a.sha256 })) },
    { headers: { "x-rd-lease": lease2.token } });
  const ev2 = await api(E, "POST", `/v1/runs/${run2.id}/evaluate`);
  step("second run 889/1000 = 0.889, diff 0.011 -> diverged (valid outcome)",
    ev2.body.evaluation?.outcome === "diverged",
    ev2.body.evaluation?.explanation);

  // --- third run: missing output -> inconclusive, still settles delivery ---
  const o3 = await api(W, "POST", "/v1/offers",
    { price_minor: 500, currency: "USD", ttl_seconds: 3600, capacity: 1 });
  const rr3 = await api(S, "POST", "/v1/runs",
    { claim_id: c.body.claim.id, offer_id: o3.body.offer.id, max_spend_minor: 1000 },
    { headers: { "idempotency-key": "demo-3" } });
  const run3 = rr3.body.run;
  const lease3 = (await api(W, "POST", `/v1/runs/${run3.id}/lease`, {})).body.lease;
  const preds999 = predictionsMatching(ds.gold, 1000, { omitIds: new Set(["s0999"]) });
  for (const f of [
    { p: "outputs/predictions.csv", b: Buffer.from(preds999) },
    { p: "runtime.json", b: Buffer.from(JSON.stringify({ ...rt, run_id: run3.id, epoch: 1 })) },
    { p: "logs/run.log", b: Buffer.from("[demo] third run\n") },
  ]) {
    await api(W, "PUT", `/v1/runs/${run3.id}/artifacts?path=${encodeURIComponent(f.p)}`,
      undefined, { headers: { "x-rd-lease": lease3.token }, rawBody: f.b });
  }
  const arts3 = (await api(W, "GET", `/v1/runs/${run3.id}/artifacts`)).body.artifacts;
  await api(W, "PUT", `/v1/runs/${run3.id}/manifest`,
    { files: arts3.map((a) => ({ path: a.path, sha256: a.sha256 })) },
    { headers: { "x-rd-lease": lease3.token } });
  const ev3 = await api(E, "POST", `/v1/runs/${run3.id}/evaluate`);
  step("third run missing 1 of 1000 outputs -> inconclusive",
    ev3.body.evaluation?.outcome === "inconclusive" &&
    ev3.body.evaluation?.reason_code === "output_incomplete",
    ev3.body.evaluation?.explanation);

  // --- independent re-verification on the sealed bundle ---
  const { execSync } = await import("node:child_process");
  const reOut = execSync(
    `${process.execPath} scripts/reevaluate.mjs --run ${run.id}`,
    { env: { ...process.env, RERUNDESK_DATA: DATA }, encoding: "utf8" });
  const re = JSON.parse(reOut);
  step("independent re-evaluation replays identical verdict", re.match === true);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} demo steps passed.`);
  fs.writeFileSync(path.join(DATA, "demo-results.json"), JSON.stringify(results, null, 2));
  console.log(`evidence: ${path.join(DATA, "demo-results.json")}`);
  console.log(`report packet: GET ${BASE}/v1/runs/${run.id}/report`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
