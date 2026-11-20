// M04 — Local fenced execution adapter. The recipe entrypoint runs as a child
// process under macOS sandbox-exec with network egress denied, inputs mounted
// read-only, a scrubbed environment, bounded wall time and bounded output.
// If sandbox-exec is unavailable the run is refused unless RERUNDESK_UNSAFE_RUNNER=1,
// and the runtime metadata records the actual containment used.
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

function sandboxProfile(workspace) {
  return `(version 1)
(deny default)
(allow process-exec process-fork)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)
(allow file-write* (subpath "${workspace}"))
(deny network*)
`;
}

export function workspaceFor(runId, epoch) {
  return path.join(DATA_DIR, "workspaces", `${runId}-e${epoch}`);
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

  const useSandbox = fs.existsSync("/usr/bin/sandbox-exec") &&
    process.env.RERUNDESK_UNSAFE_RUNNER !== "1";
  let result;
  if (useSandbox) {
    const profilePath = path.join(ws, "sandbox.sb");
    fs.writeFileSync(profilePath, sandboxProfile(ws));
    result = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-f", profilePath, process.execPath, entry.script,
       "--dataset", dsPath, "--seed", String(useSeed),
       "--out", outputsDir, "--log", logPath],
      { env: { PATH: "/usr/bin:/bin", HOME: ws }, timeout: RUNNER.maxWallSeconds * 1000,
        maxBuffer: RUNNER.maxStdoutBytes, encoding: "utf8" });
  } else if (process.env.RERUNDESK_UNSAFE_RUNNER === "1") {
    result = spawnSync(
      process.execPath,
      [entry.script, "--dataset", dsPath, "--seed", String(useSeed),
       "--out", outputsDir, "--log", logPath],
      { env: { PATH: "/usr/bin:/bin", HOME: ws }, timeout: RUNNER.maxWallSeconds * 1000,
        maxBuffer: RUNNER.maxStdoutBytes, encoding: "utf8" });
  } else {
    throw new Error("sandbox-exec unavailable and RERUNDESK_UNSAFE_RUNNER is not set");
  }

  const finishedAt = new Date().toISOString();
  const tail = (result.stdout || "") + (result.stderr || "");
  fs.appendFileSync(logPath,
    `[runner] exit=${result.status} signal=${result.signal ?? "none"}\n` +
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
    containment: useSandbox ? "sandbox-exec:no-network" : "unsandboxed",
    started_at: startedAt,
    finished_at: finishedAt,
    exit_status: result.status,
  };
  fs.writeFileSync(path.join(ws, "runtime.json"), JSON.stringify(runtime, null, 2));
  fs.chmodSync(path.join(ws, "runtime.json"), 0o444);

  return {
    workspace: ws,
    exitStatus: result.status,
    artifacts: [
      { path: "outputs/predictions.csv", file: path.join(outputsDir, "predictions.csv") },
      { path: "runtime.json", file: path.join(ws, "runtime.json") },
      { path: "logs/run.log", file: logPath },
    ].filter((a) => fs.existsSync(a.file)),
  };
}
