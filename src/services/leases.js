// M04 — Worker-scoped fenced leases. Only the active lease may deliver the
// authoritative result (INV-04). Lease expiry is recoverable: a new epoch may
// be issued while budget and contract allow; superseded evidence cannot
// replace an accepted attempt.
import crypto from "node:crypto";
import { now, txn } from "../db.js";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { DEFAULT_LEASE_TTL_SECONDS } from "../catalog.js";
import { getRun, setRunState, recordEvent } from "./runs.js";

export function activeLease(db, runId) {
  return db.prepare(
    "SELECT * FROM leases WHERE run_id = ? AND status = 'active'"
  ).get(runId);
}

// Lazily expire leases whose deadline has passed. Called on every access path.
export function reapLease(db, runId, nowIso = now()) {
  const lease = activeLease(db, runId);
  if (lease && lease.expires_at <= nowIso) {
    txn(db, () => {
      db.prepare("UPDATE leases SET status = 'expired' WHERE id = ?").run(lease.id);
      const run = getRun(db, runId);
      if (!["evaluated", "cancelled"].includes(run.state))
        setRunState(db, runId, "lease_expired");
      recordEvent(db, runId, null, "lease.expired", { epoch: lease.epoch });
    });
    return null;
  }
  return lease;
}

export function issueLease(db, actor, runId, body = {}, nowIso = now()) {
  const run = getRun(db, runId);
  if (run.worker_org_id !== actor.org_id)
    throw forbidden("lease may only be issued to the contracted worker org",
      "LEASE_ORG_MISMATCH");
  if (!["authorized", "leased", "running", "lease_expired"].includes(run.state))
    throw conflict("RUN_STATE", `run state '${run.state}' cannot accept a lease`);

  reapLease(db, runId, nowIso);
  if (activeLease(db, runId))
    throw conflict("LEASE_ACTIVE", "an active lease already exists for this run");
  if (db.prepare("SELECT run_id FROM manifests WHERE run_id = ?").get(runId))
    throw conflict("MANIFEST_SEALED", "an accepted manifest already exists for this run");

  const ttl = Number.isInteger(body?.ttl_seconds) && body.ttl_seconds > 0
    ? Math.min(body.ttl_seconds, 3600)
    : DEFAULT_LEASE_TTL_SECONDS;
  const prior = db.prepare(
    "SELECT COALESCE(MAX(epoch),0) e FROM leases WHERE run_id = ?"
  ).get(runId).e;
  const epoch = prior + 1;
  const leaseId = "lea_" + crypto.randomBytes(8).toString("hex");
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.parse(nowIso) + ttl * 1000).toISOString();

  txn(db, () => {
    db.prepare(
      `INSERT INTO leases(id, run_id, epoch, worker_org_id, token, issued_at,
         expires_at, heartbeat_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active')`
    ).run(leaseId, runId, epoch, actor.org_id, token, nowIso, expiresAt);
    const attempt = Math.max(run.attempt, epoch);
    db.prepare("UPDATE runs SET attempt = ?, state = 'leased', updated_at = ? WHERE id = ?")
      .run(attempt, nowIso, runId);
    recordEvent(db, runId, actor, "lease.issued", { epoch, expires_at: expiresAt });
  });
  return db.prepare("SELECT * FROM leases WHERE id = ?").get(leaseId);
}

export function heartbeat(db, actor, runId, token, nowIso = now()) {
  const lease = validateLeaseToken(db, actor, runId, token, nowIso);
  db.prepare("UPDATE leases SET heartbeat_at = ? WHERE id = ?").run(nowIso, lease.id);
  const run = getRun(db, runId);
  if (run.state === "leased") setRunState(db, runId, "running");
  recordEvent(db, runId, actor, "lease.heartbeat", { epoch: lease.epoch });
  return db.prepare("SELECT * FROM leases WHERE id = ?").get(lease.id);
}

export function validateLeaseToken(db, actor, runId, token, nowIso = now()) {
  const lease = reapLease(db, runId, nowIso);
  if (!lease)
    throw conflict("LEASE_EXPIRED",
      "no active lease; an expired lease cannot deliver results");
  if (lease.token !== token)
    throw forbidden("lease token mismatch", "LEASE_TOKEN_INVALID");
  if (actor && lease.worker_org_id !== actor.org_id)
    throw forbidden("lease belongs to a different worker org", "LEASE_ORG_MISMATCH");
  return lease;
}
