// M07 — Report, settlement and repeatability. Timeline, outcome explanation,
// independence evidence, exact reproduction manifest and a separate cost
// history. Settlement reporting is strictly derived from ledger records —
// unconfirmed payment can never present as settled (T-014).
import { getRun } from "./runs.js";
import { getClaim } from "./claims.js";
import { getRecipe } from "./recipes.js";
import { getOrg } from "./orgs.js";
import { getDataset } from "./datasets.js";
import { sealedManifest, listArtifacts } from "./artifacts.js";
import { getEvaluation } from "./evaluate.js";
import { settlementFor, costHistory } from "./ledger.js";
import { getOffer } from "./offers.js";
import { notFound } from "../errors.js";

function timeline(db, runId) {
  return db.prepare(
    "SELECT actor, action, detail_json, created_at FROM events WHERE run_id = ? ORDER BY id"
  ).all(runId).map((e) => ({ ...e, detail: JSON.parse(e.detail_json) }));
}

export function independenceEvidence(db, run) {
  const sponsor = getOrg(db, run.sponsor_org_id);
  const worker = getOrg(db, run.worker_org_id);
  const distinct = sponsor.id !== worker.id;
  return {
    sponsor_org: { id: sponsor.id, name: sponsor.name },
    worker_org: { id: worker.id, name: worker.name,
                  independence_status: worker.independence_status },
    independently_operated: distinct,
    independence_status: distinct ? worker.independence_status : "not_independent",
    how_checked:
      "Separate enrolled organization identities are required at reservation: " +
      "the run is rejected when the worker org equals the sponsor org. " +
      `Worker enrollment evidence status: '${worker.independence_status}' ` +
      "(enrolled = operator identity recorded; attested = attestation reference on file; " +
      "unknown = no evidence recorded).",
  };
}

export function buildReport(db, actor, run, { redacted = false } = {}) {
  const claim = getClaim(db, run.claim_id);
  const recipe = getRecipe(db, run.recipe_id);
  const dataset = getDataset(db, claim.terms.data_hash);
  const evaluation = getEvaluation(db, run.id);
  const sealed = sealedManifest(db, run.id);
  const offer = getOffer(db, run.offer_id);
  const settlement = settlementFor(db, run.id);
  const independence = independenceEvidence(db, run);

  const artifacts = sealed
    ? listArtifacts(db, run.id, sealed.epoch).map((a) => ({
        path: a.path, sha256: a.sha256, size: a.size }))
    : [];

  const report = {
    report_version: "rerundesk.report.v1",
    generated_at: new Date().toISOString(),
    run: {
      id: run.id, state: run.state, outcome: run.outcome, attempt: run.attempt,
      claim_id: run.claim_id, recipe_id: run.recipe_id,
      sponsor_org_id: run.sponsor_org_id, worker_org_id: run.worker_org_id,
      created_at: run.created_at, updated_at: run.updated_at,
    },
    claim: claim.terms,
    recipe: recipe.manifest,
    dataset: {
      id: dataset.id, name: dataset.name, license_ref: dataset.license_ref,
      sample_count: dataset.sample_count,
    },
    timeline: timeline(db, run.id),
    evaluation: evaluation && {
      outcome: evaluation.outcome,
      reason_code: evaluation.reason_code,
      explanation: evaluation.explanation,
      observed_decimal: evaluation.observed_decimal,
      observed_fraction: evaluation.observed_fraction,
      evaluator_version: evaluation.evaluator_version,
      evaluator_digest: evaluation.evaluator_digest,
      manifest_hash: evaluation.manifest_hash,
      evaluated_at: evaluation.evaluated_at,
    },
    independence,
    reproduction: sealed && {
      manifest_hash: sealed.manifest_hash,
      epoch: sealed.epoch,
      evaluator_version: claim.terms.evaluator_version,
      evaluator_digest: claim.terms.evaluator_digest,
      artifacts,
      steps: [
        `fetch claim ${run.claim_id} and verify its canonical hash`,
        `fetch recipe ${run.recipe_id} and verify its canonical hash`,
        `verify each artifact against manifest ${sealed.manifest_hash}`,
        `re-run evaluator '${claim.terms.evaluator_version}' ` +
          `(digest ${claim.terms.evaluator_digest.slice(0, 16)}...) on the sealed bundle`,
        "compare the recomputed measurement with the frozen reference and tolerance",
      ],
      reverify_command: `node scripts/reevaluate.mjs --run ${run.id}`,
    },
    cost_history: costHistory(db, run.id),
    settlement: {
      status: settlement.status,          // authorized|captured|unconfirmed|none
      provider: settlement.provider,
      merchant_order_id: settlement.merchant_order_id,
      local_only: true,
      note: settlement.note,
      amount_minor: offer.price_minor,
      currency: offer.currency,
      disclaimer:
        "Payment status is reported independently of the comparison verdict. " +
        "'captured' means the team-controlled local ledger confirmed capture; " +
        "it is not a verified external payment settlement.",
    },
  };

  if (!redacted) return report;

  // Viewer packet: redact worker evidence internals and any org contact data;
  // keep outcome, hashes and the independence assertion verifiable.
  delete report.reproduction.reverify_command;
  report.independence.worker_org = {
    id: report.independence.worker_org.id,
    independence_status: report.independence.worker_org.independence_status,
  };
  report.independence.sponsor_org = { id: report.independence.sponsor_org.id };
  return report;
}

export function getReportForActor(db, actor, runId) {
  const run = getRun(db, runId);
  const involved = [run.sponsor_org_id, run.worker_org_id];
  const privileged = ["maintainer", "evaluator"].includes(actor.role);
  if (!privileged && !involved.includes(actor.org_id) && actor.role !== "viewer")
    throw notFound("run not found");
  const redacted = actor.role === "viewer" ||
    (!privileged && !involved.includes(actor.org_id));
  return buildReport(db, actor, run, { redacted });
}
