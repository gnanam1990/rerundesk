// M03 — Run reservation: binds claim, eligible offer, sponsor and worker orgs,
// max spend, and a durable idempotency key. Payment state is tracked in the
// ledger and is deliberately separate from comparison outcome (INV-07).
import crypto from "node:crypto";
import { now, txn } from "../db.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { sha256hex, canonicalize } from "../canonical.js";
import { getClaim } from "./claims.js";
import { getOffer, offerEligible } from "./offers.js";
import { getOrg } from "./orgs.js";
import * as ledger from "./ledger.js";

export function recordEvent(db, runId, actor, action, detail = {}) {
  db.prepare(
    "INSERT INTO events(run_id, actor, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(runId, actor ? `${actor.org_id}:${actor.role}` : "system", action,
        JSON.stringify(detail), now());
}

export function reserveRun(db, actor, body, idemKey, nowIso = now()) {
  if (!idemKey) throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header required");
  const claim = getClaim(db, body?.claim_id);
  const offer = getOffer(db, body?.offer_id);
  const maxSpend = body?.max_spend_minor;
  if (!Number.isInteger(maxSpend) || maxSpend < 0)
    throw badRequest("MAX_SPEND_INVALID", "max_spend_minor must be a non-negative integer");
  if (claim.sponsor_org_id !== actor.org_id)
    throw forbidden("claim belongs to a different sponsor organization", "CLAIM_NOT_OWNED");

  const payloadHash = sha256hex(canonicalize({
    claim_id: body.claim_id, offer_id: body.offer_id, max_spend_minor: maxSpend,
  }));
  const prior = db.prepare(
    "SELECT * FROM idempotency WHERE key = ? AND org_id = ?"
  ).get(idemKey, actor.org_id);
  if (prior) {
    if (prior.payload_hash !== payloadHash)
      throw conflict("IDEMPOTENCY_CONFLICT",
        "this idempotency key was used with a different payload");
    return { run: getRun(db, prior.operation_ref), created: false, replayed: true };
  }

  // Eligibility gates (T-006).
  if (!offerEligible(offer, nowIso))
    throw unprocessable("OFFER_NOT_ELIGIBLE", "offer is expired or no longer open");
  if (offer.worker_org_id === actor.org_id || offer.worker_org_id === claim.sponsor_org_id)
    throw unprocessable("WORKER_NOT_INDEPENDENT",
      "a worker from the sponsor organization cannot run an independent rerun");
  if (offer.price_minor > maxSpend)
    throw unprocessable("SPEND_CAP_EXCEEDED",
      `offer price ${offer.price_minor} exceeds max_spend_minor ${maxSpend}`);

  const runId = "run_" + crypto.randomBytes(8).toString("hex");
  const run = txn(db, () => {
    db.prepare(
      `INSERT INTO runs(id, claim_id, recipe_id, offer_id, sponsor_org_id,
         worker_org_id, attempt, state, max_spend_minor, currency,
         client_request_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'authorized', ?, ?, ?, ?, ?)`
    ).run(runId, claim.id, claim.recipe_hash, offer.id, actor.org_id,
          offer.worker_org_id, maxSpend, offer.currency, idemKey, nowIso, nowIso);
    db.prepare("UPDATE offers SET status = 'reserved' WHERE id = ?").run(offer.id);
    const res = ledger.reserve(db, runId, offer.price_minor, offer.currency,
      `reservation for offer ${offer.id}`);
    db.prepare(
      `INSERT INTO idempotency(key, org_id, payload_hash, operation_ref,
         response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(idemKey, actor.org_id, payloadHash, runId,
          JSON.stringify({ run_id: runId }), nowIso);
    recordEvent(db, runId, actor, "run.authorized", {
      claim_id: claim.id, offer_id: offer.id,
      merchant_order_id: res.merchant_order_id, provider: res.provider,
    });
    return getRun(db, runId);
  });
  return { run, created: true };
}

export function getRun(db, id) {
  const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
  if (!r) throw notFound("run not found");
  return r;
}

export function setRunState(db, runId, state, outcome = undefined) {
  if (outcome === undefined)
    db.prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, now(), runId);
  else
    db.prepare("UPDATE runs SET state = ?, outcome = ?, updated_at = ? WHERE id = ?")
      .run(state, outcome, now(), runId);
}

export function assertRunAccess(db, runId, actor) {
  const run = getRun(db, runId);
  const involved = [run.sponsor_org_id, run.worker_org_id];
  if (actor.role === "maintainer" || actor.role === "evaluator") return run;
  if (!involved.includes(actor.org_id))
    throw forbidden("run is not visible to this organization", "RUN_NOT_VISIBLE");
  return run;
}

export function listRuns(db, actor) {
  const all = db.prepare("SELECT * FROM runs ORDER BY created_at").all();
  if (actor.role === "maintainer" || actor.role === "evaluator") return all;
  return all.filter((r) => r.sponsor_org_id === actor.org_id || r.worker_org_id === actor.org_id);
}
