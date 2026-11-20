// Actor resolution and role checks. Local dev auth: `x-rd-org` + `x-rd-role`
// headers, or an opaque session cookie issued by the console login.
import crypto from "node:crypto";
import { unauthorized, forbidden } from "./errors.js";
import { now } from "./db.js";

export function createSession(db, orgId, role) {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO sessions(token, org_id, role, created_at) VALUES (?, ?, ?, ?)"
  ).run(token, orgId, role, now());
  return token;
}

export function resolveActor(req, db) {
  const orgId = req.headers["x-rd-org"];
  const role = req.headers["x-rd-role"];
  if (orgId && role) {
    const org = db.prepare("SELECT id FROM orgs WHERE id = ?").get(orgId);
    if (!org) throw unauthorized("unknown organization");
    return { org_id: orgId, role, via: "header" };
  }
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)rd_session=([a-f0-9]+)/);
  if (m) {
    const s = db
      .prepare("SELECT org_id, role FROM sessions WHERE token = ?")
      .get(m[1]);
    if (s) return { org_id: s.org_id, role: s.role, via: "session" };
  }
  throw unauthorized();
}

export function requireRole(actor, ...roles) {
  if (!roles.includes(actor.role)) {
    throw forbidden(`role '${actor.role}' cannot perform this action`, "ROLE_DENIED");
  }
}
