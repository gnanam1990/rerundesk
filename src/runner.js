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
export function sandboxProfile({ workspace, inputsDir, recipeDir, nodeRoot }) {
  const rw = realpath(workspace);
  const dyldDirs = ["/private/var/db/dyld", "/var/db/dyld"]
    .filter((d) => fs.existsSync(d))
    .map((d) => `  (subpath "${d}")`).join("\n");
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
; immutable mounted inputs, startup character devices
(allow file-read* file-read-metadata
  (subpath "${realpath(nodeRoot)}")
  (subpath "/System/Library")
  (subpath "/usr/lib")
${dyldDirs}
  (subpath "${realpath(recipeDir)}")
  (subpath "${realpath(inputsDir)}")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (literal "/dev/zero")
  (literal "/dev/random"))

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
// tests that prove containment with disposable probe files.
export function runFenced(argv, profilePath, { timeoutMs = RUNNER.maxWallSeconds * 1000 } = {}) {
  return spawnSync(SANDBOX_EXEC, ["-f", profilePath, ...argv], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: timeoutMs,
    maxBuffer: RUNNER.maxStdoutBytes,
    encoding: "utf8",
  });
}

// Can this host apply a seatbelt profile? When a profilePath is given the
// probe uses that exact profile, so a compile error or over-tight scope is
// caught before the real run. Otherwise a minimal probe is generated.
// Returns {ok, detail}.
export function preflightSandbox(dir, profilePath) {
  if (!fs.existsSync(SANDBOX_EXEC))
    return { ok: false, detail: "sandbox-exec not present" };
  fs.mkdirSync(dir, { recursive: true });
  const probe = profilePath ?? path.join(dir, "preflight.sb");
  if (!profilePath)
    fs.writeFileSync(probe, `(version 1)\n(deny default)\n` +
      `(allow process-exec)\n(allow file-read* (subpath "${nodeInstallRoot()}"))\n` +
      `(allow file-read* (subpath "/System/Library"))\n(allow file-read* (subpath "/usr/lib"))\n` +
      `(allow mach-lookup)\n(allow sysctl-read)\n`);
  const r = spawnSync(SANDBOX_EXEC,
    ["-f", probe, process.execPath, "-e", "0"], { encoding: "utf8" });
  if (r.error) return { ok: false, detail: String(r.error) };
  if (r.status !== 0)
    return { ok: false, detail: `sandbox_apply probe exit ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}` };
  return { ok: true, detail: "seatbelt profile applied" };
}

export class SandboxUnavailable extends HttpError {
  constructor(detail) {
    super(503, "SANDBOX_UNAVAILABLE",
      "isolated execution cannot be established on this host: " + detail +
      ". Set RERUNDESK_UNSAFE_RUNNER=1 to run unsandboxed (recorded honestly).");
    this.detail_code = "sandbox_apply_failed";
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
    fs.writeFileSync(profilePath, sandboxProfile(scope));
    const support = preflightSandbox(path.dirname(profilePath), profilePath);
    if (!support.ok) throw new SandboxUnavailable(support.detail);
    containment = "sandbox-exec:no-network";
  }

  const argv = [entry.script,
    "--dataset", dsPath, "--seed", String(useSeed),
    "--out", outputsDir, "--log", logPath];
  const result = containment === "sandbox-exec:no-network"
    ? runFenced([process.execPath, ...argv], profilePath)
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
