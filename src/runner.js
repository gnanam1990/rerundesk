// M04 — Local fenced execution adapter. The recipe entrypoint runs as a child
// process under macOS sandbox-exec: network egress denied, filesystem reads
// scoped to the JS runtime, system loader paths, the reviewed recipe and the
// immutable mounted inputs, writes scoped to the fenced workspace, scrubbed
// environment, bounded wall time and bounded output.
//
// Isolation is fail-closed: when a seatbelt profile cannot be applied the run
// is refused (SANDBOX_UNAVAILABLE). The only escape is the explicit operator
// override RERUNDESK_UNSAFE_RUNNER=1, which records containment 'unsandboxed'
// in runtime.json instead of claiming isolation that was not enforced.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./db.js";
import { COMMAND_CATALOG, RUNNER } from "./catalog.js";
import { getRecipe } from "./services/recipes.js";
import { getDataset } from "./services/datasets.js";
import { getClaim } from "./services/claims.js";
import { readObject } from "./objectstore.js";
import { HttpError } from "./errors.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const realpath = (p) => fs.realpathSync(p);

// Install root of the running JS runtime (covers bin/ plus any shared libs
// shipped inside the install, without opening the whole host).
function nodeInstallRoot() {
  return path.dirname(path.dirname(realpath(process.execPath)));
}

// Seatbelt subpath rules match canonical paths — every path embedded in the
// profile MUST be passed through realpath() first, or symlinked prefixes
// (/var -> /private/var is the standard one for tmpdirs) silently deny access.
//
// Traversing to a granted path also stats every ancestor component — and
// resolving a symlink or firmlink component (/var, /Volumes, anything on the
// Data volume via /System/Volumes/Data) stats the symlink AND the resolved
// chain. Emit file-read-metadata literals for every ancestor of each granted
// path in raw, realpath and /System/Volumes/Data-prefixed form. Metadata
// grants permit stat/traversal only — no file contents, no dir listings.
function ancestorLiterals(paths) {
  const seen = new Set(["/"]); // "/" already granted literally
  const lits = [];
  const expand = (p) => {
    let d = path.dirname(p);
    while (d && d !== "/" && !seen.has(d)) { seen.add(d); lits.push(d); d = path.dirname(d); }
  };
  for (const p of paths) {
    let rp = p;
    try { rp = realpath(p); } catch { /* keep raw */ }
    for (const v of new Set([p, rp])) {
      expand(v);
      if (v.startsWith("/")) expand("/System/Volumes/Data" + v);
    }
  }
  return lits.sort().map((l) => `  (literal "${l}")`).join("\n");
}

export function sandboxProfile({ workspace, inputsDir, recipeDir, nodeRoot }) {
  const rw = realpath(workspace);
  // dyld CacheFinder resolves the shared cache under cryptex mounts on
  // modern macOS; without these reads the child SIGABRTs in bootstrap.
  const loaderDirs = [
    "/System/Cryptexes", "/private/preboot/Cryptexes",
    "/private/var/db/dyld", "/var/db/dyld",
  ]
    .filter((d) => fs.existsSync(d))
    .map((d) => `  (subpath "${realpath(d)}")`).join("\n");
  return `(version 1)
(deny default)

; process control within the child's own job
(allow process-exec)
(allow process-fork)
(allow job-creation)
(allow process-info*)
(allow signal (target self))

; mach/sysinfo/shm needed by node + libuv startup
(allow mach-lookup)
(allow sysctl-read)
(allow ipc-posix-shm)
(allow file-ioctl)

; read scope: JS runtime install, system loader/frameworks, reviewed recipe,
; immutable mounted inputs, the fenced workspace (outputs may be read back),
; startup character devices. dyld CacheFinder stats "/" during bootstrap —
; a directory literal grants no file contents.
(allow file-read* file-read-metadata
  (literal "/")
  (subpath "${realpath(nodeRoot)}")
  (subpath "/System/Library")
  (subpath "/usr/lib")
${loaderDirs}
  (subpath "${realpath(recipeDir)}")
  (subpath "${realpath(inputsDir)}")
  (subpath "${rw}")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (literal "/dev/zero")
  (literal "/dev/random"))

; traversal metadata: ancestors (raw, resolved, firmlink) of every granted
; path — stat allowed, contents and listings still denied
(allow file-read-metadata
${ancestorLiterals([workspace, inputsDir, recipeDir, nodeRoot,
    "/dev/null", "/dev/urandom", "/dev/zero", "/dev/random",
    "/System/Library", "/usr/lib",
    "/System/Cryptexes", "/private/preboot/Cryptexes",
    "/private/var/db/dyld", "/var/db/dyld"].filter((d) => fs.existsSync(d)))})

; write scope: the fenced workspace only
(allow file-write* (subpath "${rw}"))

; no network, inbound or outbound
(deny network*)
`;
}

export function workspaceFor(runId, epoch) {
  return path.join(DATA_DIR, "workspaces", `${runId}-e${epoch}`);
}

// Spawn a child under the seatbelt profile. Shared by the recipe runner and by
// tests that prove containment with disposable probe files. Absolute-path argv
// elements are canonicalized so the kernel-presented path matches the
// profile's canonical grants.
export function runFenced(argv, profilePath, { timeoutMs = RUNNER.maxWallSeconds * 1000 } = {}) {
  argv = argv.map((a) =>
    a.startsWith("/") && fs.existsSync(a) ? realpath(a) : a);
  return spawnSync(SANDBOX_EXEC, ["-f", profilePath, ...argv], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: timeoutMs,
    maxBuffer: RUNNER.maxStdoutBytes,
    encoding: "utf8",
  });
}

// Capability probe: can this host apply ANY seatbelt profile? Uses the
// minimal baseline the OS ships for (/usr/bin/true). A failure here means the
// environment genuinely cannot sandbox (e.g. nested inside another sandbox).
export function capabilityProbe(dir) {
  if (!fs.existsSync(SANDBOX_EXEC))
    return { ok: false, detail: "sandbox-exec not present" };
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, "capability.sb");
  fs.writeFileSync(probe, `(version 1)\n(deny default)\n(allow process-exec)\n` +
    `(allow file-read* (literal "/"))\n` +
    `(allow file-read* (subpath "/usr/bin"))\n` +
    `(allow file-read* (subpath "/usr/lib"))\n` +
    `(allow file-read* (subpath "/System/Library"))\n`);
  const r = spawnSync(SANDBOX_EXEC,
    ["-f", probe, "/usr/bin/true"], { encoding: "utf8" });
  if (r.error) return { ok: false, detail: String(r.error) };
  if (r.signal) return { ok: false, detail: `capability probe killed by ${r.signal}` };
  if (r.status !== 0)
    return { ok: false, detail: `capability probe exit ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}` };
  return { ok: true, detail: "seatbelt available" };
}

// Policy probe: does OUR exact production profile let the JS runtime boot?
// Failure here is a policy/launch defect — never classified as an
// unsupported environment.
export function policyProbe(profilePath) {
  const r = spawnSync(SANDBOX_EXEC,
    ["-f", profilePath, realpath(process.execPath), "-e", "0"], { encoding: "utf8" });
  if (r.error) return { ok: false, detail: String(r.error) };
  if (r.signal)
    return { ok: false, detail: `node killed by ${r.signal} under the run profile ` +
      `(profile blocks a required bootstrap load — defect, not environment)` };
  if (r.status !== 0)
    return { ok: false, detail: `policy probe exit ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}` };
  return { ok: true, detail: "profile admitted node bootstrap" };
}

export class SandboxUnavailable extends HttpError {
  constructor(detail) {
    super(503, "SANDBOX_UNAVAILABLE",
      "isolated execution cannot be established on this host: " + detail +
      ". Set RERUNDESK_UNSAFE_RUNNER=1 to run unsandboxed (recorded honestly).");
    this.detail_code = "sandbox_apply_failed";
  }
}

export class SandboxPolicyFailed extends HttpError {
  constructor(detail) {
    super(500, "SANDBOX_POLICY_FAILED",
      "the seatbelt profile is too restrictive or invalid for the runtime: " + detail);
    this.detail_code = "policy_defect";
  }
}

// Executes the pinned recipe for a run's active lease epoch. Returns the
// workspace paths of produced artifacts for the worker to upload.
export function executeRun(db, run, lease, { seed } = {}) {
  const recipe = getRecipe(db, run.recipe_id);
  const claim = getClaim(db, run.claim_id);
  const entry = COMMAND_CATALOG[recipe.manifest.entrypoint];
  const useSeed = seed ?? claim.seed_list[0];

  const ws = workspaceFor(run.id, lease.epoch);
  fs.rmSync(ws, { recursive: true, force: true });
  const inputsDir = path.join(ws, "inputs");
  const outputsDir = path.join(ws, "outputs");
  const logsDir = path.join(ws, "logs");
  fs.mkdirSync(inputsDir, { recursive: true });
  fs.mkdirSync(outputsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  // Mount known inputs read-only.
  const dataset = getDataset(db, claim.terms.data_hash);
  const datasetBuf = readObject(db, dataset.dataset_sha256);
  const dsPath = path.join(inputsDir, "dataset.json");
  fs.writeFileSync(dsPath, datasetBuf);
  fs.chmodSync(dsPath, 0o444);

  const logPath = path.join(logsDir, "run.log");
  const startedAt = new Date().toISOString();

  const profilePath = path.join(ws, "sandbox.sb");
  let containment;
  if (process.env.RERUNDESK_UNSAFE_RUNNER === "1") {
    containment = "unsandboxed:operator-override";
  } else {
    const scope = {
      workspace: ws, inputsDir,
      recipeDir: path.dirname(entry.script),
      nodeRoot: nodeInstallRoot(),
    };
    const capability = capabilityProbe(ws);
    if (!capability.ok) throw new SandboxUnavailable(capability.detail);
    fs.writeFileSync(profilePath, sandboxProfile(scope));
    const policy = policyProbe(profilePath);
    if (!policy.ok) throw new SandboxPolicyFailed(policy.detail);
    containment = "sandbox-exec:no-network";
  }

  const argv = [realpath(entry.script),
    "--dataset", realpath(dsPath), "--seed", String(useSeed),
    "--out", realpath(outputsDir),
    "--log", path.join(realpath(logsDir), path.basename(logPath))];
  const result = containment === "sandbox-exec:no-network"
    ? runFenced([realpath(process.execPath), ...argv], profilePath)
    : spawnSync(process.execPath, argv, {
        env: { PATH: "/usr/bin:/bin", HOME: ws },
        timeout: RUNNER.maxWallSeconds * 1000,
        maxBuffer: RUNNER.maxStdoutBytes,
        encoding: "utf8",
      });

  const finishedAt = new Date().toISOString();
  const tail = (result.stdout || "") + (result.stderr || "");
  fs.appendFileSync(logPath,
    `[runner] containment=${containment} exit=${result.status} signal=${result.signal ?? "none"}\n` +
    tail.slice(0, 64 * 1024));

  // Runtime metadata is written by the platform (not the recipe) so seed,
  // hardware and image provenance cannot be fabricated by the workload.
  const runtime = {
    format: "rerundesk.runtime.v1",
    run_id: run.id,
    epoch: lease.epoch,
    seed: useSeed,
    hardware_class: claim.hardware_class,
    image_digest: recipe.manifest.image_digest,
    recipe_digest: crypto.createHash("sha256")
      .update(fs.readFileSync(entry.script)).digest("hex"),
    metric: claim.terms.metric,
    containment,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_status: result.status,
  };
  fs.writeFileSync(path.join(ws, "runtime.json"), JSON.stringify(runtime, null, 2));
  fs.chmodSync(path.join(ws, "runtime.json"), 0o444);

  return {
    workspace: ws,
    exitStatus: result.status,
    containment,
    artifacts: [
      { path: "outputs/predictions.csv", file: path.join(outputsDir, "predictions.csv") },
      { path: "runtime.json", file: path.join(ws, "runtime.json") },
      { path: "logs/run.log", file: logPath },
    ].filter((a) => fs.existsSync(a.file)),
  };
}
