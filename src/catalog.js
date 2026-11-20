// Reviewed, fixed command catalog and license allowlist. Only entrypoints and
// licenses listed here may appear in an admitted recipe (FR-01).
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LICENSE_ALLOWLIST = [
  "CC0-1.0",
  "CC-BY-4.0",
  "MIT",
  "Apache-2.0",
  "ODbL-1.0",
];

export const HARDWARE_CLASSES = ["cpu-small", "cpu-medium"];

export const COMMAND_CATALOG = {
  "score-predictions": {
    version: "1.0.0",
    kind: "node-script",
    script: path.join(ROOT, "benchmark", "recipes", "score.mjs"),
    requiredInputs: ["dataset.json"],
    producedArtifacts: ["outputs/predictions.csv", "runtime.json", "logs/run.log"],
  },
};

// Bundle limits (M05).
export const LIMITS = {
  maxArtifactBytes: 5 * 1024 * 1024,
  maxLogBytes: 1024 * 1024,
  maxManifestFiles: 64,
  maxBundleBytes: 16 * 1024 * 1024,
};

export const METRICS = ["accuracy"];
export const AGGREGATIONS = ["mean", "median", "min"];
export const DEFAULT_LEASE_TTL_SECONDS = 300;
export const RUNNER = {
  maxWallSeconds: 30,
  maxStdoutBytes: 256 * 1024,
};
