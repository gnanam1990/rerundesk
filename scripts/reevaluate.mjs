// Independent re-verification: recompute a run's verdict from the sealed
// bundle on the pinned evaluator and print whether it matches the recorded
// evaluation. Usage: node scripts/reevaluate.mjs --run <run_id>
// Env: RERUNDESK_DATA (default ./data)
import { openDb } from "../src/db.js";
import { evaluateRun } from "../src/services/evaluate.js";

const i = process.argv.indexOf("--run");
const runId = i >= 0 ? process.argv[i + 1] : undefined;
if (!runId) {
  console.error("usage: node scripts/reevaluate.mjs --run <run_id>");
  process.exit(2);
}
const db = openDb();
const prior = db.prepare("SELECT * FROM evaluations WHERE run_id = ?").get(runId);
const again = evaluateRun(db, { org_id: "reevaluate-script", role: "evaluator" }, runId);
console.log(JSON.stringify({
  run_id: runId,
  recorded: prior && { outcome: prior.outcome, observed_decimal: prior.observed_decimal },
  recomputed: { outcome: again.outcome, observed_decimal: again.observed_decimal },
  match: !!prior && prior.outcome === again.outcome &&
    prior.observed_decimal === again.observed_decimal,
}, null, 2));
