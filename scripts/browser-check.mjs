// RerunDesk browser verification: drives the real console in a real browser
// (Chromium headless shell via CDP) against a running server on an ephemeral
// port with disposable data. No npm dependencies — uses Node's built-in
// WebSocket for the DevTools protocol.
//
// Journey: sponsor sign-in with provisioned credential -> run detail shows
// comparison verdict, settlement/cost separately and report links -> JSON
// report carries cost history -> 320px layout + keyboard focus -> reload
// persistence -> cross-tenant denial renders a visible error page.
//
// Usage:
//   node scripts/browser-check.mjs [--chrome PATH] [--evidence DIR]
// Chrome resolution order: --chrome flag, RD_CHROME env, newest
//   chromium_headless_shell-* under the standard Playwright cache.
// Extra Chromium flags via RD_CHROME_ARGS (needed inside nested sandboxes:
//   RD_CHROME_ARGS="--no-sandbox --single-process").
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argi = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : d;
};
const EVIDENCE = path.resolve(argi("--evidence",
  "build-progress/rerundesk/browser-evidence"));

function resolveChrome() {
  if (argi("--chrome") || process.env.RD_CHROME)
    return argi("--chrome") ?? process.env.RD_CHROME;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const dirs = fs.readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort().reverse();
  for (const d of dirs) {
    for (const name of ["chrome-headless-shell", "headless_shell"]) {
      const p = path.join(cache, d, "chrome-headless-shell-mac-arm64", name);
      if (fs.existsSync(p)) return p;
      const alt = path.join(cache, d, name);
      if (fs.existsSync(alt)) return alt;
    }
  }
  throw new Error("no chromium headless shell found; pass --chrome PATH");
}

const results = [];
function step(name, ok, detail) {
  results.push({ step: name, ok: !!ok, detail: detail ?? null });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "rerundesk-browser-"));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "rerundesk-chrome-"));
fs.mkdirSync(EVIDENCE, { recursive: true });

// --- server on an ephemeral port -------------------------------------------
const server = spawn(process.execPath,
  ["src/index.js", "serve", "--port", "0"], {
    env: { ...process.env, RERUNDESK_DATA: DATA }, stdio: ["ignore", "pipe", "inherit"] });
let BASE;
await new Promise((res, rej) => {
  let buf = "";
  server.stdout.on("data", (d) => {
    buf += d;
    const m = buf.match(/listening on http:\/\/localhost:(\d+)/);
    if (m) { BASE = `http://127.0.0.1:${m[1]}`; res(); }
  });
  server.on("exit", () => rej(new Error("server exited")));
  setTimeout(() => rej(new Error("server start timeout")), 10000);
});
process.on("exit", () => server.kill("SIGTERM"));

async function api(actor, method, p, body, { rawBody, headers: extra = {} } = {}) {
  const headers = { ...(actor?.token ? { authorization: `Bearer ${actor.token}` } : {}), ...extra };
  const res = await fetch(BASE + p, {
    method, headers,
    body: rawBody !== undefined ? rawBody
      : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// --- seed the journey through real API entry points -------------------------
const mk = async (name, kind, evidence) =>
  (await api(null, "POST", "/v1/orgs", { name, kind, evidence })).body;
const mb = await mk("Maintainer Ops", "both", { operator_domain: "ops.local" });
const sb = await mk("Sponsor Co", "sponsor", { operator_domain: "sponsor.example" });
const wb = await mk("Independent Worker LLC", "worker", { operator_domain: "worker.example" });
const M = { token: mb.bootstrap_credential };
const S = { token: sb.bootstrap_credential };
const W = { token: wb.bootstrap_credential };
const E = { token: (await api(M, "POST", `/v1/orgs/${mb.org.id}/credentials`,
  { role: "evaluator" })).body.credential };

const { buildDataset, predictionsMatching } = await import("../benchmark/fixtures.mjs");
const ds = buildDataset(110);
const d = await api(M, "POST", "/v1/datasets", ds);
const manifest = {
  name: "accuracy-bench", image_digest: "sha256:" + "ab".repeat(32),
  entrypoint: "score-predictions", entrypoint_version: "1.0.0",
  data_hash: d.body.dataset.id, license_ref: "CC0-1.0",
  hardware_class: "cpu-small", outputs: { predictions: "outputs/predictions.csv" },
};
const r = await api(M, "POST", "/v1/recipes", { manifest });
const c = await api(S, "POST", "/v1/claims", {
  recipe_hash: r.body.recipe.id, metric: "accuracy", evaluator_version: "accuracy-v1",
  reference: "0.900", absolute_tolerance: "0.010", seed_list: [42],
  hardware_class: "cpu-small", units: "ratio" });
const o = await api(W, "POST", "/v1/offers",
  { price_minor: 500, currency: "USD", ttl_seconds: 3600, capacity: 1 });
const rr = await api(S, "POST", "/v1/runs",
  { claim_id: c.body.claim.id, offer_id: o.body.offer.id, max_spend_minor: 1000 },
  { headers: { "idempotency-key": "browser-1" } });
const run = rr.body.run;
const lease = (await api(W, "POST", `/v1/runs/${run.id}/lease`, {})).body.lease;

// Fenced execution where the host supports it; labeled synthetic bundle where
// it does not (mirrors demo.mjs — nothing claims isolation it did not get).
let ex = await api(W, "POST", `/v1/runs/${run.id}/execute`, {},
  { headers: { "x-rd-lease": lease.token } });
let containment;
if (ex.status === 200) {
  const ws = ex.body.workspace;
  for (const p of ["outputs/predictions.csv", "runtime.json", "logs/run.log"]) {
    await api(W, "PUT", `/v1/runs/${run.id}/artifacts?path=${encodeURIComponent(p)}`,
      undefined, { headers: { "x-rd-lease": lease.token },
        rawBody: fs.readFileSync(path.join(ws, p)) });
  }
  containment = JSON.parse(fs.readFileSync(path.join(ws, "runtime.json"), "utf8")).containment;
} else {
  containment = ex.status === 503 ? "none:synthetic-bundle" : `error:${ex.status}`;
  const rt = { format: "rerundesk.runtime.v1", run_id: run.id, epoch: 1, seed: 42,
    hardware_class: "cpu-small", image_digest: manifest.image_digest,
    metric: "accuracy", containment, started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(), exit_status: null };
  for (const f of [
    { p: "outputs/predictions.csv", b: Buffer.from(predictionsMatching(ds.gold, 890)) },
    { p: "runtime.json", b: Buffer.from(JSON.stringify(rt)) },
    { p: "logs/run.log", b: Buffer.from("[browser-check] synthetic bundle\n") },
  ]) {
    await api(W, "PUT", `/v1/runs/${run.id}/artifacts?path=${encodeURIComponent(f.p)}`,
      undefined, { headers: { "x-rd-lease": lease.token }, rawBody: f.b });
  }
}
const sealList = (await api(W, "GET", `/v1/runs/${run.id}/artifacts`,
  undefined, { headers: { "x-rd-lease": lease.token } })).body.artifacts;
await api(W, "PUT", `/v1/runs/${run.id}/manifest`,
  { files: sealList.map((a) => ({ path: a.path, sha256: a.sha256 })) },
  { headers: { "x-rd-lease": lease.token } });
const ev = await api(E, "POST", `/v1/runs/${run.id}/evaluate`);
step("seed: run evaluated through API (890/1000 -> reproduced)",
  ev.body.evaluation?.outcome === "reproduced", `containment=${containment}`);

// --- launch headless shell + CDP --------------------------------------------
const CHROME = resolveChrome();
const chromeArgs = (process.env.RD_CHROME_ARGS ?? "--no-sandbox --single-process")
  .split(" ").filter(Boolean);
const chrome = spawn(CHROME, ["--headless", ...chromeArgs,
  "--remote-debugging-port=0", "--no-first-run",
  `--user-data-dir=${PROFILE}`, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
process.on("exit", () => chrome.kill("SIGKILL"));
const devtools = await new Promise((res, rej) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) res(m[1]);
  });
  chrome.on("exit", () => rej(new Error("chrome exited: " + buf.slice(-300))));
  setTimeout(() => rej(new Error("devtools timeout: " + buf.slice(-300))), 15000);
});
const cdpHttp = "http://" + new URL(devtools).host;

const target = await (await fetch(`${cdpHttp}/json/new?about:blank`,
  { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
function cdp(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaljs(expr) {
  const r = await cdp("Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error("page eval failed: " +
      (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 300));
  return r.result.value;
}
async function goto(url) {
  await cdp("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      if (await evaljs(`location.href === ${JSON.stringify(url)} || location.href.startsWith(${JSON.stringify(url)} + '#')`)) {
        if (await evaljs("document.readyState === 'complete'")) return;
      }
    } catch { /* navigation in flight */ }
  }
  throw new Error("navigation timeout: " + url);
}
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  const p = path.join(EVIDENCE, name);
  fs.writeFileSync(p, Buffer.from(r.data, "base64"));
  return p;
}

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride",
  { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// --- journey ----------------------------------------------------------------
// 1. Sign in with the provisioned credential.
await goto(`${BASE}/login`);
await evaljs(`(() => {
  document.querySelector('input[name="credential"]').value = ${JSON.stringify(sb.bootstrap_credential)};
  document.querySelector('form[action="/login"] button[type="submit"], form[action="/login"] button').click();
  return true; })()`);
let ok = false;
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 100));
  try {
    if (await evaljs(`location.pathname === '/' && document.readyState === 'complete'`)) { ok = true; break; }
  } catch {}
}
step("sponsor sign-in with provisioned credential", ok);

// 2. Run detail: verdict, comparison, settlement/cost, report links.
await goto(`${BASE}/runs/${run.id}`);
const detail = await evaljs(`document.body.innerText`);
step("run detail shows comparison verdict",
  detail.includes("Comparison") && detail.includes("reproduced")
    && detail.includes("0.900") && detail.includes("0.010"));
step("settlement shown separately from verdict",
  detail.includes("Settlement") && detail.includes("local-ledger")
    && detail.includes("independent of verdict"));
const links = await evaljs(`[...document.querySelectorAll('a')].map(a => a.getAttribute('href'))`);
step("report packet links present",
  links.includes(`/v1/runs/${run.id}/report`)
    && links.includes(`/v1/runs/${run.id}/report/download`));
await shot("run-desktop.png");

// 3. JSON report through the browser session: cost history present + separate.
const rep = await evaljs(`fetch('/v1/runs/${run.id}/report')
  .then(r => r.json()).then(j => ({
    outcome: j.report.evaluation.outcome,
    settle: j.report.settlement.status,
    costRows: j.report.cost_history.length }))`);
step("report JSON: verdict + cost history separate",
  rep.outcome === "reproduced" && rep.settle === "captured" && rep.costRows >= 2,
  `settlement=${rep.settle}, cost rows=${rep.costRows}`);

// 4. 320px layout: no horizontal overflow, content still reachable.
await cdp("Emulation.setDeviceMetricsOverride",
  { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
await evaljs("window.scrollTo(0,0)");
const overflow = await evaljs(
  "document.documentElement.scrollWidth - document.documentElement.clientWidth");
step("320px: no horizontal overflow", overflow <= 4, `overflow=${overflow}px`);
await shot("run-320px.png");

// 5. Keyboard reachability + visible focus.
let focusable = false, lastTag = "", focusVisible = false;
for (let i = 0; i < 12; i++) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab",
    code: "Tab", windowsVirtualKeyCode: 9 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab",
    code: "Tab", windowsVirtualKeyCode: 9 });
  const f = await evaljs(`(() => { const el = document.activeElement;
    const cs = getComputedStyle(el);
    return { tag: el.tagName, focusable: el !== document.body,
      outline: cs.outlineStyle !== 'none' || parseFloat(cs.outlineWidth) > 0 }; })()`);
  if (f.focusable && ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(f.tag)) {
    focusable = true; lastTag = f.tag; focusVisible = f.outline; break;
  }
}
step("keyboard: Tab reaches interactive elements", focusable, `focused <${lastTag}>`);
step("keyboard: focus indicator visible", focusVisible);

// 6. Reload persistence.
await cdp("Page.reload");
await new Promise((r) => setTimeout(r, 700));
const detail2 = await evaljs(`document.body.innerText`);
step("reload: verdict + settlement persist",
  detail2.includes("reproduced") && detail2.includes("local-ledger"));

// 7. Permission/error visibility: outsider org is denied a readable page.
await evaljs(`fetch('/logout', { method: 'POST' })`);
await new Promise((r) => setTimeout(r, 300));
const ob = await mk("Outsider Org", "sponsor", { operator_domain: "outsider.example" });
await goto(`${BASE}/login`);
await evaljs(`(() => {
  document.querySelector('input[name="credential"]').value = ${JSON.stringify(ob.bootstrap_credential)};
  document.querySelector('form[action="/login"] button[type="submit"], form[action="/login"] button').click();
  return true; })()`);
await new Promise((r) => setTimeout(r, 800));
await goto(`${BASE}/runs/${run.id}`);
const denied = await evaljs(`({ text: document.body.innerText,
  alert: !!document.querySelector('[role="alert"]') })`);
step("cross-tenant denial renders visible error page",
  /4\d\d/.test(denied.text) && denied.alert,
  denied.text.slice(0, 80).replace(/\n/g, " "));
await shot("denied-403.png");

// --- evidence ----------------------------------------------------------------
const chromeVersion = spawnSync(CHROME, ["--version"], { encoding: "utf8" })
  .stdout.trim();
const evidence = {
  generated_at: new Date().toISOString(),
  chrome: chromeVersion,
  chrome_path: CHROME,
  chrome_args: chromeArgs,
  server: "node src/index.js serve --port 0 (ephemeral)",
  data_dir: "fresh mkdtemp (disposed)", base_url_redacted: "http://127.0.0.1:<ephemeral>",
  containment_seeded: containment,
  run_id: run.id,
  results,
  screenshots: fs.readdirSync(EVIDENCE).filter((f) => f.endsWith(".png")),
};
fs.writeFileSync(path.join(EVIDENCE, "EVIDENCE.json"), JSON.stringify(evidence, null, 2));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} browser checks passed.`);
console.log(`evidence: ${EVIDENCE}`);
ws.close(); chrome.kill("SIGKILL"); server.kill("SIGTERM");
process.exit(passed === results.length ? 0 : 1);
