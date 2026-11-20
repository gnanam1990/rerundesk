// Actor resolution and role checks.
//
// Actor/tenant authority is server-side: an actor is proven by a provisioned
// opaque credential (Bearer / x-rd-credential) or a session issued through
// authenticated login; the org and role are read from the stored credential or
// session record — never from client-supplied identity claims.
//
// The `x-rd-org`/`x-rd-role` identity-selection shortcut exists only for
// explicitly opted-in development fixtures: it is honored solely when
// RERUNDESK_DEV_AUTH=1 is set in the server environment. Without that flag the
// headers are ignored and the request is unauthenticated.
import crypto from "node:crypto";
import { unauthorized, forbidden, badRequest } from "./errors.js";
import { now } from "./db.js";

// Which roles an org kind may hold. Bound at provisioning time; a credential
// can never grant a role outside its org's kind.
export const KIND_ROLES = {
  sponsor: ["sponsor", "viewer"],
  worker: ["worker", "viewer"],
  both: ["maintainer", "evaluator", "sponsor", "worker", "viewer"],
};
export const PRIMARY_ROLE = { sponsor: "sponsor", worker: "worker", both: "maintainer" };

const CRED_PREFIX = "rdc_";
const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

// Provision a credential for (org, role). Role must be permitted by the org's
// kind. The plaintext token is returned once; only its hash is stored.
export function issueCredential(db, org, role, { label = null, issuedBy = null } = {}) {
  if (!KIND_ROLES[org.kind]?.includes(role))
    throw badRequest("ROLE_ORG_MISMATCH",
      `role '${role}' is not permitted for org kind '${org.kind}'`);
  const token = CRED_PREFIX + crypto.randomBytes(24).toString("hex");
  db.prepare(
    `INSERT INTO credentials(token_hash, org_id, role, label, issued_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(hashToken(token), org.id, role, label, issuedBy, now());
  return { token, org_id: org.id, role };
}

export function verifyCredential(db, token) {
  if (typeof token !== "string" || !token.startsWith(CRED_PREFIX)) return null;
  const row = db.prepare(
    "SELECT org_id, role FROM credentials WHERE token_hash = ?"
  ).get(hashToken(token));
  return row ? { org_id: row.org_id, role: row.role, via: "credential" } : null;
}

export function createSession(db, orgId, role) {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO sessions(token, org_id, role, created_at) VALUES (?, ?, ?, ?)"
  ).run(token, orgId, role, now());
  return token;
}

export function resolveActor(req, db) {
  // 1. Provisioned credential: Authorization: Bearer rdc_… or x-rd-credential.
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim()
    : req.headers["x-rd-credential"];
  if (token) {
    const actor = verifyCredential(db, token);
    if (!actor) throw unauthorized("invalid credential");
    return actor;
  }

  // 2. Console session cookie (issued via authenticated login).
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)rd_session=([a-f0-9]+)/);
  if (m) {
    const s = db
      .prepare("SELECT org_id, role FROM sessions WHERE token = ?")
      .get(m[1]);
    if (s) return { org_id: s.org_id, role: s.role, via: "session" };
  }

  // 3. Development-fixture identity shortcut — explicitly opted in only.
  const orgId = req.headers["x-rd-org"];
  const role = req.headers["x-rd-role"];
  if (orgId || role) {
    if (process.env.RERUNDESK_DEV_AUTH !== "1")
      throw unauthorized("identity headers are disabled; use a provisioned credential",
        "DEV_AUTH_DISABLED");
    if (!orgId || !role) throw unauthorized("dev auth requires x-rd-org and x-rd-role");
    const org = db.prepare("SELECT id FROM orgs WHERE id = ?").get(orgId);
    if (!org) throw unauthorized("unknown organization");
    return { org_id: orgId, role, via: "dev-header" };
  }

  throw unauthorized();
}

export function requireRole(actor, ...roles) {
  if (!roles.includes(actor.role)) {
    throw forbidden(`role '${actor.role}' cannot perform this action`, "ROLE_DENIED");
  }
}
