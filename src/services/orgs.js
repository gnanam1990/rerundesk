// Organization enrollment (M03 half): identity evidence and independence status.
import crypto from "node:crypto";
import { now } from "../db.js";
import { badRequest, notFound } from "../errors.js";

const INDEPENDENCE = new Set(["enrolled", "attested", "unknown"]);

export function enrollOrg(db, actor, body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const kind = body?.kind;
  if (!name) throw badRequest("ORG_NAME_REQUIRED", "organization name required");
  if (!["sponsor", "worker", "both"].includes(kind))
    throw badRequest("ORG_KIND_INVALID", "kind must be sponsor|worker|both");
  const evidence = body?.evidence && typeof body.evidence === "object" ? body.evidence : {};
  // Independence is only as strong as recorded proof. An attestation reference
  // upgrades 'enrolled' to 'attested'; absence stays 'unknown' unless enrolled
  // evidence (operator domain/contact) is present.
  let independence = "unknown";
  if (evidence.attestation_ref) independence = "attested";
  else if (evidence.operator_domain || evidence.contact) independence = "enrolled";
  if (body?.independence_status && INDEPENDENCE.has(body.independence_status)) {
    // Never allow upgrading beyond what evidence supports.
    const rank = { unknown: 0, enrolled: 1, attested: 2 };
    independence = rank[body.independence_status] <= rank[independence]
      ? body.independence_status
      : independence;
  }
  const id = "org_" + crypto.randomBytes(8).toString("hex");
  db.prepare(
    `INSERT INTO orgs(id, name, kind, evidence_json, independence_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, name, kind, JSON.stringify(evidence), independence, now());
  return getOrg(db, id);
}

export function getOrg(db, id) {
  const o = db.prepare("SELECT * FROM orgs WHERE id = ?").get(id);
  if (!o) throw notFound("organization not found");
  return { ...o, evidence: JSON.parse(o.evidence_json) };
}

export function listOrgs(db) {
  return db
    .prepare("SELECT id, name, kind, independence_status, created_at FROM orgs ORDER BY created_at")
    .all();
}
