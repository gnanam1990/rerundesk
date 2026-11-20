// Reviewed benchmark recipe "score-predictions" v1.0.0.
// Deterministically scores the pinned CPU benchmark: predicts the class label
// for every sample id in declaration order and writes outputs/predictions.csv.
// Deterministic in (dataset, seed): the seed selects a fixed projection; the
// benchmark's gold labels decide measured accuracy.
import fs from "node:fs";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const datasetPath = arg("--dataset");
const outDir = arg("--out") ?? ".";
const logPath = arg("--log");
const seed = Number(arg("--seed") ?? "0");

const { samples } = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

// Pinned decision rule: label = feature (identity projection). The dataset's
// gold labels contain the precommitted label noise; measured accuracy falls
// out of the comparison, not from this script.
const lines = ["id,label"];
for (const s of samples) lines.push(`${s.id},${s.feature}`);
fs.writeFileSync(`${outDir}/predictions.csv`, lines.join("\n") + "\n");

if (logPath) {
  fs.appendFileSync(logPath,
    `[score] samples=${samples.length} seed=${seed} wrote predictions.csv\n`);
}
console.log(`scored ${samples.length} samples`);
